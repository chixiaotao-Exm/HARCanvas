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

func overviewInput(count int) OverviewInput {
	input := OverviewInput{Goal: "根据元数据筛选待详细解读的关键请求", Requests: make([]OverviewRequest, count)}
	for i := range input.Requests {
		input.Requests[i] = OverviewRequest{ID: fmt.Sprintf("req-%d", i+1), Method: "GET", Domain: "example.test", Path: "/records", Category: "api", Status: 200, MimeType: "application/json"}
	}
	return input
}

func overviewResult(ids ...string) OverviewResult {
	result := OverviewResult{Summary: "仅据元数据推测这些请求值得进一步解读，尚未确认用途。", SelectedRequestIDs: []string{}, Reasons: []OverviewReason{}, Warnings: []string{}}
	for _, id := range ids {
		result.SelectedRequestIDs = append(result.SelectedRequestIDs, id)
		result.Reasons = append(result.Reasons, OverviewReason{RequestID: id, Reason: "依据方法与路径推测，需详细解读正文确认。"})
	}
	return result
}

func overviewCompletion(result OverviewResult) string {
	content, _ := json.Marshal(result)
	return overviewRawCompletion(string(content))
}

func overviewRawCompletion(content string) string {
	encoded, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": content}}}})
	return string(encoded)
}

func overviewJobInput(base string, input OverviewInput) string {
	encoded, _ := json.Marshal(map[string]any{"mode": "overview", "config": AgentConfig{BaseURL: base + "/v1", APIKey: "synthetic-private-overview-key", Model: "synthetic-overview-model"}, "overview": input})
	return string(encoded)
}

func TestPrepareOverviewEnforcesCountFieldsAndExactByteBudget(t *testing.T) {
	valid := overviewInput(1000)
	clean, _, err := prepareOverview(valid)
	if err != nil || len(clean.Requests) != 1000 {
		t.Fatal("1000 metadata requests were not preserved")
	}
	valid.Requests[0].Path = "/modified-after-copy"
	if clean.Requests[0].Path == valid.Requests[0].Path {
		t.Fatal("overview preparation retained a caller-owned request slice")
	}
	for _, test := range []struct {
		name string
		edit func(*OverviewInput)
	}{
		{"empty", func(v *OverviewInput) { v.Requests = nil }},
		{"1001 requests", func(v *OverviewInput) { *v = overviewInput(1001) }},
		{"duplicate ID", func(v *OverviewInput) { v.Requests = append(v.Requests, v.Requests[0]) }},
		{"invalid ID", func(v *OverviewInput) { v.Requests[0].ID = "invalid id" }},
		{"long ID", func(v *OverviewInput) { v.Requests[0].ID = strings.Repeat("x", 129) }},
		{"long goal", func(v *OverviewInput) { v.Goal = strings.Repeat("x", 16001) }},
		{"goal UTF8 bytes", func(v *OverviewInput) { v.Goal = strings.Repeat("字", 5334) }},
		{"invalid UTF8", func(v *OverviewInput) { v.Requests[0].Path = string([]byte{0xff}) }},
		{"blank method", func(v *OverviewInput) { v.Requests[0].Method = " \n " }},
		{"blank domain", func(v *OverviewInput) { v.Requests[0].Domain = "\t" }},
		{"negative status", func(v *OverviewInput) { v.Requests[0].Status = -1 }},
		{"oversized status", func(v *OverviewInput) { v.Requests[0].Status = 1000 }},
		{"long method", func(v *OverviewInput) { v.Requests[0].Method = strings.Repeat("x", 33) }},
		{"long domain", func(v *OverviewInput) { v.Requests[0].Domain = strings.Repeat("x", 513) }},
		{"long path", func(v *OverviewInput) { v.Requests[0].Path = strings.Repeat("x", 4097) }},
		{"long category", func(v *OverviewInput) { v.Requests[0].Category = strings.Repeat("x", 101) }},
		{"long mimeType", func(v *OverviewInput) { v.Requests[0].MimeType = strings.Repeat("x", 257) }},
		{"long page", func(v *OverviewInput) { v.Requests[0].PageID = strings.Repeat("x", 201) }},
		{"long start", func(v *OverviewInput) { v.Requests[0].StartedAt = strings.Repeat("x", 101) }},
	} {
		t.Run(test.name, func(t *testing.T) {
			input := overviewInput(1)
			test.edit(&input)
			if _, _, err := prepareOverview(input); err == nil || publicAnalysisError(err).Code != "invalid_overview" {
				t.Fatal("invalid or oversized metadata was accepted")
			}
		})
	}
	input := overviewInput(200)
	for i := range input.Requests {
		input.Requests[i].Path = ""
	}
	_, initial, _ := prepareOverview(input)
	remaining := overviewInputBytes - len(initial)
	for i := range input.Requests {
		count := min(4096, remaining)
		input.Requests[i].Path = strings.Repeat("x", count)
		remaining -= count
	}
	if remaining != 0 {
		t.Fatal("failed to construct aggregate boundary input")
	}
	if _, encoded, err := prepareOverview(input); err != nil || len(encoded) != overviewInputBytes {
		t.Fatal("exact 512 KiB metadata boundary was rejected")
	}
	input.Requests[len(input.Requests)-1].Path += "x"
	if _, _, err := prepareOverview(input); err == nil {
		t.Fatal("aggregate metadata budget was not enforced")
	}
}

func TestOverviewAcceptsExactFieldAndResultLimitsWithoutTruncation(t *testing.T) {
	input := OverviewInput{Goal: strings.Repeat("x", 16000), Requests: []OverviewRequest{{ID: strings.Repeat("a", 128), Method: strings.Repeat("m", 32), Domain: strings.Repeat("d", 512), Path: strings.Repeat("p", 4096), Category: strings.Repeat("c", 100), MimeType: strings.Repeat("t", 256), PageID: strings.Repeat("i", 200), StartedAt: strings.Repeat("s", 100)}}}
	clean, _, err := prepareOverview(input)
	if err != nil || clean.Goal != input.Goal || clean.Requests[0] != input.Requests[0] {
		t.Fatal("valid exact field boundaries were rejected or truncated")
	}
	requests := overviewInput(24).Requests
	result := overviewResult()
	result.Summary = strings.Repeat("x", 2000)
	for _, request := range requests {
		result.SelectedRequestIDs = append(result.SelectedRequestIDs, request.ID)
		result.Reasons = append(result.Reasons, OverviewReason{RequestID: request.ID, Reason: strings.Repeat("字", 200)})
	}
	for i := 0; i < 12; i++ {
		result.Warnings = append(result.Warnings, strings.Repeat("x", 1000))
	}
	if err := validateOverviewResult(result, requests); err != nil {
		t.Fatal("valid exact result boundaries were rejected")
	}
}

func TestOverviewJobRejectsInvalidInputBeforeAcquiringSlots(t *testing.T) {
	server := newJobTestServer(t)
	for _, test := range []string{
		`{"mode":"unknown"}`,
		`{"mode":"overview"}`,
		`{"mode":"overview","overview":null}`,
		overviewJobInput("https://8.8.8.8", overviewInput(0)),
		overviewJobInput("https://8.8.8.8", overviewInput(1001)),
	} {
		w := jobRequest(server, "POST", "/api/agent/jobs", test)
		if w.Code != http.StatusBadRequest || len(server.agentSlots) != 0 || len(server.jobs.items) != 0 {
			t.Fatal("invalid overview was queued or consumed a provider slot")
		}
	}
}

func TestOverviewJobSelectsFromAll470MetadataWithoutForwardingHARFields(t *testing.T) {
	var calls atomic.Int64
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var payload map[string]json.RawMessage
		if json.NewDecoder(r.Body).Decode(&payload) != nil || len(payload) != 3 || payload["model"] == nil || payload["messages"] == nil || payload["response_format"] == nil {
			t.Error("overview altered compatible provider payload fields")
		}
		var messages []struct{ Role, Content string }
		if json.Unmarshal(payload["messages"], &messages) != nil || len(messages) != 2 {
			t.Error("missing overview messages")
			return
		}
		if strings.Contains(messages[1].Content, "synthetic-HAR-secret") || !strings.Contains(messages[0].Content, "元数据推测") {
			t.Error("overview forwarded excluded HAR values or lost uncertainty guidance")
		}
		var metadata struct {
			Goal     string                       `json:"goal"`
			Requests []map[string]json.RawMessage `json:"requests"`
		}
		if json.Unmarshal([]byte(strings.TrimPrefix(messages[1].Content, "UNTRUSTED overview metadata:\n")), &metadata) != nil || len(metadata.Requests) != 470 {
			t.Error("overview silently omitted metadata requests")
		}
		for _, request := range metadata.Requests {
			for key := range request {
				if key != "id" && key != "method" && key != "domain" && key != "path" && key != "category" && key != "status" && key != "mimeType" && key != "pageId" && key != "startedAt" {
					t.Error("overview forwarded a non-whitelisted field")
				}
			}
		}
		_, _ = io.WriteString(w, overviewCompletion(overviewResult("req-1", "req-470")))
	}))
	defer provider.Close()
	var input map[string]any
	_ = json.Unmarshal([]byte(overviewJobInput(provider.URL, overviewInput(470))), &input)
	requests := input["overview"].(map[string]any)["requests"].([]any)
	for _, raw := range requests {
		request := raw.(map[string]any)
		for _, key := range []string{"url", "headers", "body", "responseBody", "responseHeaders", "query"} {
			request[key] = "synthetic-HAR-secret"
		}
	}
	input["requests"] = []map[string]any{{"id": "ignored", "body": "synthetic-HAR-secret"}}
	encoded, _ := json.Marshal(input)
	server := newJobTestServer(t)
	created := createTestJob(t, server, string(encoded))
	if created.Mode != "overview" {
		t.Fatal("overview create response lacks result discriminator")
	}
	view := waitJob(t, server, created.ID, "completed")
	waitJobSlots(t, server, 0)
	if calls.Load() != 1 || view.Mode != "overview" || view.Analysis != nil || view.Overview == nil || len(view.Overview.SelectedRequestIDs) != 2 || view.Overview.SelectedRequestIDs[1] != "req-470" || view.Progress == nil || view.Progress.Stage != "completed" || view.Progress.ContextBytes <= 0 || view.Progress.ResponseBytes <= 0 {
		t.Fatal("overview did not retain its independent verified result and actual progress")
	}
	w := jobRequest(server, "GET", "/api/agent/jobs/"+view.ID, "")
	for _, secret := range []string{"synthetic-HAR-secret", "synthetic-private-overview-key", "synthetic-overview-model", provider.URL} {
		if bytes.Contains(w.Body.Bytes(), []byte(secret)) {
			t.Fatal("overview status retained provider configuration or raw HAR data")
		}
	}
	if deleted := jobRequest(server, "DELETE", "/api/agent/jobs/"+view.ID, ""); deleted.Code != 200 || !bytes.Contains(deleted.Body.Bytes(), []byte(`"status":"completed"`)) {
		t.Fatal("completed overview was not immutable on delete")
	}
}

func TestOverviewStrictlyValidatesKnownIDsReasonsAndOutputBounds(t *testing.T) {
	for _, test := range []struct {
		name string
		edit func(*OverviewResult)
	}{
		{"missing summary", func(v *OverviewResult) { v.Summary = " \n " }},
		{"long summary", func(v *OverviewResult) { v.Summary = strings.Repeat("x", 2001) }},
		{"null selected", func(v *OverviewResult) { v.SelectedRequestIDs = nil }},
		{"unknown selected", func(v *OverviewResult) { v.SelectedRequestIDs[0] = "synthetic-unknown-secret" }},
		{"duplicate selected", func(v *OverviewResult) { v.SelectedRequestIDs = []string{"req-1", "req-1"} }},
		{"25 selected", func(v *OverviewResult) {
			*v = overviewResult()
			for i := 1; i <= 25; i++ {
				id := fmt.Sprintf("req-%d", i)
				v.SelectedRequestIDs = append(v.SelectedRequestIDs, id)
				v.Reasons = append(v.Reasons, OverviewReason{RequestID: id, Reason: "根据元数据推测"})
			}
		}},
		{"null reasons", func(v *OverviewResult) { v.Reasons = nil }},
		{"missing reason", func(v *OverviewResult) { v.Reasons = []OverviewReason{} }},
		{"unknown reason", func(v *OverviewResult) { v.Reasons[0].RequestID = "synthetic-unknown-secret" }},
		{"unselected reason", func(v *OverviewResult) { v.Reasons[0].RequestID = "req-2" }},
		{"extra reason", func(v *OverviewResult) { v.Reasons = append(v.Reasons, v.Reasons[0]) }},
		{"duplicate reason", func(v *OverviewResult) { *v = overviewResult("req-1", "req-2"); v.Reasons[1].RequestID = "req-1" }},
		{"blank reason", func(v *OverviewResult) { v.Reasons[0].Reason = " \t " }},
		{"long reason", func(v *OverviewResult) { v.Reasons[0].Reason = strings.Repeat("x", 601) }},
		{"null warnings", func(v *OverviewResult) { v.Warnings = nil }},
		{"13 warnings", func(v *OverviewResult) { v.Warnings = make([]string, 13) }},
		{"long warning", func(v *OverviewResult) { v.Warnings = []string{strings.Repeat("x", 1001)} }},
	} {
		t.Run(test.name, func(t *testing.T) {
			result := overviewResult("req-1")
			test.edit(&result)
			analyzer := NewAnalyzer()
			analyzer.Client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
				return jsonResponse(200, overviewCompletion(result), nil), nil
			})
			got, err := analyzer.AnalyzeOverview(context.Background(), AgentConfig{BaseURL: "https://8.8.8.8/v1", APIKey: "synthetic-key", Model: "synthetic-model"}, overviewInput(30), nil)
			if err == nil || publicAnalysisError(err).Code != "provider_analysis_invalid" || got.Summary != "" || strings.Contains(err.Error(), "synthetic-unknown-secret") {
				t.Fatal("invalid overview output was accepted or exposed arbitrary provider values")
			}
		})
	}
	valid := overviewResult()
	if err := validateOverviewResult(valid, overviewInput(1).Requests); err != nil {
		t.Fatal("valid empty selection was rejected")
	}
	valid = overviewResult("req-1", "req-2")
	valid.Reasons[0], valid.Reasons[1] = valid.Reasons[1], valid.Reasons[0]
	if err := validateOverviewResult(valid, overviewInput(2).Requests); err != nil {
		t.Fatal("valid exact reason correspondence required the same ordering")
	}
}

func TestOverviewEmptySelectionRemainsEmptyAndLegacyDetailIsCompatible(t *testing.T) {
	server := newJobTestServer(t)
	var calls atomic.Int64
	server.Analyzer.Client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		body, _ := io.ReadAll(r.Body)
		if bytes.Contains(body, []byte("UNTRUSTED overview metadata")) {
			return jsonResponse(200, overviewCompletion(overviewResult()), nil), nil
		}
		if !bytes.Contains(body, []byte("60–100")) || !bytes.Contains(body, []byte("最多2项")) || !bytes.Contains(body, []byte("最多3项")) {
			t.Error("detail prompt lacks compact purpose guidance")
		}
		return jsonResponse(200, mockJobCompletion(), nil), nil
	})
	created := createTestJob(t, server, overviewJobInput("https://8.8.8.8", overviewInput(470)))
	view := waitJob(t, server, created.ID, "completed")
	waitJobSlots(t, server, 0)
	if view.Overview == nil || len(view.Overview.SelectedRequestIDs) != 0 || len(view.Overview.Reasons) != 0 || view.Analysis != nil || calls.Load() != 1 {
		t.Fatal("empty overview selected requests, fabricated purposes, or launched full analysis")
	}
	for _, explicit := range []bool{false, true} {
		input := jobInput("https://8.8.8.8")
		if explicit {
			input = `{"mode":"detail",` + strings.TrimPrefix(input, "{")
		}
		created = createTestJob(t, server, input)
		view = waitJob(t, server, created.ID, "completed")
		waitJobSlots(t, server, 0)
		if view.Analysis == nil || view.Overview != nil || explicit && view.Mode != "detail" {
			t.Fatal("overview support changed existing detail job behavior")
		}
	}
}

func TestOverviewSharesSlotsAndCancelledResultCannotBeOverwritten(t *testing.T) {
	server := newJobTestServer(t)
	started := make(chan struct{}, 2)
	release := make(chan struct{})
	defer close(release)
	server.Analyzer.Client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if trace := httptrace.ContextClientTrace(r.Context()); trace != nil && trace.WroteRequest != nil {
			trace.WroteRequest(httptrace.WroteRequestInfo{})
		}
		started <- struct{}{}
		<-release
		return jsonResponse(200, overviewCompletion(overviewResult("req-1")), nil), nil
	})
	first := createTestJob(t, server, overviewJobInput("https://8.8.8.8", overviewInput(1)))
	second := createTestJob(t, server, jobInput("https://8.8.8.8"))
	<-started
	<-started
	waitAgentPhase(t, server, first.ID, "waiting_model")
	jobRequest(server, "DELETE", "/api/agent/jobs/"+first.ID, "")
	jobRequest(server, "DELETE", "/api/agent/jobs/"+second.ID, "")
	if len(server.agentSlots) != 2 {
		t.Fatal("overview cancellation released still-running provider slots")
	}
	for _, request := range []struct{ path, input string }{
		{"/api/agent/jobs", overviewJobInput("https://8.8.8.8", overviewInput(1))},
		{"/api/agent/jobs", jobInput("https://8.8.8.8")},
		{"/api/agent/analyze", jobInput("https://8.8.8.8")},
	} {
		if w := jobRequest(server, "POST", request.path, request.input); w.Code != 429 {
			t.Fatal("overview, detail, and synchronous jobs do not share two slots")
		}
	}
	release <- struct{}{}
	release <- struct{}{}
	waitJobSlots(t, server, 0)
	view := waitJob(t, server, first.ID, "cancelled")
	if view.Mode != "overview" || view.Overview != nil || view.Analysis != nil || view.Progress == nil || view.Progress.Stage != "waiting_model" {
		t.Fatal("late overview result or progress overwrote cancellation")
	}
}

func TestOverviewDetachesFromCreateRequestAndCancellationReachesProvider(t *testing.T) {
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
	r := httptest.NewRequest("POST", "/api/agent/jobs", strings.NewReader(overviewJobInput(provider.URL, overviewInput(1)))).WithContext(ctx)
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	server.ServeHTTP(w, r)
	if w.Code != 202 {
		t.Fatal("overview creation failed")
	}
	var created AgentJobView
	_ = json.Unmarshal(w.Body.Bytes(), &created)
	cancel()
	<-started
	if view, _ := server.jobs.get(created.ID); view.Status != "running" || view.Mode != "overview" {
		t.Fatal("create request cancellation stopped detached overview")
	}
	if w := jobRequest(server, "DELETE", "/api/agent/jobs/"+created.ID, ""); w.Code != 200 {
		t.Fatal("overview cancellation failed")
	}
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("overview cancellation did not reach real provider")
	}
	waitJobSlots(t, server, 0)
	view := waitJob(t, server, created.ID, "cancelled")
	if view.Overview != nil || view.Analysis != nil {
		t.Fatal("cancelled overview retained a result")
	}
}

func TestOverviewTimeoutFailureAndLogsStaySanitized(t *testing.T) {
	for _, status := range []int{0, 401} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.Copy(io.Discard, r.Body)
				if status != 0 {
					w.WriteHeader(status)
					_, _ = io.WriteString(w, "synthetic-provider-secret")
					return
				}
				w.WriteHeader(200)
				w.(http.Flusher).Flush()
				<-r.Context().Done()
			}))
			defer provider.Close()
			server := newJobTestServer(t)
			server.Analyzer = NewAnalyzerWithTimeout(40 * time.Millisecond)
			var logs synchronizedAgentLog
			previous := log.Writer()
			log.SetOutput(&logs)
			defer log.SetOutput(previous)
			input := overviewInput(1)
			input.Goal = "synthetic-private-overview-goal"
			input.Requests[0].Path = "/synthetic-private-overview-path"
			created := createTestJob(t, server, overviewJobInput(provider.URL, input))
			view := waitJob(t, server, created.ID, "failed")
			waitJobSlots(t, server, 0)
			wantCode := "timeout"
			if status != 0 {
				wantCode = "provider_http_error"
			}
			if view.ErrorCode != wantCode || view.Overview != nil || view.Analysis != nil || status == 0 && (view.Progress == nil || view.Progress.Stage != "reading_response") {
				t.Fatal("overview failure lost controlled classification or actual phase")
			}
			text := logs.String() + view.Error
			for _, forbidden := range []string{provider.URL, input.Goal, input.Requests[0].Path, "synthetic-private-overview-key", "synthetic-overview-model", "synthetic-provider-secret"} {
				if strings.Contains(text, forbidden) {
					t.Fatal("overview diagnostic exposed metadata or provider secrets")
				}
			}
		})
	}
}
