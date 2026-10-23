package app

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func newFlowTestServer(t *testing.T) *Server {
	t.Helper()
	server := NewServer(t.TempDir())
	t.Cleanup(func() {
		server.flowJobs.mu.Lock()
		cancels := []context.CancelFunc{}
		for _, job := range server.flowJobs.items {
			if job.cancel != nil {
				cancels = append(cancels, job.cancel)
			}
		}
		server.flowJobs.mu.Unlock()
		for _, cancel := range cancels {
			cancel()
		}
		deadline := time.Now().Add(time.Second)
		for len(server.runSlots) > 0 && time.Now().Before(deadline) {
			time.Sleep(time.Millisecond)
		}
		server.flowJobs.mu.Lock()
		if server.flowJobs.expiry != nil {
			server.flowJobs.expiry.Stop()
		}
		server.flowJobs.items = map[string]*flowJob{}
		server.flowJobs.mu.Unlock()
	})
	return server
}
func createFlowTestJob(t *testing.T, server *Server, flow Flow) FlowJobView {
	t.Helper()
	encoded, _ := json.Marshal(flow)
	w := jobRequest(server, "POST", "/api/flow/jobs", string(encoded))
	if w.Code != 202 {
		t.Fatalf("create returned %d: %s", w.Code, w.Body.String())
	}
	var view FlowJobView
	if err := json.Unmarshal(w.Body.Bytes(), &view); err != nil {
		t.Fatal(err)
	}
	return view
}
func waitFlowState(t *testing.T, server *Server, id, status string) FlowJobView {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		view, ok := server.flowJobs.get(id, 0)
		if ok && view.Status == status {
			return view
		}
		time.Sleep(time.Millisecond)
	}
	view, _ := server.flowJobs.get(id, 0)
	t.Fatalf("job did not reach %s: %+v", status, view)
	return FlowJobView{}
}
func waitRunSlots(t *testing.T, server *Server, count int) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if len(server.runSlots) == count {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("run slot count=%d want=%d", len(server.runSlots), count)
}

func TestFlowJobsExposeRealOrderedEventsAndDetailedResults(t *testing.T) {
	server := newFlowTestServer(t)
	started := make(chan struct{})
	release := make(chan struct{})
	server.Runner.Client.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		close(started)
		select {
		case <-release:
			return jsonResponse(200, `{"value":"private-response-value"}`, nil), nil
		case <-req.Context().Done():
			return nil, req.Context().Err()
		}
	})
	flow := Flow{Nodes: []FlowNode{block("req", BlockData{Kind: "request", URL: "https://8.8.8.8"}), block("out", BlockData{Kind: "output", Template: "{{req.body.value}}"})}, Edges: []FlowEdge{connect("req", "out")}}
	encoded, _ := json.Marshal(flow)
	ctx, cancel := context.WithCancel(context.Background())
	r := httptest.NewRequest("POST", "/api/flow/jobs", strings.NewReader(string(encoded))).WithContext(ctx)
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	server.ServeHTTP(w, r)
	cancel()
	if w.Code != 202 {
		t.Fatalf("create returned %d", w.Code)
	}
	var created FlowJobView
	_ = json.Unmarshal(w.Body.Bytes(), &created)
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("request did not start")
	}
	poll := jobRequest(server, "GET", fmt.Sprintf("/api/flow/jobs/%s?after=%d", created.ID, created.Seq), "")
	var active FlowJobView
	_ = json.Unmarshal(poll.Body.Bytes(), &active)
	if poll.Code != 200 || active.Status != "running" {
		t.Fatalf("poll failed: %s", poll.Body.String())
	}
	runningFound := false
	for _, event := range active.Events {
		if event.NodeID == "req" && event.Status == "running" {
			runningFound = true
		}
		if event.NodeID == "out" && event.Status == "running" {
			t.Fatal("downstream animation started before HTTP completed")
		}
	}
	if !runningFound {
		t.Fatal("missing true running event")
	}
	close(release)
	finished := waitFlowState(t, server, created.ID, "completed")
	last := int64(0)
	for _, event := range finished.Events {
		if event.Seq != last+1 || event.RunID != created.ID || event.Time.IsZero() {
			t.Fatalf("invalid event sequence: %+v", finished.Events)
		}
		last = event.Seq
	}
	if last != finished.Seq || finished.Result == nil || finished.Result.Steps[0].Result != nil {
		t.Fatal("poll result included full response or missing metadata")
	}
	poll = jobRequest(server, "GET", fmt.Sprintf("/api/flow/jobs/%s?after=%d", created.ID, finished.Seq), "")
	if strings.Contains(poll.Body.String(), "private-response-value") {
		t.Fatal("poll leaked full response body")
	}
	var incremental FlowJobView
	_ = json.Unmarshal(poll.Body.Bytes(), &incremental)
	if len(incremental.Events) != 0 || incremental.Seq != finished.Seq {
		t.Fatal("poll repeated acknowledged events")
	}
	detail := jobRequest(server, "GET", "/api/flow/jobs/"+created.ID+"/results/req", "")
	if detail.Code != 200 || !strings.Contains(detail.Body.String(), "private-response-value") {
		t.Fatal("step result unavailable")
	}
	full := jobRequest(server, "GET", "/api/flow/jobs/"+created.ID+"/result", "")
	var result RunResult
	_ = json.Unmarshal(full.Body.Bytes(), &result)
	if result.Output != "private-response-value" {
		t.Fatalf("full result lost output: %s", full.Body.String())
	}
}

func TestFlowManualPauseResumesSameCookieSession(t *testing.T) {
	server := newFlowTestServer(t)
	var calls atomic.Int32
	server.Runner.Client.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		n := calls.Add(1)
		if n == 1 {
			return jsonResponse(200, `{"nonce":"abc"}`, http.Header{"Set-Cookie": []string{"sid=fresh; Path=/"}}), nil
		}
		if n != 2 {
			t.Errorf("request was replayed %d times", n)
		}
		cookie, err := req.Cookie("sid")
		if err != nil || cookie.Value != "fresh" {
			t.Error("manual pause lost cookie session")
		}
		body, _ := io.ReadAll(req.Body)
		if string(body) != "manual-value:abc" {
			t.Errorf("resume bindings wrong: %q", body)
		}
		return jsonResponse(200, `{"ok":true}`, nil), nil
	})
	flow := Flow{Nodes: []FlowNode{block("prepare", BlockData{Kind: "request", URL: "https://8.8.8.8/prepare"}), block("manual", BlockData{Kind: "manual", Variable: "code", Label: "人工确认", Description: "请输入测试值"}), block("submit", BlockData{Kind: "request", Method: "POST", URL: "https://8.8.8.8/submit", Body: "{{code}}:{{prepare.body.nonce}}"})}, Edges: []FlowEdge{connect("prepare", "manual"), connect("manual", "submit")}}
	created := createFlowTestJob(t, server, flow)
	waiting := waitFlowState(t, server, created.ID, "waiting_input")
	if waiting.PendingInput == nil || waiting.PendingInput.NodeID != "manual" || waiting.PendingInput.Variable != "code" || waiting.PendingInput.Prompt != "请输入测试值" || calls.Load() != 1 {
		t.Fatalf("wrong pending input: %+v", waiting)
	}
	bad := jobRequest(server, "POST", "/api/flow/jobs/"+created.ID+"/resume", `{"inputs":{"wrong":"x"}}`)
	if bad.Code != 400 {
		t.Fatalf("wrong input accepted: %d", bad.Code)
	}
	good := jobRequest(server, "POST", "/api/flow/jobs/"+created.ID+"/resume", `{"inputs":{"code":"manual-value"}}`)
	if good.Code != 200 {
		t.Fatalf("resume failed: %s", good.Body.String())
	}
	done := waitFlowState(t, server, created.ID, "completed")
	if done.PendingInput != nil || calls.Load() != 2 {
		t.Fatal("resume reran requests or retained pending input")
	}
	again := jobRequest(server, "POST", "/api/flow/jobs/"+created.ID+"/resume", `{"inputs":{"code":"again"}}`)
	if again.Code != 409 {
		t.Fatal("completed job resumed")
	}
}

func TestFlowCancellationKeepsSlotUntilWorkerStopsAndWinsLateSuccess(t *testing.T) {
	server := newFlowTestServer(t)
	started := make(chan struct{})
	release := make(chan struct{})
	defer close(release)
	server.Runner.Client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
		close(started)
		<-release
		return jsonResponse(200, `{"late":true}`, nil), nil
	})
	requestFlow := Flow{Nodes: []FlowNode{block("req", BlockData{Kind: "request", URL: "https://8.8.8.8"})}}
	created := createFlowTestJob(t, server, requestFlow)
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("worker not started")
	}
	cancelled := jobRequest(server, "DELETE", "/api/flow/jobs/"+created.ID, "")
	if cancelled.Code != 200 {
		t.Fatal("cancel failed")
	}
	waitFlowState(t, server, created.ID, "cancelled")
	if len(server.runSlots) != 1 {
		t.Fatal("cancel released active worker slot early")
	}
	manualFlow := Flow{Nodes: []FlowNode{block("manual", BlockData{Kind: "manual", Variable: "value"})}}
	second := createFlowTestJob(t, server, manualFlow)
	waitFlowState(t, server, second.ID, "waiting_input")
	encoded, _ := json.Marshal(manualFlow)
	third := jobRequest(server, "POST", "/api/flow/jobs", string(encoded))
	if third.Code != 429 {
		t.Fatal("worker limit was bypassed")
	}
	jobRequest(server, "DELETE", "/api/flow/jobs/"+second.ID, "")
	waitRunSlots(t, server, 1)
	// Release exactly once while keeping the cleanup path safe.
	server.flowJobs.mu.Lock()
	job := server.flowJobs.items[created.ID]
	seq := job.seq
	server.flowJobs.mu.Unlock()
	go func() { release <- struct{}{} }()
	waitRunSlots(t, server, 0)
	finished, _ := server.flowJobs.get(created.ID, 0)
	if finished.Status != "cancelled" || finished.Result == nil || finished.Result.Status != "cancelled" || finished.Seq != seq {
		t.Fatalf("late result overwrote cancellation: %+v", finished)
	}
	for _, event := range finished.Events {
		if event.Status == "success" {
			t.Fatal("late success event survived cancellation")
		}
	}
}

func TestFlowSnapshotIsImmutableDuringExecution(t *testing.T) {
	runner := NewRunner()
	started := make(chan struct{})
	release := make(chan struct{})
	runner.Client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
		close(started)
		<-release
		return jsonResponse(200, `{}`, nil), nil
	})
	flow := Flow{Nodes: []FlowNode{block("req", BlockData{Kind: "request", URL: "https://8.8.8.8", Headers: map[string]string{"X-Test": "old"}}), block("out", BlockData{Kind: "output", Template: "{{value}}"})}, Edges: []FlowEdge{connect("req", "out")}, Inputs: map[string]string{"value": "old"}}
	done := make(chan RunResult, 1)
	go func() {
		result, err := runner.Run(context.Background(), flow)
		if err != nil {
			done <- RunResult{Status: "validation_error"}
			return
		}
		done <- result
	}()
	<-started
	flow.Inputs["value"] = "new"
	flow.Nodes[1].Data.Template = "edited"
	flow.Nodes[0].Data.Headers["X-Test"] = "new"
	flow.Edges[0].Target = "req"
	close(release)
	result := <-done
	if result.Status != "success" || result.Output != "old" || len(result.Steps) != 2 {
		t.Fatalf("snapshot changed during run: %+v", result)
	}
}

func TestFlowValidationAndJobHTTPBoundaries(t *testing.T) {
	server := newFlowTestServer(t)
	invalid := Flow{Nodes: []FlowNode{block("ex", BlockData{Kind: "extract", Variable: "value"})}}
	encoded, _ := json.Marshal(invalid)
	for _, path := range []string{"/api/flow/validate", "/api/flow/jobs", "/api/flow/run"} {
		w := jobRequest(server, "POST", path, string(encoded))
		expected := 400
		if path == "/api/flow/validate" {
			expected = 200
		}
		var v FlowValidation
		_ = json.Unmarshal(w.Body.Bytes(), &v)
		if w.Code != expected || v.Valid || len(v.Issues) != 2 || v.Issues[0].NodeID != "ex" {
			t.Fatalf("structured preflight failed at %s: %d %s", path, w.Code, w.Body.String())
		}
	}
	for _, test := range []struct {
		method, path, body string
		want               int
	}{
		{"GET", "/api/flow/jobs", "", 405}, {"GET", "/api/flow/validate", "", 405}, {"GET", "/api/flow/jobs/not-a-job", "", 404}, {"POST", "/api/flow/jobs/AAAAAAAAAAAAAAAAAAAAAAAA/resume", `{"inputs":{}}`, 404}, {"GET", "/api/flow/jobs/AAAAAAAAAAAAAAAAAAAAAAAA?after=-1", "", 400}, {"GET", "/api/flow/jobs/AAAAAAAAAAAAAAAAAAAAAAAA?after=oops", "", 400},
	} {
		w := jobRequest(server, test.method, test.path, test.body)
		if w.Code != test.want || w.Header().Get("Cache-Control") != "no-store" {
			t.Errorf("%s %s returned %d want %d", test.method, test.path, w.Code, test.want)
		}
	}
}

func TestFlowStoreExpiryCapacityAndNoIdleTimer(t *testing.T) {
	store := newFlowJobStore()
	if store.expiry != nil {
		t.Fatal("idle store starts timer")
	}
	store.limit = 1
	now := time.Now()
	store.now = func() time.Time { return now }
	g, _ := validateFlow(Flow{Nodes: []FlowNode{block("one", BlockData{Kind: "output"})}})
	cancel := func() {}
	first, err := store.create(cancel, g)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.create(cancel, g); err == nil {
		t.Fatal("running capacity exceeded")
	}
	store.finish(first.ID, &RunResult{Status: "success", Steps: []Step{}}, "")
	if store.expiry == nil {
		t.Fatal("terminal result has no expiry timer")
	}
	second, err := store.create(cancel, g)
	if err != nil || second.ID == first.ID {
		t.Fatal("terminal eviction failed")
	}
	if _, found := store.get(first.ID, 0); found {
		t.Fatal("old terminal job not evicted")
	}
	store.finish(second.ID, &RunResult{Status: "success", Steps: []Step{}}, "")
	now = now.Add(store.ttl + time.Second)
	if _, found := store.get(second.ID, 0); found {
		t.Fatal("expired result retained")
	}
	store.mu.Lock()
	if store.expiry != nil {
		store.expiry.Stop()
	}
	store.mu.Unlock()
}

func TestFlowJobPanicBecomesFailedAndReleasesSlot(t *testing.T) {
	server := newFlowTestServer(t)
	server.Runner.Client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) { panic("private panic data") })
	created := createFlowTestJob(t, server, Flow{Nodes: []FlowNode{block("req", BlockData{Kind: "request", URL: "https://8.8.8.8"})}})
	failed := waitFlowState(t, server, created.ID, "failed")
	if strings.Contains(failed.Error, "private") || failed.Error == "" {
		t.Fatal("panic details were exposed or missing friendly failure")
	}
	waitRunSlots(t, server, 0)
}
