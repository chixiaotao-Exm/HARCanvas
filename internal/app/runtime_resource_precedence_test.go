package app

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

func TestRuntimeResourcePrecedenceIncludesBindingsAtEachScope(t *testing.T) {
	profile := func(id string) FlowNode {
		return block(id, BlockData{Kind: "profile", Profile: &BrowserProfileConfig{Locale: "en-US", UserAgent: id}})
	}
	request := func(id, profileID, sessionID string) FlowNode {
		return block(id, BlockData{Kind: "request", URL: "https://8.8.8.8/" + id, ProfileID: profileID, SessionID: sessionID})
	}
	inner := block("inner", BlockData{Kind: "subflow", Loop: &LoopConfig{Nodes: []FlowNode{
		request("nearest", "", ""), request("requestBinding", "", ""), request("requestData", "explicit", ""),
	}, Edges: []FlowEdge{connect("nearest", "requestBinding"), connect("requestBinding", "requestData")}}})
	outer := block("outer", BlockData{Kind: "subflow", ProfileID: "ancestor", Loop: &LoopConfig{Nodes: []FlowNode{inner, request("ancestorFallback", "", "")}, Edges: []FlowEdge{connect("inner", "ancestorFallback")}}})
	flow := Flow{Defaults: ResourceDefaults{SessionID: "account", ProfileID: "project"}, Nodes: []FlowNode{
		profile("project"), profile("session"), profile("ancestor"), profile("regionBinding"), profile("bound"), profile("explicit"),
		block("account", BlockData{Kind: "browserSession", Session: &SessionConfig{Name: "Account", ProfileID: "session"}}),
		block("emptyAccount", BlockData{Kind: "browserSession", Session: &SessionConfig{Name: "No profile"}}),
		request("sessionFallback", "", ""), outer, request("projectFallback", "", "emptyAccount"),
	}, Edges: []FlowEdge{connect("sessionFallback", "outer"), connect("outer", "projectFallback")}, ResourceBindings: []ResourceBinding{
		{ID: "nearestRegion", ResourceID: "regionBinding", TargetID: "inner"},
		{ID: "boundRequest", ResourceID: "bound", TargetID: "requestBinding"},
		{ID: "shadowedBinding", ResourceID: "bound", TargetID: "requestData"},
	}}
	expected := map[string]string{"sessionFallback": "session", "nearest": "regionBinding", "requestBinding": "bound", "requestData": "explicit", "ancestorFallback": "ancestor", "projectFallback": "project"}
	runner := NewRunner()
	runner.Client.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		id := strings.TrimPrefix(req.URL.Path, "/")
		if got := req.Header.Get("User-Agent"); got != expected[id] {
			t.Fatalf("%s used profile %s instead of %s", id, got, expected[id])
		}
		delete(expected, id)
		return jsonResponse(200, `{}`, nil), nil
	})
	result, err := runner.Run(context.Background(), flow)
	if err != nil || result.Status != "success" || len(expected) != 0 {
		t.Fatalf("resource precedence failed: result=%+v err=%v unvisited=%v", result, err, expected)
	}
}
