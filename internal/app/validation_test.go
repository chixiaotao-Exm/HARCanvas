package app

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

func issueByCode(v FlowValidation, code string) (FlowIssue, bool) {
	for _, issue := range v.Issues {
		if issue.Code == code {
			return issue, true
		}
	}
	return FlowIssue{}, false
}

func TestPreflightExtractionIssuesAreStructuredAndLocalized(t *testing.T) {
	for _, test := range []struct {
		source, path, code, message string
		connected                   bool
	}{
		{"", "body.id", "source_required", "这个提取方块还没有选择数据来源。", true},
		{"deleted", "body.id", "source_deleted", "原来的来源步骤已删除，请重新选择。", true},
		{"req", "body.id", "source_not_upstream", "请把来源步骤连接到这个提取方块之前。", false},
		{"req", "", "path_required", "请选择要从响应中读取的字段。", true},
	} {
		t.Run(test.code, func(t *testing.T) {
			flow := Flow{Nodes: []FlowNode{block("req", BlockData{Kind: "request", URL: "https://8.8.8.8"}), block("extract", BlockData{Kind: "extract", Source: test.source, Path: test.path, Variable: "item"})}}
			if test.connected {
				flow.Edges = []FlowEdge{connect("req", "extract")}
			}
			v := ValidateFlow(flow)
			issue, ok := issueByCode(v, test.code)
			if !ok || v.Valid || issue.NodeID != "extract" || issue.Message != test.message || issue.Field == "" || issue.SuggestedAction == "" {
				t.Fatalf("wrong issue: %+v", v)
			}
		})
	}
}

func TestExplicitEntryScopesExecutionAndAllowsOtherDraft(t *testing.T) {
	flow := Flow{Nodes: []FlowNode{block("one", BlockData{Kind: "output", Template: "chosen"}), block("two", BlockData{Kind: "request"})}}
	v := ValidateFlow(flow)
	if _, ok := issueByCode(v, "entry_required"); !ok {
		t.Fatalf("missing entry issue: %+v", v)
	}
	flow.EntryID = "one"
	v = ValidateFlow(flow)
	if !v.Valid || v.EntryID != "one" || strings.Join(v.ReachableNodeIDs, ",") != "one" {
		t.Fatalf("wrong selected scope: %+v", v)
	}
	result, err := NewRunner().Run(context.Background(), flow)
	if err != nil || result.Output != "chosen" || len(result.Steps) != 1 {
		t.Fatalf("executed unrelated draft: %+v %v", result, err)
	}
	flow.EntryID = "deleted"
	if _, ok := issueByCode(ValidateFlow(flow), "entry_missing"); !ok {
		t.Fatal("deleted entry accepted")
	}
}

func TestPreflightTemplatesBindingsAndRuntimePriority(t *testing.T) {
	flow := Flow{Nodes: []FlowNode{
		block("first", BlockData{Kind: "input", Variable: "base", Value: "https://8.8.8.8"}),
		block("collision", BlockData{Kind: "input", Variable: "second", Value: "correct variable"}),
		block("second", BlockData{Kind: "request", URL: "{{base}}/path", Headers: map[string]string{"X-Value": "{{second}}"}, Body: "{{outside}}"}),
	}, Edges: []FlowEdge{connect("first", "collision"), connect("collision", "second")}, Inputs: map[string]string{"outside": "external"}}
	v := ValidateFlow(flow)
	if !v.Valid {
		t.Fatalf("valid bindings rejected: %+v", v)
	}
	runner := NewRunner()
	runner.Client.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.URL.String() != "https://8.8.8.8/path" || req.Header.Get("X-Value") != "correct variable" {
			t.Fatal("runtime binding priority differs")
		}
		return jsonResponse(200, `{}`, nil), nil
	})
	result, err := runner.Run(context.Background(), flow)
	if err != nil || result.Status != "success" {
		t.Fatalf("%+v %v", result, err)
	}
	flow.Nodes[2].Data.Body = "{{absent}}"
	if _, ok := issueByCode(ValidateFlow(flow), "missing_variable"); !ok {
		t.Fatal("unknown parameter accepted")
	}
	flow.Nodes[2].Data.Body = "broken {{outside"
	if _, ok := issueByCode(ValidateFlow(flow), "invalid_template"); !ok {
		t.Fatal("malformed template accepted")
	}
}

func TestLargeCanvasHasSeparateReachableRunLimit(t *testing.T) {
	flow := Flow{EntryID: "n0"}
	for i := 0; i < 470; i++ {
		flow.Nodes = append(flow.Nodes, block(fmt.Sprintf("n%d", i), BlockData{Kind: "output"}))
	}
	if v := ValidateFlow(flow); !v.Valid || len(v.ReachableNodeIDs) != 1 {
		t.Fatalf("large independent canvas rejected: %+v", v)
	}
	for i := 1; i < 101; i++ {
		flow.Edges = append(flow.Edges, connect(fmt.Sprintf("n%d", i-1), fmt.Sprintf("n%d", i)))
	}
	if _, ok := issueByCode(ValidateFlow(flow), "run_node_count"); !ok {
		t.Fatal("unbounded reachable execution accepted")
	}
}

func TestHTTPStatusesAndSeparateBusinessAssertion(t *testing.T) {
	for _, test := range []struct {
		status               int
		allowed              string
		expected             string
		wantStatus, wantCode string
	}{
		{500, "", "true", "error", "http_status"},
		{404, "200-299,404", "true", "success", ""},
		{200, "", "false", "error", "assertion_failed"},
		{200, "", "true", "success", ""},
	} {
		t.Run(fmt.Sprintf("%d-%s-%s", test.status, test.allowed, test.expected), func(t *testing.T) {
			runner := NewRunner()
			runner.Client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) { return jsonResponse(test.status, `{"ok":true}`, nil), nil })
			flow := Flow{Nodes: []FlowNode{block("req", BlockData{Kind: "request", URL: "https://8.8.8.8", AcceptStatus: test.allowed}), block("assert", BlockData{Kind: "assertion", Variable: "req.body.ok", Operator: "eq", Expected: test.expected})}, Edges: []FlowEdge{connect("req", "assert")}}
			result, err := runner.Run(context.Background(), flow)
			if err != nil || result.Status != test.wantStatus {
				t.Fatalf("%+v %v", result, err)
			}
			if test.wantCode != "" {
				found := false
				for _, step := range result.Steps {
					if step.ErrorCode == test.wantCode {
						found = true
						if step.Result == nil {
							t.Fatal("failed result was lost")
						}
					}
				}
				if !found {
					t.Fatalf("missing error code %s: %+v", test.wantCode, result)
				}
			}
		})
	}
	for _, value := range []string{"99", "600", "400-200", "200-600", "200,", "200--299"} {
		if _, err := parseAcceptedStatuses(value); err == nil {
			t.Errorf("accepted invalid status: %s", value)
		}
	}
}
