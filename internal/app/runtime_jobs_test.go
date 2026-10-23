package app

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
)

func TestRuntimeLoopManualResumeRetainsExactInstanceAndHistory(t *testing.T) {
	server := newFlowTestServer(t)
	var calls atomic.Int32
	server.Runner.Client.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		n := calls.Add(1)
		return jsonResponse(200, fmt.Sprintf(`{"round":%d}`, n), nil), nil
	})
	flow := Flow{Nodes: []FlowNode{block("repeat", BlockData{Kind: "loop", Loop: &LoopConfig{Count: 2, Nodes: []FlowNode{block("req", BlockData{Kind: "request", URL: "https://8.8.8.8"}), block("human", BlockData{Kind: "manual", Variable: "answer", Description: "请输入本轮结果"}), block("out", BlockData{Kind: "output", Template: "{{req.body.round}}:{{answer}}"})}, Edges: []FlowEdge{connect("req", "human"), connect("human", "out")}}})}}
	created := createFlowTestJob(t, server, flow)
	first := waitFlowState(t, server, created.ID, "waiting_input")
	if first.PendingInput == nil || first.PendingInput.ExecutionID != "repeat:1/human" || first.PendingInput.Iteration != 1 || calls.Load() != 1 {
		t.Fatalf("bad first pause %+v calls=%d", first, calls.Load())
	}
	for range 3 {
		view, _ := server.flowJobs.get(created.ID, first.Seq)
		if view.PendingInput.ExecutionID != first.PendingInput.ExecutionID || calls.Load() != 1 {
			t.Fatal("poll replayed paused request")
		}
	}
	_, status, _ := server.flowJobs.resumeJob(created.ID, map[string]string{"answer": "A"})
	if status != 200 {
		t.Fatal(status)
	}
	second := waitFlowState(t, server, created.ID, "waiting_input")
	if second.PendingInput.ExecutionID != "repeat:2/human" || calls.Load() != 2 {
		t.Fatalf("bad second pause %+v calls=%d", second, calls.Load())
	}
	_, status, _ = server.flowJobs.resumeJob(created.ID, map[string]string{"answer": "B"})
	if status != 200 {
		t.Fatal(status)
	}
	done := waitFlowState(t, server, created.ID, "completed")
	if done.Result == nil || len(done.Result.Steps) != 7 || calls.Load() != 2 {
		t.Fatalf("bad finish %+v calls=%d", done, calls.Load())
	}
	for i, want := range []string{"1:A", "2:B"} {
		path := "/api/flow/jobs/" + created.ID + "/results/out?executionId=" + url.QueryEscape(fmt.Sprintf("repeat:%d/out", i+1))
		detail := jobRequest(server, "GET", path, "")
		if detail.Code != 200 || !strings.Contains(detail.Body.String(), want) {
			t.Fatalf("missing exact history %s", detail.Body.String())
		}
	}
}

func TestRuntimeCancelNestedManualDoesNotRunRemainingIterations(t *testing.T) {
	server := newFlowTestServer(t)
	var calls atomic.Int32
	server.Runner.Client.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		calls.Add(1)
		return jsonResponse(200, `{}`, nil), nil
	})
	flow := Flow{Nodes: []FlowNode{block("repeat", BlockData{Kind: "loop", Loop: &LoopConfig{Count: 3, Nodes: []FlowNode{block("req", BlockData{Kind: "request", URL: "https://8.8.8.8"}), block("human", BlockData{Kind: "manual", Variable: "answer"})}, Edges: []FlowEdge{connect("req", "human")}}})}}
	created := createFlowTestJob(t, server, flow)
	waitFlowState(t, server, created.ID, "waiting_input")
	server.flowJobs.resumeJob(created.ID, map[string]string{"answer": "A"})
	waitFlowState(t, server, created.ID, "waiting_input")
	view, ok := server.flowJobs.cancelJob(created.ID)
	if !ok || view.Status != "cancelled" {
		t.Fatal("cancel failed")
	}
	waitRunSlots(t, server, 0)
	if calls.Load() != 2 {
		t.Fatalf("cancel replayed/skipped requests calls=%d", calls.Load())
	}
	found := false
	for _, e := range view.Events {
		if e.ExecutionID == "repeat:2/human" && e.Status == "cancelled" {
			found = true
		}
	}
	if !found {
		t.Fatalf("nested cancelled instance missing %+v", view.Events)
	}
	if _, status, _ := server.flowJobs.resumeJob(created.ID, map[string]string{"answer": "late"}); status != 409 {
		t.Fatal("cancelled job resumed")
	}
}

func TestRuntimeLoopTotalStepAndResultBudgets(t *testing.T) {
	inner := block("inner", BlockData{Kind: "loop", Loop: &LoopConfig{Count: 1000, Nodes: []FlowNode{block("out", BlockData{Kind: "output", Template: "small"})}}})
	result, err := NewRunner().Run(t.Context(), Flow{Nodes: []FlowNode{block("outer", BlockData{Kind: "loop", Loop: &LoopConfig{Count: 1000, Nodes: []FlowNode{inner}}})}})
	if err != nil || result.Status != "error" || len(result.Steps) > maxExecutionSteps+maxLoopDepth {
		t.Fatalf("step budget missing steps=%d status=%s err=%v", len(result.Steps), result.Status, err)
	}
	result, err = NewRunner().Run(t.Context(), Flow{Inputs: map[string]string{"large": strings.Repeat("x", 1<<20)}, Nodes: []FlowNode{block("repeat", BlockData{Kind: "loop", Loop: &LoopConfig{Count: 1000, Nodes: []FlowNode{block("out", BlockData{Kind: "output", Template: "{{large}}"})}}})}})
	if err != nil || result.Status != "error" || len(result.Steps) > 10 {
		t.Fatalf("result budget missing steps=%d status=%s err=%v", len(result.Steps), result.Status, err)
	}
}
