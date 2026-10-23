package app

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func mockJobCompletion() string {
	content := `{"summary":"测试用途分析","suggestions":[{"requestId":"req-1","label":"查询商品详情","description":"输入来自请求路径中的商品编号，响应提供商品信息；此为测试模型，真实接口未验证。","category":"api","confidence":"high","dependencies":[],"variables":[]}],"warnings":[]}`
	encoded, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": content}}}})
	return string(encoded)
}

func newJobTestServer(t *testing.T) *Server {
	t.Helper()
	server := NewServer(t.TempDir())
	t.Cleanup(func() {
		server.jobs.mu.Lock()
		cancels := []context.CancelFunc{}
		for _, job := range server.jobs.items {
			if job.cancel != nil {
				cancels = append(cancels, job.cancel)
			}
		}
		server.jobs.mu.Unlock()
		for _, cancel := range cancels {
			cancel()
		}
		deadline := time.Now().Add(time.Second)
		for len(server.agentSlots) > 0 && time.Now().Before(deadline) {
			time.Sleep(time.Millisecond)
		}
		server.jobs.mu.Lock()
		if server.jobs.expiry != nil {
			server.jobs.expiry.Stop()
		}
		server.jobs.items = map[string]*agentJob{}
		server.jobs.mu.Unlock()
	})
	return server
}

func jobInput(base string) string {
	encoded, _ := json.Marshal(map[string]any{"config": AgentConfig{BaseURL: base + "/v1", APIKey: "private-model-key", Model: "mock-model"}, "requests": []Request{{ID: "req-1", Method: "GET", URL: "https://example.com/private-record", Headers: map[string]string{"Cookie": "private-HAR-cookie"}, Body: "private-HAR-body"}}})
	return string(encoded)
}

func jobRequest(server *Server, method, path, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	server.ServeHTTP(w, r)
	return w
}

func createTestJob(t *testing.T, server *Server, input string) AgentJobView {
	t.Helper()
	w := jobRequest(server, "POST", "/api/agent/jobs", input)
	if w.Code != 202 {
		t.Fatalf("create returned %d", w.Code)
	}
	var view AgentJobView
	if err := json.Unmarshal(w.Body.Bytes(), &view); err != nil {
		t.Fatal(err)
	}
	if !agentJobID.MatchString(view.ID) || view.Status != "running" {
		t.Fatal("job creation did not return opaque running ID")
	}
	return view
}

func waitJob(t *testing.T, server *Server, id, status string) AgentJobView {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		view, exists := server.jobs.get(id)
		if exists && view.Status == status {
			return view
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("job did not become %s", status)
	return AgentJobView{}
}

func waitJobSlots(t *testing.T, server *Server, count int) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if len(server.agentSlots) == count {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("slot count=%d want=%d", len(server.agentSlots), count)
}

func TestAgentJobSurvivesCreateRequestAndReturnsAnalysis(t *testing.T) {
	release := make(chan struct{})
	started := make(chan struct{})
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		close(started)
		select {
		case <-release:
			_, _ = io.WriteString(w, mockJobCompletion())
		case <-r.Context().Done():
		}
	}))
	defer provider.Close()
	server := newJobTestServer(t)
	ctx, cancel := context.WithCancel(context.Background())
	r := httptest.NewRequest("POST", "/api/agent/jobs", strings.NewReader(jobInput(provider.URL))).WithContext(ctx)
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	server.ServeHTTP(w, r)
	if w.Code != 202 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("create returned %d", w.Code)
	}
	var created AgentJobView
	_ = json.Unmarshal(w.Body.Bytes(), &created)
	cancel()
	<-started
	if view, _ := server.jobs.get(created.ID); view.Status != "running" {
		t.Fatal("create request cancellation stopped a detached job")
	}
	close(release)
	view := waitJob(t, server, created.ID, "completed")
	if view.Analysis == nil || len(view.Analysis.Suggestions) != 1 || view.Analysis.Suggestions[0].Label != "查询商品详情" {
		t.Fatal("completed job did not preserve real mock provider analysis")
	}
	w = jobRequest(server, "GET", "/api/agent/jobs/"+created.ID, "")
	for _, secret := range []string{"private-model-key", "private-HAR-cookie", "private-HAR-body", provider.URL} {
		if bytes.Contains(w.Body.Bytes(), []byte(secret)) {
			t.Fatal("job status exposed stored configuration or HAR data")
		}
	}
	w = jobRequest(server, "DELETE", "/api/agent/jobs/"+created.ID, "")
	var terminal AgentJobView
	_ = json.Unmarshal(w.Body.Bytes(), &terminal)
	if terminal.Status != "completed" {
		t.Fatal("deleting a completed job changed its terminal result")
	}
}

func TestAgentJobCancellationReachesRealLocalProvider(t *testing.T) {
	started := make(chan struct{})
	cancelled := make(chan struct{})
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
	created := createTestJob(t, server, jobInput(provider.URL))
	<-started
	w := jobRequest(server, "DELETE", "/api/agent/jobs/"+created.ID, "")
	var view AgentJobView
	_ = json.Unmarshal(w.Body.Bytes(), &view)
	if w.Code != 200 || view.Status != "cancelled" {
		t.Fatal("cancel did not immediately return cancelled state")
	}
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("cancellation did not reach provider request")
	}
	waitJobSlots(t, server, 0)
	view = waitJob(t, server, created.ID, "cancelled")
	if view.Analysis != nil {
		t.Fatal("cancelled job retained an analysis")
	}
}

func TestAgentJobsShareTwoSlotsAndCancelWaitsForWorkerExit(t *testing.T) {
	server := newJobTestServer(t)
	release := make(chan struct{})
	defer close(release)
	started := make(chan struct{}, 4)
	server.Analyzer.Client.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		started <- struct{}{}
		<-release
		return jsonResponse(200, mockJobCompletion(), nil), nil
	})
	first := createTestJob(t, server, jobInput("https://8.8.8.8"))
	second := createTestJob(t, server, jobInput("https://8.8.8.8"))
	<-started
	<-started
	for _, id := range []string{first.ID, second.ID} {
		w := jobRequest(server, "DELETE", "/api/agent/jobs/"+id, "")
		if w.Code != 200 {
			t.Fatal("cancel failed")
		}
	}
	if len(server.agentSlots) != 2 {
		t.Fatal("cancel released slots before workers actually exited")
	}
	if w := jobRequest(server, "POST", "/api/agent/jobs", jobInput("https://8.8.8.8")); w.Code != 429 {
		t.Fatal("saturated async jobs were queued")
	}
	if w := jobRequest(server, "POST", "/api/agent/analyze", jobInput("https://8.8.8.8")); w.Code != 429 {
		t.Fatal("sync analysis did not share the async limit")
	}
	// Unblock individual workers while keeping the channel available for a
	// subsequent job. Cancelled workers may return late but cannot publish data.
	release <- struct{}{}
	release <- struct{}{}
	waitJobSlots(t, server, 0)
	for _, id := range []string{first.ID, second.ID} {
		view := waitJob(t, server, id, "cancelled")
		if view.Analysis != nil {
			t.Fatal("late success overwrote cancellation")
		}
	}
	third := createTestJob(t, server, jobInput("https://8.8.8.8"))
	<-started
	release <- struct{}{}
	waitJob(t, server, third.ID, "completed")
}

func TestAgentJobStoreFixedTTLAndBoundedRetention(t *testing.T) {
	store := newAgentJobStore()
	store.limit = 2
	store.ttl = time.Minute
	var clock atomic.Int64
	clock.Store(time.Now().UnixNano())
	store.now = func() time.Time { return time.Unix(0, clock.Load()) }
	t.Cleanup(func() {
		store.mu.Lock()
		if store.expiry != nil {
			store.expiry.Stop()
		}
		store.mu.Unlock()
	})
	first, _ := store.create(func() {})
	store.cancelJob(first.ID)
	clock.Add(int64(time.Second))
	second, _ := store.create(func() {})
	store.cancelJob(second.ID)
	third, _ := store.create(func() {})
	if _, exists := store.get(first.ID); exists {
		t.Fatal("oldest terminal job was not evicted at cap")
	}
	if len(store.items) != 2 {
		t.Fatal("job retention exceeded cap")
	}
	clock.Add(int64(30 * time.Second))
	if _, exists := store.get(second.ID); !exists {
		t.Fatal("terminal result expired too soon")
	}
	clock.Add(int64(31 * time.Second))
	if _, exists := store.get(second.ID); exists {
		t.Fatal("polling refreshed fixed terminal TTL")
	}
	if _, exists := store.get(third.ID); !exists {
		t.Fatal("terminal TTL removed an active worker")
	}
}

func TestAgentJobExpiryTimerStopsWhenResultsExpire(t *testing.T) {
	store := newAgentJobStore()
	store.ttl = 20 * time.Millisecond
	if store.expiry != nil {
		t.Fatal("new store started a background timer")
	}
	view, _ := store.create(func() {})
	store.cancelJob(view.ID)
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		store.mu.Lock()
		empty := len(store.items) == 0 && store.expiry == nil
		store.mu.Unlock()
		if empty {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("expiry did not remove idle results and stop its timer")
}

func TestAgentJobFailureAndPanicAreBoundedAndSanitized(t *testing.T) {
	for _, panicWorker := range []bool{false, true} {
		t.Run(map[bool]string{false: "provider failure", true: "worker panic"}[panicWorker], func(t *testing.T) {
			server := newJobTestServer(t)
			server.Analyzer.Client.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
				if panicWorker {
					panic("private-model-key private-HAR-cookie")
				}
				return jsonResponse(401, `{"error":"private-model-key"}`, nil), nil
			})
			created := createTestJob(t, server, jobInput("https://8.8.8.8"))
			view := waitJob(t, server, created.ID, "failed")
			waitJobSlots(t, server, 0)
			if view.Error == "" || strings.Contains(view.Error, "private-model-key") || strings.Contains(view.Error, "private-HAR-cookie") {
				t.Fatal("job failure was missing or unsanitized")
			}
		})
	}
}

func TestAgentJobRoutesRejectInvalidInputs(t *testing.T) {
	server := newJobTestServer(t)
	for _, test := range []struct {
		method, path, body string
		status             int
	}{
		{"GET", "/api/agent/jobs", "", 405},
		{"POST", "/api/agent/jobs", "{", 400},
		{"GET", "/api/agent/jobs/invalid", "", 404},
		{"GET", "/api/agent/jobs/abcdefghijklmnopqrstuvwx", "", 404},
		{"DELETE", "/api/agent/jobs/abcdefghijklmnopqrstuvwx", "", 404},
		{"POST", "/api/agent/jobs/abcdefghijklmnopqrstuvwx", "{}", 405},
	} {
		if w := jobRequest(server, test.method, test.path, test.body); w.Code != test.status {
			t.Errorf("%s %s returned %d", test.method, test.path, w.Code)
		}
	}
}
