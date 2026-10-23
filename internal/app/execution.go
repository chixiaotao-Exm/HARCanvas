package app

import (
	"context"
	"errors"
	"net/http"
	"net/http/cookiejar"
	"strings"
	"time"

	"golang.org/x/net/publicsuffix"
)

type FlowEvent struct {
	RunID      string    `json:"runId"`
	Seq        int64     `json:"seq"`
	NodeID     string    `json:"nodeId"`
	Status     string    `json:"status"`
	Time       time.Time `json:"time"`
	DurationMS int64     `json:"durationMs,omitempty"`
	ErrorCode  string    `json:"errorCode,omitempty"`
	Message    string    `json:"message,omitempty"`
}

type PendingInput struct {
	NodeID   string `json:"nodeId"`
	Variable string `json:"variable"`
	Label    string `json:"label"`
	Prompt   string `json:"prompt"`
}

type executionError struct{ Code, Message string }

func (e *executionError) Error() string { return e.Message }

type executionHooks struct {
	Event      func(FlowEvent)
	Step       func(Step)
	AwaitInput func(context.Context, PendingInput) (string, error)
}

func snapshotFlow(flow Flow) Flow {
	snapshot := flow
	snapshot.Nodes = make([]FlowNode, len(flow.Nodes))
	for i, node := range flow.Nodes {
		snapshot.Nodes[i] = node
		snapshot.Nodes[i].Position = append([]byte(nil), node.Position...)
		if node.Data.Headers != nil {
			snapshot.Nodes[i].Data.Headers = map[string]string{}
			for k, v := range node.Data.Headers {
				snapshot.Nodes[i].Data.Headers[k] = v
			}
		}
	}
	snapshot.Edges = append([]FlowEdge(nil), flow.Edges...)
	snapshot.Inputs = map[string]string{}
	for k, v := range flow.Inputs {
		snapshot.Inputs[k] = v
	}
	return snapshot
}

func (r *Runner) Run(ctx context.Context, flow Flow) (RunResult, error) {
	flow = snapshotFlow(flow)
	g, err := validateFlow(flow)
	if err != nil {
		return RunResult{Status: "error", Steps: []Step{}, Variables: map[string]any{}}, err
	}
	ctx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	return r.executeFlow(ctx, flow, g, executionHooks{}), nil
}

// Each execution owns its client copy, cookie jar, variables, and response map.
// A manual pause therefore resumes the exact same session and never reruns nodes.
func (r *Runner) executeFlow(ctx context.Context, flow Flow, g *graph, hooks executionHooks) RunResult {
	result := RunResult{Status: "success", Steps: []Step{}, Variables: map[string]any{}}
	client := *r.Client
	jar, _ := cookiejar.New(&cookiejar.Options{PublicSuffixList: publicsuffix.List})
	client.Jar = &trackingJar{CookieJar: jar}
	previousRedirect := client.CheckRedirect
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) >= 8 {
			return errors.New("too many redirects")
		}
		if err := r.Guard.CheckURL(req.Context(), req.URL); err != nil {
			return err
		}
		if previousRedirect != nil {
			return previousRedirect(req, via)
		}
		return nil
	}
	emit := func(id, status string, duration int64, code, message string) {
		if hooks.Event != nil {
			hooks.Event(FlowEvent{NodeID: id, Status: status, Time: time.Now().UTC(), DurationMS: duration, ErrorCode: code, Message: message})
		}
	}
	appendStep := func(step Step) {
		result.Steps = append(result.Steps, step)
		if hooks.Step != nil {
			hooks.Step(step)
		}
		message := step.Error
		if step.Status == "error" && step.ErrorCode == "execution_failed" {
			message = "步骤执行失败，请打开结果详情查看原因。"
		}
		emit(step.NodeID, step.Status, step.DurationMS, step.ErrorCode, message)
	}
	for _, id := range g.order {
		if g.reachable[id] {
			emit(id, "pending", 0, "", "")
		}
	}
	results := map[string]any{}
	active := map[string]bool{}
	branches := map[string]bool{}
	for name, value := range flow.Inputs {
		result.Variables[name] = value
	}
	usedResponseBytes := 0
	failed := false
	for _, id := range g.order {
		if !g.reachable[id] {
			continue
		}
		node := g.nodes[id]
		step := Step{NodeID: id, Label: node.Data.Label, Kind: node.Data.Kind, Status: "success"}
		if err := ctx.Err(); err != nil {
			if errors.Is(err, context.Canceled) {
				step.Status = "cancelled"
				step.ErrorCode = "cancelled"
				step.Error = "运行已取消。"
				result.Status = "cancelled"
			} else {
				if failed {
					step.Status = "skipped"
					step.Error = "运行超时，后续步骤已跳过。"
				} else {
					step.Status = "error"
					step.ErrorCode = "timeout"
					step.Error = "运行已超过时间限制。"
				}
				result.Status = "error"
			}
			failed = true
			appendStep(step)
			continue
		}
		shouldRun := id == g.entry
		for _, edge := range g.incoming[id] {
			if !active[edge.Source] {
				continue
			}
			if g.nodes[edge.Source].Data.Kind == "condition" && ((edge.SourceHandle == "true") != branches[edge.Source]) {
				continue
			}
			shouldRun = true
		}
		if failed || !shouldRun {
			step.Status = "skipped"
			if failed {
				step.Error = "前面的步骤失败，后续步骤已跳过。"
			} else {
				step.Error = "条件未选择这条分支。"
			}
			appendStep(step)
			continue
		}
		start := time.Now()
		emit(id, "running", 0, "", "")
		var value any
		var stepErr error
		switch node.Data.Kind {
		case "input":
			input, exists := flow.Inputs[node.Data.Variable]
			if !exists {
				input, stepErr = renderTemplate(node.Data.Value, result.Variables, results)
			}
			if stepErr == nil {
				result.Variables[node.Data.Variable] = input
				value = input
			}
		case "manual":
			if hooks.AwaitInput == nil {
				stepErr = &executionError{Code: "manual_requires_job", Message: "人工输入步骤需要通过运行任务执行。"}
			} else {
				input, err := hooks.AwaitInput(ctx, PendingInput{NodeID: id, Variable: node.Data.Variable, Label: node.Data.Label, Prompt: node.Data.Description})
				stepErr = err
				if err == nil {
					result.Variables[node.Data.Variable] = input
					value = input
				}
			}
		case "request":
			var size int
			value, size, stepErr = r.executeRequest(ctx, &client, node.Data, result.Variables, results)
			usedResponseBytes += size
			if usedResponseBytes > maxFlowResponses {
				stepErr = &executionError{Code: "response_limit", Message: "本次流程的响应总量超过 8 MiB。"}
			}
		case "extract":
			source, ok := results[node.Data.Source]
			if !ok {
				stepErr = &executionError{Code: "source_not_run", Message: "数据来源步骤尚未成功执行。"}
			} else {
				var found bool
				value, found = lookupPath(source, node.Data.Path)
				if !found {
					stepErr = &executionError{Code: "path_not_found", Message: "响应中没有找到选择的字段，请重新选择。"}
				} else {
					result.Variables[node.Data.Variable] = value
				}
			}
		case "condition", "assertion":
			actual, found := resolveReference(node.Data.Variable, result.Variables, results)
			var expected string
			expected, stepErr = renderTemplate(node.Data.Expected, result.Variables, results)
			if stepErr == nil {
				matched := false
				if node.Data.Operator == "exists" {
					matched = found && actual != nil
				} else if !found {
					stepErr = &executionError{Code: "missing_variable", Message: "要检查的参数尚未产生。"}
				} else {
					switch node.Data.Operator {
					case "eq":
						matched = stringValue(actual) == expected
					case "neq":
						matched = stringValue(actual) != expected
					case "contains":
						matched = strings.Contains(stringValue(actual), expected)
					}
				}
				branches[id] = matched
				value = map[string]any{"matched": matched}
				if node.Data.Kind == "assertion" && !matched && stepErr == nil {
					stepErr = &executionError{Code: "assertion_failed", Message: "结果检查未通过，业务条件没有满足。"}
				}
			}
		case "output":
			value, stepErr = renderTemplate(node.Data.Template, result.Variables, results)
			if stepErr == nil {
				result.Output = value
			}
		}
		step.DurationMS = time.Since(start).Milliseconds()
		step.Result = value
		if ctx.Err() != nil {
			stepErr = ctx.Err()
		}
		if stepErr != nil {
			step.Status = "error"
			step.Error = stepErr.Error()
			step.ErrorCode = "execution_failed"
			var detail *executionError
			if errors.As(stepErr, &detail) {
				step.ErrorCode = detail.Code
			}
			if ctx.Err() != nil {
				if errors.Is(ctx.Err(), context.Canceled) {
					step.Status = "cancelled"
					step.ErrorCode = "cancelled"
					step.Error = "运行已取消。"
					result.Status = "cancelled"
				} else {
					step.ErrorCode = "timeout"
					step.Error = "运行已超过时间限制。"
				}
			}
			if result.Status != "cancelled" {
				result.Status = "error"
			}
			failed = true
		} else {
			active[id] = true
			results[id] = value
		}
		appendStep(step)
	}
	return result
}
