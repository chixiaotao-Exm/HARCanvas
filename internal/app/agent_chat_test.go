package app

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func syntheticChatInput() ChatInput {
	return ChatInput{BaseRevision: 7, Nodes: []ChatCatalogNode{{ID: "a", Kind: "request", Label: "查询订单", Fields: []ChatField{{Target: "body", Path: "email"}}, Inputs: []ChatInputField{{Variable: "param_mail", Title: "邮箱"}}, Bindings: []ChatBinding{}}}, Edges: []FlowEdge{}, ResourceBindings: []ResourceBinding{}, Requests: []ChatCatalogRequest{{ID: "req-1", Method: "GET", Site: "example.invalid", Path: "/orders/:参数"}}, SelectedNodeIDs: []string{"a"}, Messages: []ChatConversationMessage{{Role: "user", Content: "把当前步骤重命名为读取订单"}}}
}
func syntheticChatPlan() ChatPlan {
	return ChatPlan{BaseRevision: 7, Message: "已重命名为读取订单", Commands: []ChatCommand{{Op: "patch", NodeID: "a", Data: map[string]json.RawMessage{"label": json.RawMessage(`"读取订单"`)}}}, Questions: []ChatQuestion{}}
}
func TestChatCatalogBoundsAndCapabilities(t *testing.T) {
	if _, _, err := prepareChat(syntheticChatInput()); err != nil {
		t.Fatal(err)
	}
	for _, edit := range []func(*ChatInput){func(i *ChatInput) { i.BaseRevision = -1 }, func(i *ChatInput) { i.Nodes[0].ID = "__proto__" }, func(i *ChatInput) { i.Nodes[0].Fields[0].Path = "constructor.token" }, func(i *ChatInput) { i.Requests[0].Site = "user:pass@example.invalid" }, func(i *ChatInput) { i.Requests[0].Path = "/orders?secret=value" }, func(i *ChatInput) { i.SelectedNodeIDs = []string{"missing"} }, func(i *ChatInput) { i.Messages = nil }} {
		input := syntheticChatInput()
		edit(&input)
		if _, _, err := prepareChat(input); err == nil {
			t.Fatal("invalid catalog accepted")
		}
	}
}
func TestChatPlansAreRevisionedAndRejectUnsupportedTools(t *testing.T) {
	input := syntheticChatInput()
	if err := validateChatPlan(syntheticChatPlan(), input); err != nil {
		t.Fatal(err)
	}
	for _, edit := range []func(*ChatPlan){func(p *ChatPlan) { p.BaseRevision = 1 }, func(p *ChatPlan) { p.Commands[0].Op = "exec" }, func(p *ChatPlan) { p.Commands[0].NodeID = "missing" }, func(p *ChatPlan) {
		p.Commands[0].Data = map[string]json.RawMessage{"readiness": json.RawMessage(`"ready"`)}
	}, func(p *ChatPlan) {
		p.Commands[0].Data = map[string]json.RawMessage{"proxy": json.RawMessage(`{"url":"socks5://secret:password@proxy.invalid:1080"}`)}
	}, func(p *ChatPlan) { p.RunIntent = true }, func(p *ChatPlan) {
		p.Questions = []ChatQuestion{{ID: "q", Title: "输入", Variable: "unrelated_secret"}}
	}} {
		plan := syntheticChatPlan()
		edit(&plan)
		if err := validateChatPlan(plan, input); err == nil {
			t.Fatal("invalid plan accepted")
		}
	}
	input.Messages[0].Content = "现在运行整个流程"
	plan := syntheticChatPlan()
	plan.RunIntent = true
	if err := validateChatPlan(plan, input); err != nil {
		t.Fatal("explicit run intent rejected", err)
	}
}
func TestChatStrictJSONAndQuestionBoolean(t *testing.T) {
	valid := `{"baseRevision":7,"message":"填写邮箱","commands":[],"questions":[{"id":"q","title":"邮箱","help":"用于这个步骤","placeholder":"请输入邮箱","required":true,"variable":"param_mail"}]}`
	if _, err := decodeChatPlan(valid); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{valid + `{}`, strings.Replace(valid, `"required":true`, `"required":null`, 1), strings.Replace(valid, `"required":true,`, "", 1), strings.Replace(valid, `"commands":[]`, `"commands":[{"op":"patch","nodeId":"a","shell":"execute"}]`, 1)} {
		if _, err := decodeChatPlan(raw); err == nil {
			t.Fatal("invalid strict response accepted")
		}
	}
}
func TestChatJobsUseSharedGuardedProviderAndReturnStructuredEdits(t *testing.T) {
	server := newJobTestServer(t)
	server.Analyzer.Client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatal(err)
		}
		encoded, _ := json.Marshal(payload)
		if strings.Contains(string(encoded), "Cookie") || strings.Contains(string(encoded), "Authorization") {
			t.Fatal("captured credentials entered chat catalog")
		}
		plan, _ := json.Marshal(syntheticChatPlan())
		return jsonResponse(200, overviewRawCompletion(string(plan)), nil), nil
	})
	body, _ := json.Marshal(map[string]any{"mode": "chat", "config": AgentConfig{BaseURL: "https://8.8.8.8/v1", APIKey: "synthetic-model-key", Model: "synthetic-model"}, "chat": syntheticChatInput()})
	created := createTestJob(t, server, string(body))
	view := waitJob(t, server, created.ID, "completed")
	if view.Mode != "chat" || view.Chat == nil || len(view.Chat.Commands) != 1 || view.Chat.Commands[0].NodeID != "a" || view.Analysis != nil {
		t.Fatal("chat result not isolated from analysis", view)
	}
}

func TestChatSupportsLegacyDottedBindingIDs(t *testing.T) {
	input := syntheticChatInput()
	input.Nodes[0].Inputs[0].BindingID = "input-body-profile.email"
	if _, _, err := prepareChat(input); err != nil {
		t.Fatal("legacy binding catalog rejected", err)
	}
	plan := syntheticChatPlan()
	plan.Commands = []ChatCommand{{Op: "bind", NodeID: "a", Binding: &ChatCommandBinding{ID: "input-body-profile.email", Name: "邮箱", Target: "body", Path: "email", Mode: "user"}}, {Op: "unbind", NodeID: "a", BindingID: "input-body-profile.email"}}
	if err := validateChatPlan(plan, input); err != nil {
		t.Fatal("legacy binding edit rejected", err)
	}
	for _, bindingID := range []string{"", "__proto__", "bad\tidentifier"} {
		plan.Commands[0].Binding.ID = bindingID
		if err := validateChatPlan(plan, input); err == nil {
			t.Fatal("invalid binding identifier accepted")
		}
	}
}

func TestChatNestedCatalogRetainsEdgesAndSupportsScopedCreation(t *testing.T) {
	input := syntheticChatInput()
	input.Nodes = []ChatCatalogNode{{ID: "flow", Kind: "subflow", Label: "子流程", Children: []ChatCatalogNode{input.Nodes[0], {ID: "b", Kind: "output", Label: "输出"}}, ChildEdges: []FlowEdge{{ID: "ab", Source: "a", Target: "b"}}}}
	if _, _, err := prepareChat(input); err != nil {
		t.Fatal("valid nested catalog rejected", err)
	}
	plan := syntheticChatPlan()
	plan.Commands = []ChatCommand{{Op: "disconnect", EdgeIDs: []string{"ab"}}, {Op: "create", ID: "c", Kind: "output", Label: "新输出", ScopeID: "flow"}, {Op: "connect", ID: "ac", Source: "a", Target: "c"}}
	if err := validateChatPlan(plan, input); err != nil {
		t.Fatal("nested edge edit rejected", err)
	}
	plan.Commands = []ChatCommand{{Op: "connect", ID: "ba", Source: "b", Target: "a"}}
	if err := validateChatPlan(plan, input); err == nil {
		t.Fatal("cycle through existing nested edge accepted")
	}
	input.Nodes[0].ChildEdges[0].Target = "flow"
	if _, _, err := prepareChat(input); err == nil {
		t.Fatal("cross-scope nested catalog edge accepted")
	}
}

func TestChatCanPreciselyRemoveExistingMissingResourceRelations(t *testing.T) {
	input := syntheticChatInput()
	input.ResourceBindings = []ResourceBinding{{ID: "missing-source", ResourceID: "deleted-proxy", TargetID: "a"}, {ID: "missing-both", ResourceID: "deleted-profile", TargetID: "deleted-target"}}
	if _, _, err := prepareChat(input); err != nil {
		t.Fatal("draft resource references rejected", err)
	}
	plan := syntheticChatPlan()
	plan.Commands = []ChatCommand{{Op: "resource", ID: "missing-source", ResourceID: "deleted-proxy", TargetID: "a", Remove: true}, {Op: "resource", ID: "missing-both", ResourceID: "deleted-profile", TargetID: "deleted-target", Remove: true}}
	if err := validateChatPlan(plan, input); err != nil {
		t.Fatal("exact removal of missing relations rejected", err)
	}
	for _, edit := range []func(*ChatCommand){func(c *ChatCommand) { c.Remove = false }, func(c *ChatCommand) { c.ID = "invented" }, func(c *ChatCommand) { c.ResourceID = "different" }, func(c *ChatCommand) { c.TargetID = "different" }} {
		command := plan.Commands[0]
		edit(&command)
		invalid := plan
		invalid.Commands = []ChatCommand{command}
		if err := validateChatPlan(invalid, input); err == nil {
			t.Fatal("invented resource relation accepted")
		}
	}
	plan.Commands = append(plan.Commands, plan.Commands[0])
	if err := validateChatPlan(plan, input); err == nil {
		t.Fatal("second removal of the same relation accepted")
	}
	input.ResourceBindings = append(input.ResourceBindings, input.ResourceBindings[0])
	if _, _, err := prepareChat(input); err == nil {
		t.Fatal("duplicate resource relation catalog accepted")
	}
}

func TestChatResourceDeletionRetainsOnlyRelationsWithExistingTargets(t *testing.T) {
	input := syntheticChatInput()
	input.Nodes = append(input.Nodes, ChatCatalogNode{ID: "proxy", Kind: "proxy", Label: "代理"})
	input.ResourceBindings = []ResourceBinding{{ID: "uses-proxy", ResourceID: "proxy", TargetID: "a"}}
	plan := syntheticChatPlan()
	remove := ChatCommand{Op: "resource", ID: "uses-proxy", ResourceID: "proxy", TargetID: "a", Remove: true}
	plan.Commands = []ChatCommand{{Op: "delete", NodeIDs: []string{"proxy"}}, remove}
	if err := validateChatPlan(plan, input); err != nil {
		t.Fatal("deleted source relation was lost", err)
	}
	plan.Commands = []ChatCommand{{Op: "delete", NodeIDs: []string{"a"}}, remove}
	if err := validateChatPlan(plan, input); err == nil {
		t.Fatal("relation to deleted target remained removable")
	}
}
