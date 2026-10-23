package app

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

type scopeRecordingBrowser struct {
	active       map[string]EffectiveResources
	closedScopes []string
	maximum      int
	execute      func(context.Context, FlowNode, EffectiveResources, func(context.Context, PendingInput) (string, error)) (any, error)
}

func (b *scopeRecordingBrowser) Execute(ctx context.Context, node FlowNode, resources EffectiveResources, _, _ map[string]any, await func(context.Context, PendingInput) (string, error)) (any, error) {
	if b.active == nil {
		b.active = map[string]EffectiveResources{}
	}
	b.active[resources.ExecutionSessionID] = resources
	if len(b.active) > b.maximum {
		b.maximum = len(b.active)
	}
	if b.execute != nil {
		return b.execute(ctx, node, resources, await)
	}
	return map[string]any{"text": "fixture"}, nil
}

func (b *scopeRecordingBrowser) CloseScope(ctx context.Context, prefix string) error {
	if ctx.Err() != nil {
		return fmt.Errorf("cleanup inherited cancelled context: %w", ctx.Err())
	}
	b.closedScopes = append(b.closedScopes, prefix)
	for key, resources := range b.active {
		if !resources.SessionPersistent && strings.HasPrefix(key, prefix) {
			delete(b.active, key)
		}
	}
	return nil
}

func TestRuntimeFreshScopeReleasesEachIterationPreservingSharedSession(t *testing.T) {
	browser := &scopeRecordingBrowser{}
	var sharedID string
	browser.execute = func(_ context.Context, node FlowNode, resources EffectiveResources, _ func(context.Context, PendingInput) (string, error)) (any, error) {
		if node.ID == "before" {
			sharedID = resources.ExecutionSessionID
		}
		if node.ID == "before" || node.ID == "after" {
			if !resources.SessionPersistent || resources.ExecutionSessionID != sharedID {
				t.Fatal("outer named saved session changed or was replaced")
			}
		} else if resources.SessionPersistent || resources.ExecutionSessionID == sharedID {
			t.Fatal("fresh iteration reused the outer saved session")
		}
		if browser.maximum > 2 {
			t.Fatal("finished fresh scopes still consume concurrent browser capacity")
		}
		return map[string]any{"text": "fixture"}, nil
	}
	browserStep := func(id string) FlowNode {
		return block(id, BlockData{Kind: "browser", BrowserAction: "read", Selector: "body", SessionID: "account"})
	}
	flow := Flow{ProjectID: "scope-project", Nodes: []FlowNode{
		block("account", BlockData{Kind: "browserSession", Session: &SessionConfig{Name: "Account", Persist: true}}),
		browserStep("before"),
		block("repeat", BlockData{Kind: "loop", Loop: &LoopConfig{Count: 6, FreshSession: true, Nodes: []FlowNode{browserStep("inside")}}}),
		browserStep("after"),
	}, Edges: []FlowEdge{connect("before", "repeat"), connect("repeat", "after")}}
	runner := NewRunner()
	runner.Browser = browser
	result, err := runner.Run(t.Context(), flow)
	if err != nil || result.Status != "success" {
		t.Fatalf("fresh scope execution failed: %+v %v", result, err)
	}
	if len(browser.closedScopes) != 6 || len(browser.active) != 1 || !browser.active[sharedID].SessionPersistent {
		t.Fatalf("scope cleanup removed shared state or leaked temporary state: closures=%v active=%v", browser.closedScopes, browser.active)
	}
	for i, prefix := range browser.closedScopes {
		if !strings.HasSuffix(prefix, fmt.Sprintf(":repeat:%d/session:", i+1)) {
			t.Fatalf("wrong scope closed: %s", prefix)
		}
	}
}

func TestRuntimeFreshScopeCleanupWaitsForHandoffAndRunsOnCancel(t *testing.T) {
	browser := &scopeRecordingBrowser{}
	browser.execute = func(ctx context.Context, node FlowNode, _ EffectiveResources, await func(context.Context, PendingInput) (string, error)) (any, error) {
		_, err := await(ctx, PendingInput{NodeID: node.ID, Variable: "answer"})
		return nil, err
	}
	flow := Flow{Nodes: []FlowNode{block("repeat", BlockData{Kind: "loop", Loop: &LoopConfig{Count: 5, FreshSession: true, Nodes: []FlowNode{block("handoff", BlockData{Kind: "browserVerification", Variable: "answer"})}}})}}
	g, err := validateFlow(flow)
	if err != nil {
		t.Fatal(err)
	}
	runner := NewRunner()
	runner.Browser = browser
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	awaited := 0
	result := runner.executeFlow(ctx, flow, g, executionHooks{AwaitInput: func(ctx context.Context, _ PendingInput) (string, error) {
		awaited++
		if len(browser.closedScopes) != 0 || len(browser.active) != 1 {
			t.Fatal("fresh browser was released before the user completed handoff")
		}
		cancel()
		return "", ctx.Err()
	}})
	if result.Status != "cancelled" || awaited != 1 || len(browser.closedScopes) != 1 || len(browser.active) != 0 {
		t.Fatalf("cancel did not release exactly its completed scope: status=%s awaits=%d closed=%v active=%v", result.Status, awaited, browser.closedScopes, browser.active)
	}
}

func TestRuntimeCloseScopeRetainsUnrelatedHTTPAndSavedClients(t *testing.T) {
	runner := NewRunner()
	rr := newRunResources(runner, Flow{})
	defer rr.close()
	scopes := []string{"", "repeat:1/session", "repeat:10/session"}
	for _, scope := range scopes {
		resources := EffectiveResources{ExecutionSessionID: rr.runID + ":" + scope + ":account"}
		if scope == "" {
			resources.SessionPersistent = true
			resources.StableSessionID = "saved-key"
		}
		if _, err := rr.client(resources); err != nil {
			t.Fatal(err)
		}
	}
	rr.closeScope("repeat:1/session")
	if len(rr.sessions) != 2 || rr.sessions[rr.runID+":repeat:10/session:account"] == nil || rr.sessions[rr.runID+"::account:saved-key"] == nil {
		t.Fatalf("scope cleanup removed unrelated clients: %v", rr.sessions)
	}
}
