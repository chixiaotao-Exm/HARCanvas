package app

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestRequestBindingsEscapeJSONAndURLQueryValues(t *testing.T) {
	runner := NewRunner()
	value := "a\"b\nline & extra=1 + plus"
	calls := 0
	runner.Client.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		calls++
		if calls == 1 {
			return jsonResponse(200, `{"value":"upstream \"quoted\"\ntext & extra=1 + plus"}`, nil), nil
		}
		query := req.URL.Query()
		if query.Get("user") != value || query.Get("upstream") != "upstream \"quoted\"\ntext & extra=1 + plus" || len(query) != 3 || query.Get("keep") != "raw+plus" {
			t.Errorf("query binding was corrupted: %s", req.URL.RawQuery)
		}
		body, _ := io.ReadAll(req.Body)
		var payload struct {
			User     string      `json:"user"`
			Upstream string      `json:"upstream"`
			Number   json.Number `json:"number"`
			Boolean  bool        `json:"boolean"`
			Nested   []string    `json:"nested"`
		}
		if json.Unmarshal(body, &payload) != nil || payload.User != value || payload.Upstream != query.Get("upstream") || payload.Number != "12345678901234567890" || !payload.Boolean || len(payload.Nested) != 1 || payload.Nested[0] != value {
			t.Errorf("JSON binding was corrupted: %s", body)
		}
		return jsonResponse(200, `{}`, nil), nil
	})
	flow := Flow{Nodes: []FlowNode{block("source", BlockData{Kind: "request", URL: "https://8.8.8.8/prepare"}), block("submit", BlockData{Kind: "request", Method: "POST", URL: "https://8.8.8.8/submit?keep=raw%2Bplus&user={{value}}&upstream={{source.body.value}}", Body: `{"user":"{{value}}","upstream":"{{source.body.value}}","number":12345678901234567890,"boolean":true,"nested":["{{value}}"]}`})}, Edges: []FlowEdge{connect("source", "submit")}, Inputs: map[string]string{"value": value}}
	result, err := runner.Run(context.Background(), flow)
	if err != nil || result.Status != "success" || calls != 2 {
		t.Fatalf("%+v %v", result, err)
	}
}

func TestRequestRenderingRetainsUntemplatedSignedURLAndLimitsExpansion(t *testing.T) {
	address := "https://8.8.8.8/path?z=a+b&x=%7e&x=%2f&signature=abc"
	rendered, err := renderRequestURL(address, nil, nil)
	if err != nil || rendered != address {
		t.Fatal("URL without templates was rewritten")
	}
	body := `{ "z": 1, "a":true }`
	rendered, err = renderRequestBody(body, nil, nil)
	if err != nil || rendered != body {
		t.Fatal("body without templates was rewritten")
	}
	variables := map[string]any{"value": "a&b+ =c", "large": strings.Repeat("x", 1<<20)}
	rendered, err = renderRequestURL("https://8.8.8.8/?value=%7B%7Bvalue%7D%7D", variables, nil)
	if err != nil || !strings.Contains(rendered, "value=a%26b%2B+%3Dc") {
		t.Fatalf("encoded template unsupported: %s %v", rendered, err)
	}
	if _, err = renderRequestBody(`["{{large}}","{{large}}","{{large}}"]`, variables, nil); err == nil {
		t.Fatal("aggregate JSON expansion limit missing")
	}
	if _, err = renderRequestURL("https://8.8.8.8/?a={{large}}&b={{large}}&c={{large}}", variables, nil); err == nil {
		t.Fatal("aggregate URL expansion limit missing")
	}
	if _, ok := issueByCode(ValidateFlow(Flow{Nodes: []FlowNode{block("req", BlockData{Kind: "request", URL: "https://8.8.8.8/?a=%7B%7Bmissing%7D%7D"})}}), "missing_variable"); !ok {
		t.Fatal("encoded query reference bypassed preflight")
	}
}

func TestFlowEventsUseSafeMessagesWhileDetailsRemainAvailable(t *testing.T) {
	server := newFlowTestServer(t)
	server.Runner.Client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) { return nil, errors.New("mock transport failure") })
	created := createFlowTestJob(t, server, Flow{Nodes: []FlowNode{block("request", BlockData{Kind: "request", URL: "https://8.8.8.8/?token=private-query-value"})}})
	failed := waitFlowState(t, server, created.ID, "failed")
	encoded, _ := json.Marshal(failed)
	if strings.Contains(string(encoded), "private-query-value") {
		t.Fatal("event or polling summary included full request query")
	}
	detail := jobRequest(server, "GET", "/api/flow/jobs/"+created.ID+"/results/request", "")
	if detail.Code != 200 || !strings.Contains(detail.Body.String(), "private-query-value") {
		t.Fatal("on-demand diagnostic detail unavailable")
	}
}
