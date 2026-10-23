package app

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestRuntimeCaptureAndExplicitSessionIsolation(t *testing.T) {
	for _, explicit := range []bool{false, true} {
		t.Run(fmt.Sprint(explicit), func(t *testing.T) {
			runner := NewRunner()
			calls := 0
			runner.Client.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
				calls++
				cookie := req.Header.Get("Cookie")
				switch req.URL.Path {
				case "/set":
					return jsonResponse(200, `{}`, http.Header{"Set-Cookie": []string{"account=alice; Path=/"}}), nil
				case "/other":
					if cookie != "" {
						t.Fatalf("other account received cookie %s", cookie)
					}
				case "/same":
					if cookie != "account=alice" {
						t.Fatalf("original session lost cookie %s", cookie)
					}
				}
				return jsonResponse(200, `{}`, nil), nil
			})
			flow := Flow{Nodes: []FlowNode{block("a", BlockData{Kind: "request", URL: "https://8.8.8.8/set", CaptureID: "first"}), block("b", BlockData{Kind: "request", URL: "https://8.8.8.8/other", CaptureID: "second"}), block("c", BlockData{Kind: "request", URL: "https://8.8.8.8/same", CaptureID: "first"})}, Edges: []FlowEdge{connect("a", "b"), connect("b", "c")}}
			if explicit {
				flow.Nodes = append(flow.Nodes, block("alice", BlockData{Kind: "browserSession", Session: &SessionConfig{Name: "Alice"}}), block("bob", BlockData{Kind: "browserSession", Session: &SessionConfig{Name: "Bob"}}))
				flow.Nodes[0].Data.SessionID = "alice"
				flow.Nodes[1].Data.SessionID = "bob"
				flow.Nodes[2].Data.SessionID = "alice"
			}
			result, err := runner.Run(context.Background(), flow)
			if err != nil || result.Status != "success" || calls != 3 {
				t.Fatalf("result=%+v err=%v calls=%d", result, err, calls)
			}
		})
	}
}

func TestRuntimeLoopCountsListsAndUniqueHistory(t *testing.T) {
	for _, count := range []int{0, 1, 3} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			flow := Flow{Nodes: []FlowNode{block("repeat", BlockData{Kind: "loop", Loop: &LoopConfig{Count: count, Nodes: []FlowNode{block("out", BlockData{Kind: "output", Template: "{{index}}"})}}}), block("done", BlockData{Kind: "output", Template: "{{repeat.count}}"})}, Edges: []FlowEdge{connect("repeat", "done")}}
			result, err := NewRunner().Run(context.Background(), flow)
			if err != nil || result.Status != "success" || result.Output != fmt.Sprint(count) {
				t.Fatalf("result=%+v err=%v", result, err)
			}
			seen := map[string]bool{}
			history := 0
			for _, step := range result.Steps {
				if step.ExecutionID == "" || seen[step.ExecutionID] {
					t.Fatalf("bad execution IDs: %+v", result.Steps)
				}
				seen[step.ExecutionID] = true
				if step.NodeID == "out" {
					history++
					if step.Iteration != history || len(step.ScopePath) != 1 || step.Result != fmt.Sprint(history-1) {
						t.Fatalf("bad history %+v", step)
					}
				}
			}
			if history != count {
				t.Fatalf("expected %d iterations got %d", count, history)
			}
		})
	}
	flow := Flow{Nodes: []FlowNode{block("each", BlockData{Kind: "loop", Loop: &LoopConfig{Mode: "each", Items: `[{"name":"Ada"},{"name":"Lin"}]`, Nodes: []FlowNode{block("itemOut", BlockData{Kind: "output", Template: "{{item.name}}"})}}})}}
	result, err := NewRunner().Run(context.Background(), flow)
	if err != nil || result.Status != "success" {
		t.Fatalf("list failed %+v %v", result, err)
	}
	if result.Steps[0].Result != "Ada" || result.Steps[1].Result != "Lin" {
		t.Fatalf("wrong items %+v", result.Steps)
	}
}

func TestRuntimeNestedLoopsAndVariableScope(t *testing.T) {
	inner := block("inner", BlockData{Kind: "loop", Loop: &LoopConfig{Count: 2, IndexVariable: "j", Nodes: []FlowNode{block("nestedOut", BlockData{Kind: "output", Template: "{{i}}:{{j}}:{{greeting}}"})}}})
	flow := Flow{Inputs: map[string]string{"greeting": "hello"}, Nodes: []FlowNode{block("outer", BlockData{Kind: "loop", Loop: &LoopConfig{Count: 2, IndexVariable: "i", Nodes: []FlowNode{inner}}})}}
	result, err := NewRunner().Run(context.Background(), flow)
	if err != nil || result.Status != "success" {
		t.Fatalf("%+v %v", result, err)
	}
	want := []string{"0:0:hello", "0:1:hello", "1:0:hello", "1:1:hello"}
	n := 0
	for _, step := range result.Steps {
		if step.NodeID == "nestedOut" {
			if step.Result != want[n] || len(step.ScopePath) != 2 {
				t.Fatalf("bad nested scope %+v", step)
			}
			n++
		}
	}
	if n != 4 || result.Variables["i"] != nil || result.Variables["j"] != nil {
		t.Fatalf("scope leaked %+v", result)
	}
}

func TestRuntimeLoopFreshSessionAndContinueOnError(t *testing.T) {
	for _, fresh := range []bool{false, true} {
		t.Run(fmt.Sprint(fresh), func(t *testing.T) {
			runner := NewRunner()
			calls := 0
			runner.Client.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
				calls++
				if fresh && req.Header.Get("Cookie") != "" {
					t.Fatal("fresh iteration received prior cookie")
				}
				if !fresh && calls > 1 && req.Header.Get("Cookie") != "round=1" {
					t.Fatal("shared iteration lost cookie")
				}
				return jsonResponse(200, `{}`, http.Header{"Set-Cookie": []string{"round=1; Path=/"}}), nil
			})
			flow := Flow{Nodes: []FlowNode{block("repeat", BlockData{Kind: "loop", Loop: &LoopConfig{Count: 3, FreshSession: fresh, Nodes: []FlowNode{block("req", BlockData{Kind: "request", URL: "https://8.8.8.8"})}}})}}
			result, err := runner.Run(context.Background(), flow)
			if err != nil || result.Status != "success" || calls != 3 {
				t.Fatalf("%+v %v", result, err)
			}
		})
	}
	for _, cont := range []bool{false, true} {
		flow := Flow{Nodes: []FlowNode{block("repeat", BlockData{Kind: "loop", Loop: &LoopConfig{Count: 3, ContinueOnError: cont, Nodes: []FlowNode{block("check", BlockData{Kind: "assertion", Variable: "index", Operator: "neq", Expected: "1"})}}})}}
		result, err := NewRunner().Run(context.Background(), flow)
		if err != nil {
			t.Fatal(err)
		}
		if cont && result.Status != "success" || !cont && result.Status != "error" {
			t.Fatalf("continue=%v result=%+v", cont, result)
		}
	}
}

func TestRuntimeLoopBranchCannotReusePriorIterationValue(t *testing.T) {
	loop := &LoopConfig{Count: 2, Nodes: []FlowNode{block("branch", BlockData{Kind: "condition", Variable: "index", Operator: "eq", Expected: "0"}), block("producer", BlockData{Kind: "input", Variable: "onlyFirst", Value: "recorded"}), block("merge", BlockData{Kind: "output", Template: "{{onlyFirst}}"})}, Edges: []FlowEdge{{Source: "branch", Target: "producer", SourceHandle: "true"}, {Source: "branch", Target: "merge", SourceHandle: "false"}, connect("producer", "merge")}}
	result, err := NewRunner().Run(context.Background(), Flow{Nodes: []FlowNode{block("repeat", BlockData{Kind: "loop", Loop: loop})}})
	if err != nil || result.Status != "error" {
		t.Fatalf("branch reused stale value %+v %v", result, err)
	}
	found := false
	for _, step := range result.Steps {
		if step.NodeID == "merge" && step.Iteration == 2 && step.Status == "error" {
			found = true
		}
	}
	if !found {
		t.Fatalf("no precise branch failure %+v", result.Steps)
	}
}

func TestRuntimeBreakStopsNearestLoop(t *testing.T) {
	flow := Flow{Nodes: []FlowNode{block("repeat", BlockData{Kind: "loop", Loop: &LoopConfig{Count: 5, Nodes: []FlowNode{block("stop", BlockData{Kind: "break"}), block("later", BlockData{Kind: "output", Template: "should skip"})}, Edges: []FlowEdge{connect("stop", "later")}}})}}
	result, err := NewRunner().Run(context.Background(), flow)
	if err != nil || result.Status != "success" || len(result.Steps) != 3 || result.Steps[1].Status != "skipped" {
		t.Fatalf("bad break %+v %v", result, err)
	}
}

func TestRuntimeResourceReferencesAndProfileApplication(t *testing.T) {
	runner := NewRunner()
	runner.Client.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.Header.Get("User-Agent") != "TestBrowser/1" || req.Header.Get("Accept-Language") != "zh-CN" {
			t.Fatalf("profile not applied: %v", req.Header)
		}
		return jsonResponse(200, `{}`, nil), nil
	})
	flow := Flow{Nodes: []FlowNode{block("profile", BlockData{Kind: "profile", Profile: &BrowserProfileConfig{Locale: "zh-CN", Timezone: "Asia/Shanghai", UserAgent: "TestBrowser/1"}}), block("session", BlockData{Kind: "browserSession", Session: &SessionConfig{ProfileID: "profile"}}), block("req", BlockData{Kind: "request", URL: "https://8.8.8.8", Headers: map[string]string{"user-agent": "stale", "accept-language": "old"}})}, ResourceBindings: []ResourceBinding{{ResourceID: "session", TargetID: "req"}}}
	v := ValidateFlow(flow)
	if !v.Valid || len(v.EntryNodeIDs) != 1 || v.EntryID != "req" {
		t.Fatalf("resource became execution root %+v", v)
	}
	result, err := runner.Run(context.Background(), flow)
	if err != nil || result.Status != "success" {
		t.Fatalf("profile result %+v %v", result, err)
	}
	flow.Nodes[2].Data.ProxyID = "deleted"
	if issue, ok := issueByCode(ValidateFlow(flow), "resource_missing"); !ok || issue.NodeID != "req" {
		t.Fatal("missing resource not diagnosed")
	}
}

func TestRuntimeProxyRotationBuckets(t *testing.T) {
	for _, mode := range []string{"fixed", "run", "request", "minutes"} {
		t.Run(mode, func(t *testing.T) {
			p := &ProxyConfig{URL: "socks5://account-sid-original:pass@8.8.8.8:1080", SessionToken: "original", Rotation: mode, RotationMinutes: 5}
			flow := Flow{Nodes: []FlowNode{block("p", BlockData{Kind: "proxy", Proxy: p})}}
			rr := newRunResources(NewRunner(), flow)
			defer rr.close()
			node := block("r", BlockData{ProxyID: "p"})
			first, _ := rr.config(node, ResourceDefaults{}, "")
			second, _ := rr.config(node, ResourceDefaults{}, "")
			a, _ := url.Parse(first.Proxy.URL)
			b, _ := url.Parse(second.Proxy.URL)
			if mode == "fixed" && !strings.Contains(a.User.Username(), "original") {
				t.Fatal("fixed identity changed")
			}
			if mode == "request" && a.User.Username() == b.User.Username() {
				t.Fatal("request identity not changed")
			}
			if mode != "request" && a.User.Username() != b.User.Username() {
				t.Fatal("identity unexpectedly changed")
			}
			if mode == "minutes" {
				rr.now = func() time.Time { return rr.start.Add(5 * time.Minute) }
				third, _ := rr.config(node, ResourceDefaults{}, "")
				c, _ := url.Parse(third.Proxy.URL)
				if c.User.Username() == a.User.Username() {
					t.Fatal("elapsed bucket did not rotate")
				}
			}
		})
	}
}

func TestRuntimePreflightNewKindsFailClearly(t *testing.T) {
	for _, tc := range []struct {
		data BlockData
		code string
	}{{BlockData{Kind: "proxy", Proxy: &ProxyConfig{URL: "socks5://x:y@8.8.8.8:1080", CredentialsMissing: true}}, "invalid_proxy"}, {BlockData{Kind: "loop", Loop: &LoopConfig{Count: 1001, Nodes: []FlowNode{block("out", BlockData{Kind: "output"})}}}, "loop_count"}, {BlockData{Kind: "break"}, "break_outside_loop"}} {
		v := ValidateFlow(Flow{Nodes: []FlowNode{block("test", tc.data)}})
		if _, ok := issueByCode(v, tc.code); !ok {
			t.Fatalf("missing %s issue %+v", tc.code, v)
		}
	}
}

func TestRuntimeUnusedDraftResourceDoesNotBlockSelectedFlow(t *testing.T) {
	flow := Flow{Nodes: []FlowNode{block("draft", BlockData{Kind: "proxy", Proxy: &ProxyConfig{}}), block("out", BlockData{Kind: "output", Template: "ready"})}}
	result, err := NewRunner().Run(t.Context(), flow)
	if err != nil || result.Status != "success" || result.Output != "ready" {
		t.Fatalf("unused resource blocked selected flow %+v %v", result, err)
	}
	flow.Nodes[1].Data.ProxyID = "draft"
	validation := ValidateFlow(flow)
	if _, ok := issueByCode(validation, "invalid_proxy"); !ok {
		t.Fatal("selected incomplete resource was not checked")
	}
}
