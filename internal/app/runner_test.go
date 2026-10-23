package app

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func jsonResponse(status int, body string, headers http.Header) *http.Response {
	if headers == nil {
		headers = make(http.Header)
	}
	headers.Set("Content-Type", "application/json")
	return &http.Response{StatusCode: status, Header: headers, Body: io.NopCloser(strings.NewReader(body))}
}
func block(id string, data BlockData) FlowNode { return FlowNode{ID: id, Type: "block", Data: data} }
func connect(source, target string) FlowEdge   { return FlowEdge{Source: source, Target: target} }

func TestRunnerDependenciesTemplatesAndSession(t *testing.T) {
	runner := NewRunner()
	calls := 0
	runner.Client.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		calls++
		if req.Header.Get("Connection") != "" || req.Header.Get("X-Stale") != "" || req.Header.Get("Content-Length") != "" || req.Header.Get("Host") != "" {
			t.Fatal("stale transport headers were replayed")
		}
		if calls == 1 {
			return jsonResponse(200, `{"data":{"id":"abc","values":[7,9]}}`, http.Header{"Set-Cookie": []string{"session=fresh; Path=/"}}), nil
		}
		if req.URL.Path != "/next/abc" {
			t.Fatalf("wrong templated URL: %s", req.URL)
		}
		body, _ := io.ReadAll(req.Body)
		if string(body) != `{"name":"Ada","item":"abc"}` {
			t.Fatalf("wrong templated body: %s", body)
		}
		cookies := req.Cookies()
		sessionCount := 0
		other := false
		for _, cookie := range cookies {
			if cookie.Name == "session" {
				sessionCount++
				if cookie.Value != "fresh" {
					t.Fatal("stale session cookie returned")
				}
			}
			if cookie.Name == "other" {
				other = true
			}
		}
		if sessionCount != 1 || !other {
			t.Fatalf("session merge failed: %s", req.Header.Get("Cookie"))
		}
		return jsonResponse(200, `{"ok":true}`, nil), nil
	})
	headers := map[string]string{"Cookie": "session=stale; other=keep", "Connection": "keep-alive, X-Stale", "X-Stale": "remove", "Content-Length": "1000", "Host": "old.example"}
	flow := Flow{Nodes: []FlowNode{
		block("in", BlockData{Kind: "input", Variable: "name", Value: "default"}),
		block("start", BlockData{Kind: "request", URL: "https://8.8.8.8/start", Headers: headers}),
		block("extract", BlockData{Kind: "extract", Source: "start", Path: "body.data.id", Variable: "item"}),
		block("next", BlockData{Kind: "request", Method: "POST", URL: "https://8.8.8.8/next/{{item}}", Body: `{"name":"{{name}}","item":"{{start.body.data.id}}"}`, Headers: headers}),
		block("out", BlockData{Kind: "output", Template: "{{next.status}}:{{next.body.ok}}:{{start.body.data.values.1}}"}),
	}, Edges: []FlowEdge{connect("in", "start"), connect("start", "extract"), connect("extract", "next"), connect("next", "out")}, Inputs: map[string]string{"name": "Ada"}}
	result, err := runner.Run(context.Background(), flow)
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "success" || result.Output != "200:true:9" || calls != 2 {
		t.Fatalf("wrong flow result: %+v", result)
	}
}

func TestRunnerCookieDeletionDoesNotResurrectCapture(t *testing.T) {
	runner := NewRunner()
	calls := 0
	runner.Client.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		calls++
		switch calls {
		case 1:
			return jsonResponse(200, `{}`, http.Header{"Set-Cookie": []string{"sid=fresh; Path=/"}}), nil
		case 2:
			return jsonResponse(200, `{}`, http.Header{"Set-Cookie": []string{"sid=; Max-Age=0; Path=/"}}), nil
		default:
			for _, cookie := range req.Cookies() {
				if cookie.Name == "sid" {
					t.Fatal("deleted session cookie resurrected")
				}
			}
			return jsonResponse(200, `{}`, nil), nil
		}
	})
	flow := Flow{Nodes: []FlowNode{block("a", BlockData{Kind: "request", URL: "https://8.8.8.8/login"}), block("b", BlockData{Kind: "request", URL: "https://8.8.8.8/logout"}), block("c", BlockData{Kind: "request", URL: "https://8.8.8.8/check", Headers: map[string]string{"Cookie": "sid=stale"}})}, Edges: []FlowEdge{connect("a", "b"), connect("b", "c")}}
	result, err := runner.Run(context.Background(), flow)
	if err != nil || result.Status != "success" || calls != 3 {
		t.Fatalf("%+v %v calls=%d", result, err, calls)
	}
}

func TestRunnerDiamondWaitsAndUsesActiveBranch(t *testing.T) {
	for _, value := range []string{"yes", "no"} {
		t.Run(value, func(t *testing.T) {
			flow := Flow{Nodes: []FlowNode{
				block("in", BlockData{Kind: "input", Variable: "answer", Value: value}),
				block("if", BlockData{Kind: "condition", Variable: "answer", Operator: "eq", Expected: "yes"}),
				block("yes", BlockData{Kind: "input", Variable: "picked", Value: "true branch"}),
				block("no", BlockData{Kind: "input", Variable: "picked", Value: "false branch"}),
				block("join", BlockData{Kind: "output", Template: "{{picked}}"}),
			}, Edges: []FlowEdge{connect("in", "if"), {Source: "if", Target: "yes", SourceHandle: "true"}, {Source: "if", Target: "no", SourceHandle: "false"}, connect("yes", "join"), connect("no", "join")}}
			result, err := NewRunner().Run(context.Background(), flow)
			if err != nil {
				t.Fatal(err)
			}
			expected := "true branch"
			skip := "no"
			if value == "no" {
				expected = "false branch"
				skip = "yes"
			}
			if result.Status != "success" || result.Output != expected || result.Steps[len(result.Steps)-1].NodeID != "join" {
				t.Fatalf("incorrect diamond: %+v", result)
			}
			for _, step := range result.Steps {
				if step.NodeID == skip && step.Status != "skipped" {
					t.Fatal("inactive branch ran")
				}
			}
		})
	}
}

func TestConditionExistsIncludesEmptyString(t *testing.T) {
	flow := Flow{Nodes: []FlowNode{block("in", BlockData{Kind: "input", Variable: "empty", Value: ""}), block("if", BlockData{Kind: "condition", Variable: "empty", Operator: "exists"}), block("out", BlockData{Kind: "output", Template: "exists"})}, Edges: []FlowEdge{connect("in", "if"), {Source: "if", Target: "out", SourceHandle: "true"}}}
	result, err := NewRunner().Run(context.Background(), flow)
	if err != nil || result.Output != "exists" {
		t.Fatalf("%+v %v", result, err)
	}
}

func TestGraphRejectsCyclesAndMissingExtractionDependencies(t *testing.T) {
	valid := []FlowNode{block("a", BlockData{Kind: "input", Variable: "x"}), block("b", BlockData{Kind: "output"})}
	for _, flow := range []Flow{{Nodes: valid, Edges: []FlowEdge{connect("a", "b"), connect("b", "a")}}, {Nodes: valid, Edges: []FlowEdge{connect("missing", "b")}}, {Nodes: []FlowNode{block("req", BlockData{Kind: "request", URL: "https://8.8.8.8"}), block("ex", BlockData{Kind: "extract", Source: "req", Path: "body.id", Variable: "id"})}}} {
		if _, err := validateFlow(flow); err == nil {
			t.Fatal("invalid graph accepted")
		}
	}
}

func TestTemplateMissingReferencesMalformedAndExpansionLimit(t *testing.T) {
	variables := map[string]any{"name": "{{untrusted}}", "large": strings.Repeat("x", 1<<20)}
	value, err := renderTemplate("literal {{name}}", variables, nil)
	if err != nil || value != "literal {{untrusted}}" {
		t.Fatal("template recursively interpreted user data")
	}
	for _, input := range []string{"{{missing}}", "broken {{name", "{{{{name}}", "{{large}}{{large}}x"} {
		if _, err := renderTemplate(input, variables, nil); err == nil {
			t.Errorf("expected template error: %.50s", input)
		}
	}
	for _, input := range []string{`{"user":{"name":"Alice"}}`, `{"user":{"name":"{{name}}"}}`} {
		if _, err := renderTemplate(input, variables, nil); err != nil {
			t.Fatalf("nested JSON rejected: %v", err)
		}
	}
}

func TestRunnerReportsFailureAndSkipsRemainder(t *testing.T) {
	flow := Flow{Nodes: []FlowNode{block("bad", BlockData{Kind: "output", Template: "{{missing}}"}), block("next", BlockData{Kind: "output", Template: "should not run"})}, Edges: []FlowEdge{connect("bad", "next")}}
	result, err := NewRunner().Run(context.Background(), flow)
	if err != nil || result.Status != "error" || result.Steps[0].Status != "error" || result.Steps[1].Status != "skipped" {
		t.Fatalf("%+v %v", result, err)
	}
}
