package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func repairInput(count int) RepairInput {
	input := RepairInput{Goal: "解释待核对项并提出输入问题，不执行流程", Nodes: make([]RepairNode, count)}
	for i := range input.Nodes {
		node := RepairNode{ID: fmt.Sprintf("node-%d", i), Label: "测试步骤", Kind: "request", Readiness: "missing-input", Issues: []string{"REVIEW_REQUIRED"}, Fields: []RepairField{{ID: "field-user", Target: "body", Path: "user.email", ValueType: "string"}, {ID: "field-manual", Target: "header", Path: "X-Input", ValueType: "string"}, {ID: "field-upstream", Target: "query", Path: "itemId", ValueType: "string"}}, Sources: []RepairSource{}}
		if i == 0 {
			node.Readiness = "ready"
			node.Issues = []string{}
		} else {
			node.Sources = []RepairSource{{ID: "source-item", FieldID: "field-upstream", SourceNodeID: "node-0", SourcePath: "body.data.id", Evidence: "录制时来源字段与目标字段字符串一致；仍需核对有效期。"}}
		}
		if i == 2 {
			node.Readiness = "unsupported"
		}
		input.Nodes[i] = node
	}
	return input
}

func repairPlan(input RepairInput) RepairPlan {
	plan := RepairPlan{Summary: "这是待核对的输入与绑定草稿，未改变就绪状态，也未运行流程。", Questions: []RepairQuestion{}, Bindings: []RepairBinding{}, Notes: []RepairNote{}, Warnings: []string{}}
	for _, node := range input.Nodes {
		if node.Readiness != "ready" {
			kind := "review"
			if node.Readiness == "unsupported" {
				kind = "unsupported"
			}
			plan.Notes = append(plan.Notes, RepairNote{NodeID: node.ID, Title: "需要人工核对", Message: "输入不能自动修复浏览器环境或动态签名限制，请核对支持范围，保持当前就绪状态。", Kind: kind})
		}
		if node.Readiness != "ready" && node.Readiness != "unsupported" {
			if len(plan.Questions) == 0 {
				plan.Questions = append(plan.Questions, RepairQuestion{ID: "question-email", Title: "联系邮箱", Help: "在本页填写，此答案不回传模型。", Placeholder: "填写邮箱地址", Required: true})
			}
			plan.Bindings = append(plan.Bindings, RepairBinding{NodeID: node.ID, FieldID: "field-user", Mode: "user", QuestionID: "question-email", Reason: "由用户提供现有正文字符串字段。"})
		}
	}
	if len(input.Nodes) > 1 {
		plan.Bindings = append(plan.Bindings, RepairBinding{NodeID: "node-1", FieldID: "field-manual", Mode: "manual", Reason: "保留人工填写与核对。"}, RepairBinding{NodeID: "node-1", FieldID: "field-upstream", Mode: "upstream", SourceID: "source-item", Reason: "仅使用目录中已记录匹配的来源，重放前仍需核对。"})
	}
	return plan
}

func repairJobInput(base string, input RepairInput) string {
	encoded, _ := json.Marshal(map[string]any{"mode": "repair", "config": AgentConfig{BaseURL: base + "/v1", APIKey: "synthetic-private-repair-key", Model: "synthetic-repair-model"}, "repair": input})
	return string(encoded)
}

func repairCompletion(plan RepairPlan) string {
	content, _ := json.Marshal(plan)
	return overviewRawCompletion(string(content))
}

func TestPrepareRepairRejectsInvalidCapabilitiesAndUnsafePaths(t *testing.T) {
	for _, test := range []struct {
		name string
		edit func(*RepairInput)
	}{
		{"empty nodes", func(v *RepairInput) { v.Nodes = nil }},
		{"101 nodes", func(v *RepairInput) { *v = repairInput(101) }},
		{"duplicate node", func(v *RepairInput) { v.Nodes[1].ID = v.Nodes[0].ID }},
		{"invalid node ID", func(v *RepairInput) { v.Nodes[0].ID = "node.with.dot" }},
		{"unknown kind", func(v *RepairInput) { v.Nodes[0].Kind = "script" }},
		{"unknown readiness", func(v *RepairInput) { v.Nodes[0].Readiness = "automatically-ready" }},
		{"long goal", func(v *RepairInput) { v.Goal = strings.Repeat("x", 16001) }},
		{"long label", func(v *RepairInput) { v.Nodes[0].Label = strings.Repeat("x", 401) }},
		{"long description", func(v *RepairInput) { v.Nodes[0].Description = strings.Repeat("x", 4001) }},
		{"long uncertainty", func(v *RepairInput) { v.Nodes[0].Uncertainty = strings.Repeat("x", 4001) }},
		{"invalid UTF8", func(v *RepairInput) { v.Nodes[0].Label = string([]byte{0xff}) }},
		{"31 issues", func(v *RepairInput) { v.Nodes[0].Issues = make([]string, 31) }},
		{"invalid issue", func(v *RepairInput) { v.Nodes[0].Issues = []string{"not a short code"} }},
		{"81 fields", func(v *RepairInput) { v.Nodes[0].Fields = make([]RepairField, 81) }},
		{"81 sources", func(v *RepairInput) { v.Nodes[0].Sources = make([]RepairSource, 81) }},
		{"duplicate field", func(v *RepairInput) { v.Nodes[0].Fields[1].ID = "field-user" }},
		{"duplicate target", func(v *RepairInput) { v.Nodes[0].Fields[1].Target = "body"; v.Nodes[0].Fields[1].Path = "user.email" }},
		{"duplicate header case", func(v *RepairInput) { v.Nodes[0].Fields[0].Target = "header"; v.Nodes[0].Fields[0].Path = "x-input" }},
		{"numeric field", func(v *RepairInput) { v.Nodes[0].Fields[0].ValueType = "number" }},
		{"whole URL", func(v *RepairInput) { v.Nodes[0].Fields[0].Target = "url" }},
		{"whole body", func(v *RepairInput) { v.Nodes[0].Fields[0].Path = "" }},
		{"prototype path", func(v *RepairInput) { v.Nodes[0].Fields[0].Path = "__proto__.email" }},
		{"empty segment", func(v *RepairInput) { v.Nodes[0].Fields[0].Path = "user..email" }},
		{"template path", func(v *RepairInput) { v.Nodes[0].Fields[0].Path = "user.{{value}}" }},
		{"bracket path", func(v *RepairInput) { v.Nodes[0].Fields[0].Path = "user[0].email" }},
		{"long path", func(v *RepairInput) { v.Nodes[0].Fields[0].Path = strings.Repeat("p", 1025) }},
		{"system header", func(v *RepairInput) { v.Nodes[0].Fields[1].Path = "Content-Length" }},
		{"header newline", func(v *RepairInput) { v.Nodes[0].Fields[1].Path = "X-Input\r\nOther" }},
		{"empty query", func(v *RepairInput) { v.Nodes[0].Fields[2].Path = "" }},
		{"nonrequest fields", func(v *RepairInput) { v.Nodes[0].Kind = "input" }},
		{"duplicate source", func(v *RepairInput) { v.Nodes[1].Sources = append(v.Nodes[1].Sources, v.Nodes[1].Sources[0]) }},
		{"source field unknown", func(v *RepairInput) { v.Nodes[1].Sources[0].FieldID = "unknown" }},
		{"source node unknown", func(v *RepairInput) { v.Nodes[1].Sources[0].SourceNodeID = "unknown" }},
		{"source self", func(v *RepairInput) { v.Nodes[1].Sources[0].SourceNodeID = "node-1" }},
		{"source nonrequest", func(v *RepairInput) { v.Nodes[0].Kind = "input"; v.Nodes[0].Fields = nil }},
		{"source URL", func(v *RepairInput) { v.Nodes[1].Sources[0].SourcePath = "url" }},
		{"source prototype", func(v *RepairInput) { v.Nodes[1].Sources[0].SourcePath = "body.constructor.name" }},
		{"source empty header", func(v *RepairInput) { v.Nodes[1].Sources[0].SourcePath = "headers." }},
		{"source dotted header", func(v *RepairInput) { v.Nodes[1].Sources[0].SourcePath = "headers.X.Meta" }},
		{"blank evidence", func(v *RepairInput) { v.Nodes[1].Sources[0].Evidence = " \t " }},
		{"long evidence", func(v *RepairInput) { v.Nodes[1].Sources[0].Evidence = strings.Repeat("x", 1001) }},
	} {
		t.Run(test.name, func(t *testing.T) {
			input := repairInput(3)
			test.edit(&input)
			if _, _, err := prepareRepair(input); err == nil || publicAnalysisError(err).Code != "invalid_repair" {
				t.Fatal("invalid repair capability was accepted")
			}
		})
	}
}

func TestPrepareRepairCopiesWhitelistAndEnforcesExactByteBudget(t *testing.T) {
	input := repairInput(100)
	for i := range input.Nodes {
		input.Nodes[i].Description = ""
		input.Nodes[i].Uncertainty = ""
	}
	_, initial, err := prepareRepair(input)
	if err != nil {
		t.Fatal("valid 100-node catalog was rejected")
	}
	remaining := repairInputBytes - len(initial)
	for i := range input.Nodes {
		count := min(4000, remaining)
		input.Nodes[i].Description = strings.Repeat("x", count)
		remaining -= count
		count = min(4000, remaining)
		input.Nodes[i].Uncertainty = strings.Repeat("x", count)
		remaining -= count
	}
	clean, encoded, err := prepareRepair(input)
	if remaining != 0 || err != nil || len(encoded) != repairInputBytes {
		t.Fatal("exact 512 KiB repair catalog boundary was not preserved")
	}
	input.Nodes[0].Fields[0].Path = "changed"
	input.Nodes[1].Sources[0].Evidence = "changed"
	input.Nodes[1].Issues[0] = "changed"
	if clean.Nodes[0].Fields[0].Path == "changed" || clean.Nodes[1].Sources[0].Evidence == "changed" || clean.Nodes[1].Issues[0] == "changed" {
		t.Fatal("repair preparation retained caller-owned slices")
	}
	clean.Nodes[len(clean.Nodes)-1].Uncertainty += "x"
	if _, _, err := prepareRepair(clean); err == nil {
		t.Fatal("repair aggregate metadata byte budget was not enforced")
	}
}

func TestRepairJobRejectsInvalidInputBeforeAcquiringSlots(t *testing.T) {
	server := newJobTestServer(t)
	for _, input := range []string{`{"mode":"repair"}`, `{"mode":"repair","repair":null}`, repairJobInput("https://8.8.8.8", repairInput(0)), repairJobInput("https://8.8.8.8", repairInput(101))} {
		w := jobRequest(server, "POST", "/api/agent/jobs", input)
		if w.Code != 400 || len(server.agentSlots) != 0 || len(server.jobs.items) != 0 {
			t.Fatal("invalid repair input created a job or acquired a provider slot")
		}
	}
}

func TestRepairJobUses16NodeValueFreeCatalogAndSeparateVerifiedPlan(t *testing.T) {
	fixture := repairInput(16)
	var calls atomic.Int64
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var payload map[string]json.RawMessage
		if json.NewDecoder(r.Body).Decode(&payload) != nil || len(payload) != 3 || payload["model"] == nil || payload["messages"] == nil || payload["response_format"] == nil {
			t.Error("repair changed the compatible provider payload")
		}
		var messages []struct{ Role, Content string }
		if json.Unmarshal(payload["messages"], &messages) != nil || len(messages) != 2 {
			t.Error("repair messages are missing")
			return
		}
		if strings.Contains(messages[1].Content, "synthetic-private-answer") || !strings.Contains(messages[0].Content, "不得返回readiness") {
			t.Error("repair leaked values or lost the no-readiness-mutation guidance")
		}
		var metadata RepairInput
		if json.Unmarshal([]byte(strings.TrimPrefix(messages[1].Content, "UNTRUSTED repair capability catalog:\n")), &metadata) != nil || len(metadata.Nodes) != 16 {
			t.Error("repair silently changed the node catalog")
		}
		_, _ = io.WriteString(w, repairCompletion(repairPlan(fixture)))
	}))
	defer provider.Close()
	var input map[string]any
	_ = json.Unmarshal([]byte(repairJobInput(provider.URL, fixture)), &input)
	repair := input["repair"].(map[string]any)
	repair["answers"] = map[string]string{"question-email": "synthetic-private-answer"}
	for _, raw := range repair["nodes"].([]any) {
		node := raw.(map[string]any)
		for _, field := range []string{"url", "headers", "body", "responseBody", "values"} {
			node[field] = "synthetic-private-answer"
		}
		for _, rawField := range node["fields"].([]any) {
			rawField.(map[string]any)["value"] = "synthetic-private-answer"
		}
	}
	encoded, _ := json.Marshal(input)
	server := newJobTestServer(t)
	created := createTestJob(t, server, string(encoded))
	if created.Mode != "repair" {
		t.Fatal("repair create response lacks the mode discriminator")
	}
	view := waitJob(t, server, created.ID, "completed")
	waitJobSlots(t, server, 0)
	if view.Mode != "repair" || view.Repair == nil || len(view.Repair.Questions) != 1 || len(view.Repair.Bindings) != 16 || view.Analysis != nil || view.Overview != nil || view.Progress == nil || view.Progress.Stage != "completed" || view.Progress.ContextBytes <= 0 || view.Progress.ResponseBytes <= 0 || calls.Load() != 1 {
		t.Fatal("repair failed to preserve its verified independent plan and actual progress")
	}
	w := jobRequest(server, "GET", "/api/agent/jobs/"+view.ID, "")
	for _, secret := range []string{"synthetic-private-answer", "synthetic-private-repair-key", "synthetic-repair-model", provider.URL} {
		if bytes.Contains(w.Body.Bytes(), []byte(secret)) {
			t.Fatal("repair polling exposed field values or provider configuration")
		}
	}
	if fixture.Nodes[1].Readiness != "missing-input" || fixture.Nodes[2].Readiness != "unsupported" {
		t.Fatal("repair changed the source canvas readiness")
	}
}

func TestRepairPlanRejectsUnknownCapabilitiesConflictsAndStateBypasses(t *testing.T) {
	for _, test := range []struct {
		name string
		edit func(*RepairPlan, *RepairInput)
	}{
		{"blank summary", func(v *RepairPlan, _ *RepairInput) { v.Summary = " \t " }},
		{"large summary", func(v *RepairPlan, _ *RepairInput) { v.Summary = strings.Repeat("x", 2001) }},
		{"null questions", func(v *RepairPlan, _ *RepairInput) { v.Questions = nil }},
		{"33 questions", func(v *RepairPlan, _ *RepairInput) { v.Questions = make([]RepairQuestion, 33) }},
		{"duplicate question", func(v *RepairPlan, _ *RepairInput) { v.Questions = append(v.Questions, v.Questions[0]) }},
		{"invalid question ID", func(v *RepairPlan, _ *RepairInput) { v.Questions[0].ID = "question.with.dot" }},
		{"prototype question ID", func(v *RepairPlan, _ *RepairInput) {
			v.Questions[0].ID = "__proto__"
			v.Bindings[0].QuestionID = "__proto__"
		}},
		{"constructor question ID", func(v *RepairPlan, _ *RepairInput) {
			v.Questions[0].ID = "constructor"
			v.Bindings[0].QuestionID = "constructor"
		}},
		{"prototype name question ID", func(v *RepairPlan, _ *RepairInput) {
			v.Questions[0].ID = "prototype"
			v.Bindings[0].QuestionID = "prototype"
		}},
		{"blank title", func(v *RepairPlan, _ *RepairInput) { v.Questions[0].Title = "" }},
		{"large title", func(v *RepairPlan, _ *RepairInput) { v.Questions[0].Title = strings.Repeat("x", 201) }},
		{"large help", func(v *RepairPlan, _ *RepairInput) { v.Questions[0].Help = strings.Repeat("x", 1001) }},
		{"large placeholder", func(v *RepairPlan, _ *RepairInput) { v.Questions[0].Placeholder = strings.Repeat("x", 301) }},
		{"unused question", func(v *RepairPlan, _ *RepairInput) {
			v.Questions = append(v.Questions, RepairQuestion{ID: "unused", Title: "Unused"})
		}},
		{"null bindings", func(v *RepairPlan, _ *RepairInput) { v.Bindings = nil }},
		{"101 bindings", func(v *RepairPlan, _ *RepairInput) { v.Bindings = make([]RepairBinding, 101) }},
		{"unknown node", func(v *RepairPlan, _ *RepairInput) { v.Bindings[0].NodeID = "synthetic-unknown-private" }},
		{"unknown field", func(v *RepairPlan, _ *RepairInput) { v.Bindings[0].FieldID = "synthetic-unknown-private" }},
		{"existing binding", func(_ *RepairPlan, v *RepairInput) { v.Nodes[1].Fields[0].ExistingBinding = true }},
		{"duplicate target", func(v *RepairPlan, _ *RepairInput) { v.Bindings = append(v.Bindings, v.Bindings[0]) }},
		{"unsupported binding", func(v *RepairPlan, _ *RepairInput) { v.Bindings[0].NodeID = "node-2" }},
		{"blank reason", func(v *RepairPlan, _ *RepairInput) { v.Bindings[0].Reason = "" }},
		{"large reason", func(v *RepairPlan, _ *RepairInput) { v.Bindings[0].Reason = strings.Repeat("x", 1001) }},
		{"runtime mode", func(v *RepairPlan, _ *RepairInput) { v.Bindings[0].Mode = "runtime" }},
		{"user missing question", func(v *RepairPlan, _ *RepairInput) { v.Bindings[0].QuestionID = "unknown" }},
		{"user with source", func(v *RepairPlan, _ *RepairInput) { v.Bindings[0].SourceID = "source-item" }},
		{"manual with question", func(v *RepairPlan, _ *RepairInput) { v.Bindings[1].QuestionID = "question-email" }},
		{"manual with source", func(v *RepairPlan, _ *RepairInput) { v.Bindings[1].SourceID = "source-item" }},
		{"upstream with question", func(v *RepairPlan, _ *RepairInput) { v.Bindings[2].QuestionID = "question-email" }},
		{"upstream unknown source", func(v *RepairPlan, _ *RepairInput) { v.Bindings[2].SourceID = "unknown" }},
		{"upstream wrong field", func(v *RepairPlan, _ *RepairInput) {
			v.Bindings = v.Bindings[:1]
			v.Bindings[0].Mode = "upstream"
			v.Bindings[0].QuestionID = ""
			v.Bindings[0].SourceID = "source-item"
			v.Questions = []RepairQuestion{}
		}},
		{"null notes", func(v *RepairPlan, _ *RepairInput) { v.Notes = nil }},
		{"101 notes", func(v *RepairPlan, _ *RepairInput) { v.Notes = make([]RepairNote, 101) }},
		{"unknown note node", func(v *RepairPlan, _ *RepairInput) { v.Notes[0].NodeID = "unknown" }},
		{"missing coverage", func(v *RepairPlan, _ *RepairInput) { v.Notes = v.Notes[1:] }},
		{"unsupported missing typed note", func(v *RepairPlan, _ *RepairInput) { v.Notes[1].Kind = "review" }},
		{"unknown note kind", func(v *RepairPlan, _ *RepairInput) { v.Notes[0].Kind = "ready" }},
		{"blank note message", func(v *RepairPlan, _ *RepairInput) { v.Notes[0].Message = " \n " }},
		{"long note message", func(v *RepairPlan, _ *RepairInput) { v.Notes[0].Message = strings.Repeat("x", 2001) }},
		{"null warnings", func(v *RepairPlan, _ *RepairInput) { v.Warnings = nil }},
		{"13 warnings", func(v *RepairPlan, _ *RepairInput) { v.Warnings = make([]string, 13) }},
		{"long warning", func(v *RepairPlan, _ *RepairInput) { v.Warnings = []string{strings.Repeat("x", 1001)} }},
	} {
		t.Run(test.name, func(t *testing.T) {
			input := repairInput(3)
			plan := repairPlan(input)
			test.edit(&plan, &input)
			if err := validateRepairPlan(plan, input); err == nil || publicAnalysisError(err).Code != "provider_analysis_invalid" || strings.Contains(err.Error(), "synthetic-unknown-private") {
				t.Fatal("unsafe repair plan was accepted or echoed model data")
			}
		})
	}
	input := repairInput(1)
	if err := validateRepairPlan(repairPlan(input), input); err != nil {
		t.Fatal("valid all-ready empty plan was rejected")
	}
	input = repairInput(16)
	if err := validateRepairPlan(repairPlan(input), input); err != nil {
		t.Fatal("valid 16-node plan with shared question and allowed sources was rejected")
	}
}

func TestRepairStrictJSONRejectsUnknownPatchesAndMissingRequiredBoolean(t *testing.T) {
	valid, _ := json.Marshal(repairPlan(repairInput(3)))
	for _, content := range []string{
		`not-json synthetic-private-provider-value`,
		string(valid) + `{}`,
		`{"readiness":"ready",` + strings.TrimPrefix(string(valid), "{"),
		strings.Replace(string(valid), `"mode":"user"`, `"mode":"user","path":"body.arbitrary"`, 1),
		strings.Replace(string(valid), `"required":true`, `"required":null`, 1),
		strings.Replace(string(valid), `"required":true`, `"required":"yes"`, 1),
		strings.Replace(string(valid), `,"required":true`, "", 1),
		strings.Replace(string(valid), `"kind":"review"`, `"kind":"review","code":"execute()"`, 1),
	} {
		if _, err := decodeRepairPlan(content); err == nil || strings.Contains(err.Error(), "synthetic-private-provider-value") {
			t.Fatal("unknown repair patch, invalid JSON, or missing boolean was accepted or echoed")
		}
	}
	if _, err := decodeRepairPlan(string(valid)); err != nil {
		t.Fatal("valid strict repair JSON was rejected")
	}
}

func TestRepairSharesSlotsAndLateResultsCannotOverrideCancellation(t *testing.T) {
	server := newJobTestServer(t)
	started, release := make(chan struct{}, 2), make(chan struct{})
	defer close(release)
	server.Analyzer.Client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if trace := httptrace.ContextClientTrace(r.Context()); trace != nil && trace.WroteRequest != nil {
			trace.WroteRequest(httptrace.WroteRequestInfo{})
		}
		started <- struct{}{}
		<-release
		return jsonResponse(200, repairCompletion(repairPlan(repairInput(3))), nil), nil
	})
	first := createTestJob(t, server, repairJobInput("https://8.8.8.8", repairInput(3)))
	second := createTestJob(t, server, overviewJobInput("https://8.8.8.8", overviewInput(1)))
	<-started
	<-started
	waitAgentPhase(t, server, first.ID, "waiting_model")
	jobRequest(server, "DELETE", "/api/agent/jobs/"+first.ID, "")
	jobRequest(server, "DELETE", "/api/agent/jobs/"+second.ID, "")
	if len(server.agentSlots) != 2 {
		t.Fatal("repair cancellation released slots before actual worker exit")
	}
	for _, request := range []struct{ path, input string }{{"/api/agent/jobs", repairJobInput("https://8.8.8.8", repairInput(3))}, {"/api/agent/jobs", jobInput("https://8.8.8.8")}, {"/api/agent/analyze", jobInput("https://8.8.8.8")}} {
		if w := jobRequest(server, "POST", request.path, request.input); w.Code != 429 {
			t.Fatal("repair did not share the existing two provider slots")
		}
	}
	release <- struct{}{}
	release <- struct{}{}
	waitJobSlots(t, server, 0)
	view := waitJob(t, server, first.ID, "cancelled")
	if view.Mode != "repair" || view.Repair != nil || view.Analysis != nil || view.Overview != nil || view.Progress == nil || view.Progress.Stage != "waiting_model" {
		t.Fatal("late repair result or progress replaced cancellation")
	}
}

func TestRepairDetachedCreateAndCancellationReachRealProvider(t *testing.T) {
	started, cancelled := make(chan struct{}), make(chan struct{})
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		close(started)
		select {
		case <-r.Context().Done():
			close(cancelled)
		case <-time.After(2 * time.Second):
		}
	}))
	defer provider.Close()
	server := newJobTestServer(t)
	ctx, cancel := context.WithCancel(context.Background())
	r := httptest.NewRequest("POST", "/api/agent/jobs", strings.NewReader(repairJobInput(provider.URL, repairInput(3)))).WithContext(ctx)
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	server.ServeHTTP(w, r)
	if w.Code != 202 {
		t.Fatal("repair job creation failed")
	}
	var created AgentJobView
	_ = json.Unmarshal(w.Body.Bytes(), &created)
	cancel()
	<-started
	if view, _ := server.jobs.get(created.ID); view.Status != "running" {
		t.Fatal("HTTP create cancellation stopped the detached repair job")
	}
	jobRequest(server, "DELETE", "/api/agent/jobs/"+created.ID, "")
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("repair cancellation did not reach the actual provider")
	}
	waitJobSlots(t, server, 0)
	view := waitJob(t, server, created.ID, "cancelled")
	if view.Repair != nil {
		t.Fatal("cancelled repair retained a plan")
	}
}

func TestRepairProviderFailuresHaveSafeErrorsAndBoundedResponses(t *testing.T) {
	for _, test := range []struct {
		name, code string
		status     int
		body       string
	}{
		{"HTTP failure", "provider_http_error", 401, "synthetic-private-provider-message"},
		{"invalid completion", "provider_response_invalid", 200, "synthetic-private-provider-message"},
		{"invalid repair JSON", "provider_analysis_invalid", 200, overviewRawCompletion(`{"summary":"synthetic-private-provider-message","questions":`)},
		{"256 KiB provider limit", "analysis_limit", 200, strings.Repeat("x", (256<<10)+1)},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := newJobTestServer(t)
			server.Analyzer.Client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
				return jsonResponse(test.status, test.body, nil), nil
			})
			var logs synchronizedAgentLog
			previous := log.Writer()
			log.SetOutput(&logs)
			defer log.SetOutput(previous)
			input := repairInput(3)
			input.Goal = "synthetic-private-repair-goal"
			input.Nodes[1].Description = "synthetic-private-repair-description"
			created := createTestJob(t, server, repairJobInput("https://8.8.8.8", input))
			view := waitJob(t, server, created.ID, "failed")
			waitJobSlots(t, server, 0)
			if view.ErrorCode != test.code || view.Error == "" || view.Repair != nil || view.Analysis != nil || view.Overview != nil || view.Progress == nil || test.code == "analysis_limit" && view.Progress.ResponseBytes != (256<<10)+1 {
				t.Fatal("repair failure lost safe classification or provider response bound")
			}
			text := logs.String() + view.Error
			for _, secret := range []string{"synthetic-private-provider-message", input.Goal, input.Nodes[1].Description, "synthetic-private-repair-key", "synthetic-repair-model"} {
				if strings.Contains(text, secret) {
					t.Fatal("repair diagnostics exposed model content or configuration")
				}
			}
		})
	}
}

func TestRepairTimeoutKeepsRealResponseStage(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer provider.Close()
	server := newJobTestServer(t)
	server.Analyzer = NewAnalyzerWithTimeout(40 * time.Millisecond)
	created := createTestJob(t, server, repairJobInput(provider.URL, repairInput(3)))
	view := waitJob(t, server, created.ID, "failed")
	waitJobSlots(t, server, 0)
	if view.ErrorCode != "timeout" || view.Repair != nil || view.Progress == nil || view.Progress.Stage != "reading_response" {
		t.Fatal("repair timeout lost the actual provider phase")
	}
}
