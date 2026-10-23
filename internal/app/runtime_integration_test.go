package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"
)

func TestRuntimeCrossCaptureExtractConditionListIntegration(t *testing.T) {
	runner := NewRunner()
	var callsA, callsB atomic.Int32
	runner.Guard.Lookup = func(context.Context, string, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("8.8.8.8")}, nil
	}
	runner.Client.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.URL.Hostname() == "a.invalid" {
			callsA.Add(1)
			if req.Header.Get("Accept-Language") != "zh-CN" {
				t.Fatal("project profile default not applied")
			}
			return jsonResponse(200, `{"orders":["order-1","order-2"]}`, http.Header{"Set-Cookie": []string{"accountA=private; Path=/"}}), nil
		}
		callsB.Add(1)
		if strings.Contains(req.Header.Get("Cookie"), "accountA") {
			t.Fatal("site A cookie leaked into source B")
		}
		if req.URL.Path != "/query/order-1" && req.URL.Path != "/query/order-2" {
			t.Fatalf("wrong cross-source binding %s", req.URL)
		}
		return jsonResponse(200, `{"ok":true,"delivery":"shipped"}`, http.Header{"Set-Cookie": []string{"accountB=current; Path=/"}}), nil
	})
	body := []FlowNode{block("query", BlockData{Kind: "request", CaptureID: "captureB", URL: "https://b.invalid/query/{{item}}"}), block("condition", BlockData{Kind: "condition", Variable: "query.body.ok", Operator: "eq", Expected: "true"}), block("yes", BlockData{Kind: "output", Template: "{{query.body.delivery}}:{{index}}"}), block("no", BlockData{Kind: "output", Template: "not-ready"})}
	flow := Flow{Defaults: ResourceDefaults{ProfileID: "profile"}, Nodes: []FlowNode{block("profile", BlockData{Kind: "profile", Profile: &BrowserProfileConfig{Locale: "zh-CN"}}), block("orders", BlockData{Kind: "request", CaptureID: "captureA", URL: "https://a.invalid/orders"}), block("extract", BlockData{Kind: "extract", Source: "orders", Path: "body.orders", Variable: "orderList"}), block("repeat", BlockData{Kind: "loop", Loop: &LoopConfig{Mode: "each", Items: "orderList", Nodes: body, Edges: []FlowEdge{connect("query", "condition"), {Source: "condition", Target: "yes", SourceHandle: "true"}, {Source: "condition", Target: "no", SourceHandle: "false"}}}}), block("out", BlockData{Kind: "output", Template: "{{repeat.iterations.0.output}}|{{repeat.iterations.1.output}}"})}, Edges: []FlowEdge{connect("orders", "extract"), connect("extract", "repeat"), connect("repeat", "out")}}
	result, err := runner.Run(context.Background(), flow)
	if err != nil || result.Status != "success" || result.Output != "shipped:0|shipped:1" || callsA.Load() != 1 || callsB.Load() != 2 {
		t.Fatalf("integration %+v err=%v calls=%d/%d", result, err, callsA.Load(), callsB.Load())
	}
}

func TestImportsPreflightAndUnknownBrowserViewNeverExecuteBusinessRequests(t *testing.T) {
	server := newFlowTestServer(t)
	defer server.Close()
	var businessCalls atomic.Int32
	server.Runner.Client.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		businessCalls.Add(1)
		return jsonResponse(200, `{}`, nil), nil
	})
	flow := Flow{ProjectID: "offline-project", Nodes: []FlowNode{block("session", BlockData{Kind: "browserSession", Session: &SessionConfig{Persist: true}}), block("req", BlockData{Kind: "request", URL: "https://business.invalid/orders", SessionID: "session"})}}
	encoded, _ := json.Marshal(flow)
	preflight := jobRequest(server, "POST", "/api/flow/validate", string(encoded))
	if preflight.Code != 200 {
		t.Fatalf("preflight %s", preflight.Body.String())
	}
	har := `{"har":{"log":{"version":"1.2","creator":{"name":"test","version":"1"},"entries":[{"request":{"method":"GET","url":"https://business.invalid/orders","headers":[],"queryString":[]},"response":{"status":200,"headers":[],"content":{"mimeType":"application/json","text":"{}"}},"time":1}]}}}`
	parsed := jobRequest(server, "POST", "/api/har/parse", har)
	if parsed.Code != 200 {
		t.Fatalf("parse %s", parsed.Body.String())
	}
	unknown := httptest.NewRecorder()
	server.ServeHTTP(unknown, httptest.NewRequest("GET", "/api/browser/sessions/"+strings.Repeat("a", 48)+"/view", nil))
	if unknown.Code != 404 {
		t.Fatalf("unknown browser route %d", unknown.Code)
	}
	if businessCalls.Load() != 0 || len(server.Runner.sessionStore().items) != 0 || len(server.runSlots) != 0 {
		t.Fatal("import or preflight executed network/acquired run resources")
	}
	server.Browser.mu.Lock()
	worker := server.Browser.worker
	server.Browser.mu.Unlock()
	if worker != nil {
		t.Fatal("nonexecution route launched browser")
	}
}
