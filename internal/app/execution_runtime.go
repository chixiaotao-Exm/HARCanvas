package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

type executionRuntime struct {
	runner        *Runner
	resources     *runResources
	hooks         executionHooks
	result        RunResult
	stepCount     int
	responseBytes int
	resultBytes   int
}
type scopeResult struct {
	status    string
	output    any
	variables map[string]any
	breakLoop bool
}

var errBreakScope = errors.New("break enclosing repeat scope")

func copyValues(values map[string]any) map[string]any {
	copy := map[string]any{}
	for k, v := range values {
		copy[k] = v
	}
	return copy
}
func (r *Runner) executeFlow(ctx context.Context, flow Flow, g *graph, hooks executionHooks) RunResult {
	runtime := &executionRuntime{runner: r, resources: newRunResources(r, flow), hooks: hooks, result: RunResult{Status: "success", Steps: []Step{}, Variables: map[string]any{}}}
	defer runtime.resources.close()
	for k, v := range flow.Inputs {
		runtime.result.Variables[k] = v
	}
	scope := runtime.executeScope(ctx, flow, g, runtime.result.Variables, map[string]any{}, nil, 0, ResourceDefaults{}, "")
	runtime.result.Status = scope.status
	runtime.result.Output = scope.output
	runtime.result.Variables = scope.variables
	return runtime.result
}
func (rt *executionRuntime) emit(step Step, status, code, message string) {
	if rt.hooks.Event != nil {
		rt.hooks.Event(FlowEvent{NodeID: step.NodeID, ResourceID: step.ResourceID, ExecutionID: step.ExecutionID, ScopePath: append([]string(nil), step.ScopePath...), Iteration: step.Iteration, Status: status, Time: time.Now().UTC(), DurationMS: step.DurationMS, ErrorCode: code, Message: message})
	}
}
func (rt *executionRuntime) append(step Step) {
	rt.result.Steps = append(rt.result.Steps, step)
	if rt.hooks.Step != nil {
		rt.hooks.Step(step)
	}
	message := step.Error
	if step.Status == "error" && step.ErrorCode == "execution_failed" {
		message = "步骤执行失败，请打开结果详情查看原因。"
	}
	rt.emit(step, step.Status, step.ErrorCode, message)
}
func executionKey(scope []string, id string) string {
	if len(scope) == 0 {
		return id
	}
	return strings.Join(scope, "/") + "/" + id
}

func (rt *executionRuntime) executeScope(ctx context.Context, flow Flow, g *graph, variables, outerResults map[string]any, scope []string, iteration int, defaults ResourceDefaults, sessionScope string) scopeResult {
	result := scopeResult{status: "success", variables: variables}
	results := copyValues(outerResults)
	active := map[string]bool{}
	branches := map[string]bool{}
	failed := false
	for _, id := range g.order {
		if g.reachable[id] {
			step := Step{NodeID: id, ExecutionID: executionKey(scope, id), ScopePath: append([]string(nil), scope...), Iteration: iteration}
			rt.emit(step, "pending", "", "")
		}
	}
	for _, id := range g.order {
		if !g.reachable[id] {
			continue
		}
		node := g.nodes[id]
		step := Step{NodeID: id, ExecutionID: executionKey(scope, id), ScopePath: append([]string(nil), scope...), Iteration: iteration, Label: node.Data.Label, Kind: node.Data.Kind, Status: "success"}
		rt.stepCount++
		if rt.stepCount > maxExecutionSteps {
			step.Status = "error"
			step.ErrorCode = "step_limit"
			step.Error = "本次运行超过 10000 个执行步骤，请减少重复次数或分批运行。"
			rt.append(step)
			result.status = "error"
			return result
		}
		if ctx.Err() != nil {
			step.Status = "cancelled"
			step.ErrorCode = "cancelled"
			step.Error = "运行已取消。"
			result.status = "cancelled"
			if !errors.Is(ctx.Err(), context.Canceled) {
				step.Status = "error"
				step.ErrorCode = "timeout"
				step.Error = "运行已超过时间限制。"
				result.status = "error"
			}
			failed = true
			rt.append(step)
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
		if failed || !shouldRun || result.breakLoop {
			step.Status = "skipped"
			step.Error = "条件未选择这条分支。"
			if failed {
				step.Error = "前面的步骤失败，后续步骤已跳过。"
			}
			if result.breakLoop {
				step.Error = "重复区域已提前结束。"
			}
			rt.append(step)
			continue
		}
		start := time.Now()
		rt.emit(step, "running", "", "")
		var value any
		var stepErr error
		if rt.stepCount > maxExecutionSteps {
			stepErr = &executionError{"step_limit", "本次运行超过 10000 个执行步骤，请减少重复次数或分批运行。"}
		} else {
			switch node.Data.Kind {
			case "input":
				input, exists := flow.Inputs[node.Data.Variable]
				if !exists {
					input, stepErr = renderTemplate(node.Data.Value, variables, results)
				}
				if stepErr == nil {
					variables[node.Data.Variable] = input
					value = input
				}
			case "manual":
				if rt.hooks.AwaitInput == nil {
					stepErr = &executionError{"manual_requires_job", "人工输入步骤需要通过运行任务执行。"}
				} else {
					value, stepErr = rt.hooks.AwaitInput(ctx, PendingInput{NodeID: id, ExecutionID: step.ExecutionID, ScopePath: step.ScopePath, Iteration: iteration, Variable: node.Data.Variable, Label: node.Data.Label, Prompt: node.Data.Description})
					if stepErr == nil {
						variables[node.Data.Variable] = value
					}
				}
			case "request":
				effective, err := rt.resources.config(node, defaults, sessionScope)
				stepErr = err
				if stepErr == nil {
					client, err := rt.resources.client(effective)
					stepErr = err
					if err == nil {
						data := node.Data
						if effective.Profile != nil {
							headers := map[string]string{}
							for k, v := range data.Headers {
								headers[k] = v
							}
							if effective.Profile.Locale != "" {
								deleteHeader(headers, "Accept-Language")
								headers["Accept-Language"] = effective.Profile.Locale
							}
							if effective.Profile.UserAgent != "" {
								deleteHeader(headers, "User-Agent")
								headers["User-Agent"] = effective.Profile.UserAgent
							}
							data.Headers = headers
						}
						var size int
						value, size, stepErr = rt.runner.executeRequest(ctx, client, data, variables, results)
						if effective.Proxy != nil {
							client.CloseIdleConnections()
							if stepErr != nil {
								step.ResourceID = effective.ProxyID
								var detail *executionError
								if !errors.As(stepErr, &detail) {
									stepErr = &executionError{"proxy_request_failed", "通过所选代理请求失败，请检查代理连接、认证和目标地址。"}
								}
							}
						}
						rt.responseBytes += size
						if rt.responseBytes > maxFlowResponses {
							stepErr = &executionError{"response_limit", "本次流程的响应总量超过 8 MiB，请减少循环次数。"}
						}
					}
				}
			case "browser", "browserVerification":
				effective, err := rt.resources.config(node, defaults, sessionScope)
				stepErr = err
				if stepErr == nil {
					if rt.runner.Browser == nil {
						stepErr = &executionError{"browser_executor_unavailable", "浏览器执行器尚未启用，请先配置浏览器服务。"}
					} else {
						await := func(ctx context.Context, pending PendingInput) (string, error) {
							if rt.hooks.AwaitInput == nil {
								return "", &executionError{"manual_requires_job", "浏览器接管需要通过运行任务执行。"}
							}
							pending.NodeID = id
							pending.ExecutionID = step.ExecutionID
							pending.ScopePath = step.ScopePath
							pending.Iteration = iteration
							return rt.hooks.AwaitInput(ctx, pending)
						}
						value, stepErr = rt.runner.Browser.Execute(ctx, node, effective, variables, results, await)
						if stepErr == nil && node.Data.Kind == "browser" && node.Data.BrowserAction == "read" && node.Data.Variable != "" {
							if output, ok := value.(map[string]any); ok {
								variables[node.Data.Variable] = output["text"]
							}
						}
						if stepErr == nil && node.Data.Kind == "browserVerification" {
							variables[node.Data.Variable] = value
						}
					}
				}
			case "extract":
				source, ok := results[node.Data.Source]
				if !ok {
					stepErr = &executionError{"source_not_run", "数据来源步骤尚未成功执行，请检查当前分支。"}
				} else {
					var found bool
					value, found = lookupPath(source, node.Data.Path)
					if !found {
						stepErr = &executionError{"path_not_found", "响应中没有找到选择的字段，请重新选择。"}
					} else {
						variables[node.Data.Variable] = value
					}
				}
			case "condition", "assertion":
				actual, found := resolveReference(node.Data.Variable, variables, results)
				expected, err := renderTemplate(node.Data.Expected, variables, results)
				stepErr = err
				if err == nil {
					matched := false
					if node.Data.Operator == "exists" {
						matched = found && actual != nil
					} else if !found {
						stepErr = &executionError{"missing_variable", "要检查的参数尚未产生，请检查当前分支。"}
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
						stepErr = &executionError{"assertion_failed", "结果检查未通过，业务条件没有满足。"}
					}
				}
			case "output":
				value, stepErr = renderTemplate(node.Data.Template, variables, results)
				if stepErr == nil {
					result.output = value
				}
			case "break":
				value = map[string]any{"break": true}
				result.breakLoop = true
			case "loop", "subflow":
				value, stepErr = rt.executeRegion(ctx, flow, node, variables, results, scope, defaults, sessionScope)
				if errors.Is(stepErr, errBreakScope) {
					result.breakLoop = true
					stepErr = nil
				}
			}
		}
		step.DurationMS = time.Since(start).Milliseconds()
		step.Result = value
		if value != nil {
			encoded, encodeErr := json.Marshal(value)
			if encodeErr != nil {
				stepErr = &executionError{"result_invalid", "这个步骤返回了无法保存的结果。"}
				step.Result = nil
			} else {
				rt.resultBytes += len(encoded)
				if rt.resultBytes > maxFlowResponses {
					stepErr = &executionError{"result_limit", "本次运行保留的结果超过 8 MiB，请减少重复次数或输出字段。"}
					step.Result = nil
				}
			}
		}
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
					result.status = "cancelled"
				} else {
					step.ErrorCode = "timeout"
					step.Error = "运行已超过时间限制。"
				}
			}
			if result.status != "cancelled" {
				result.status = "error"
			}
			failed = true
		} else {
			active[id] = true
			results[id] = value
		}
		rt.append(step)
	}
	return result
}
func deleteHeader(headers map[string]string, name string) {
	for key := range headers {
		if strings.EqualFold(key, name) {
			delete(headers, key)
		}
	}
}

func (rt *executionRuntime) executeRegion(ctx context.Context, parent Flow, node FlowNode, variables, results map[string]any, scope []string, defaults ResourceDefaults, sessionScope string) (any, error) {
	loop := node.Data.Loop
	if loop == nil {
		return nil, &executionError{"loop_required", "重复区域没有步骤配置。"}
	}
	count := loop.Count
	items := []any{}
	if node.Data.Kind == "subflow" {
		count = 1
	} else if loop.Mode == "each" {
		var err error
		items, err = parseLoopItems(loop.Items, variables, results)
		if err != nil {
			return nil, err
		}
		count = len(items)
	}
	nestedDefaults := defaults
	if node.Data.SessionID != "" {
		nestedDefaults.SessionID = node.Data.SessionID
	}
	if node.Data.ProxyID != "" {
		nestedDefaults.ProxyID = node.Data.ProxyID
	}
	if node.Data.ProfileID != "" {
		nestedDefaults.ProfileID = node.Data.ProfileID
	}
	for _, b := range rt.resources.bindings {
		if b.TargetID != node.ID {
			continue
		}
		switch rt.resources.nodes[b.ResourceID].Data.Kind {
		case "proxy":
			if node.Data.ProxyID == "" {
				nestedDefaults.ProxyID = b.ResourceID
			}
		case "profile":
			if node.Data.ProfileID == "" {
				nestedDefaults.ProfileID = b.ResourceID
			}
		case "browserSession":
			if node.Data.SessionID == "" {
				nestedDefaults.SessionID = b.ResourceID
			}
		}
	}
	part := Flow{Nodes: loop.Nodes, Edges: loop.Edges, EntryID: loop.EntryID, Inputs: parent.Inputs}
	g, _ := inspectExecutableFlow(executableFlow(part))
	aggregate := []any{}
	itemName, indexName := loopVariables(loop)
	for i := 0; i < count; i++ {
		if err := ctx.Err(); err != nil {
			return map[string]any{"iterations": aggregate, "count": len(aggregate)}, err
		}
		if rt.stepCount >= maxExecutionSteps {
			return map[string]any{"iterations": aggregate, "count": len(aggregate)}, &executionError{"step_limit", "本次运行超过 10000 个执行步骤，请减少重复次数。"}
		}
		local := copyValues(variables)
		local[indexName] = i
		if loop.Mode == "each" {
			local[itemName] = items[i]
		}
		iterationScope := append(append([]string(nil), scope...), fmt.Sprintf("%s:%d", node.ID, i+1))
		iterationSession := sessionScope
		if loop.FreshSession {
			iterationSession = executionKey(iterationScope, "session")
		}
		child := func() scopeResult {
			if loop.FreshSession {
				defer rt.resources.closeScope(iterationSession)
			}
			return rt.executeScope(ctx, part, g, local, results, iterationScope, i+1, nestedDefaults, iterationSession)
		}()
		aggregate = append(aggregate, map[string]any{"iteration": i + 1, "status": child.status, "output": child.output})
		if rt.resultBytes > maxFlowResponses {
			return map[string]any{"iterations": aggregate, "count": len(aggregate)}, &executionError{"result_limit", "本次运行保留的结果超过 8 MiB，请减少重复次数或输出字段。"}
		}
		if rt.responseBytes > maxFlowResponses {
			return map[string]any{"iterations": aggregate, "count": len(aggregate)}, &executionError{"response_limit", "本次流程的响应总量超过 8 MiB，请减少循环次数。"}
		}
		if rt.stepCount >= maxExecutionSteps {
			return map[string]any{"iterations": aggregate, "count": len(aggregate)}, &executionError{"step_limit", "本次运行超过 10000 个执行步骤，请减少重复次数。"}
		}
		if child.status != "success" && !loop.ContinueOnError {
			return map[string]any{"iterations": aggregate, "count": len(aggregate)}, &executionError{"loop_iteration_failed", fmt.Sprintf("第 %d 轮执行失败，请查看该轮标红的步骤。", i+1)}
		}
		if child.status == "cancelled" {
			return map[string]any{"iterations": aggregate, "count": len(aggregate)}, context.Canceled
		}
		if child.breakLoop {
			if node.Data.Kind == "subflow" {
				return map[string]any{"iterations": aggregate, "count": len(aggregate)}, errBreakScope
			}
			break
		}
	}
	return map[string]any{"iterations": aggregate, "count": len(aggregate)}, nil
}
