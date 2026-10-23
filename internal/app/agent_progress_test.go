package app

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestAnalyzerObserverReportsActualPhasesAndKeepsOldMethodsCompatible(t *testing.T) {
	written := make(chan struct{})
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input map[string]json.RawMessage
		if json.NewDecoder(r.Body).Decode(&input) != nil {
			t.Error("invalid provider request JSON")
		}
		if len(input) != 3 || input["model"] == nil || input["messages"] == nil || input["response_format"] == nil {
			t.Error("compatible provider payload unexpectedly changed fields")
		}
		select {
		case <-written:
		case <-r.Context().Done():
			return
		}
		_, _ = io.WriteString(w, mockJobCompletion())
	}))
	defer provider.Close()
	analyzer := NewAnalyzerWithTimeout(time.Second)
	config := AgentConfig{BaseURL: provider.URL + "/v1", APIKey: "synthetic-visible-key", Model: "synthetic-model"}
	requests := []Request{{ID: "req-1"}}
	var phases []AnalysisProgress
	var writeOnce sync.Once
	result, err := analyzer.AnalyzeWithObserver(context.Background(), config, requests, AnalysisContext{}, func(progress AnalysisProgress) {
		phases = append(phases, progress)
		if progress.Stage == "waiting_model" {
			writeOnce.Do(func() { close(written) })
		}
	})
	if err != nil || len(result.Suggestions) != 1 {
		t.Fatal("observer changed the successful provider result")
	}
	var stages []string
	for _, progress := range phases {
		if len(stages) == 0 || stages[len(stages)-1] != progress.Stage {
			stages = append(stages, progress.Stage)
		}
	}
	if strings.Join(stages, ",") != "preparing,waiting_model,reading_response,validating,completed" {
		t.Fatalf("unexpected real provider phase order: %v", stages)
	}
	last := phases[len(phases)-1]
	if last.ContextBytes <= 0 || last.PayloadBytes <= last.ContextBytes || last.ResponseBytes != len(mockJobCompletion()) || last.ElapsedMS < 0 {
		t.Fatal("observer lost actual byte counts or elapsed time")
	}
	if _, err := analyzer.Analyze(context.Background(), config, requests); err != nil {
		t.Fatal("legacy Analyze method failed")
	}
	if _, err := analyzer.AnalyzeWithContext(context.Background(), config, requests, AnalysisContext{}); err != nil {
		t.Fatal("legacy AnalyzeWithContext method failed")
	}
	if _, err := analyzer.AnalyzeWithObserver(context.Background(), config, requests, AnalysisContext{}, func(AnalysisProgress) { panic("synthetic observer failure") }); err != nil {
		t.Fatal("observer failure changed model-call outcome")
	}
}

func waitAgentPhase(t *testing.T, server *Server, id, stage string) AgentJobView {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		view, ok := server.jobs.get(id)
		if ok && view.Progress != nil && view.Progress.Stage == stage {
			return view
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("analysis job did not reach actual phase %s", stage)
	return AgentJobView{}
}

func TestAgentJobProgressShowsWaitingAndReadingWithLiveElapsedTime(t *testing.T) {
	allowHeaders, allowBody := make(chan struct{}), make(chan struct{})
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		select {
		case <-allowHeaders:
		case <-r.Context().Done():
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		select {
		case <-allowBody:
			_, _ = io.WriteString(w, mockJobCompletion())
		case <-r.Context().Done():
		}
	}))
	defer func() {
		select {
		case <-allowHeaders:
		default:
			close(allowHeaders)
		}
		select {
		case <-allowBody:
		default:
			close(allowBody)
		}
		provider.Close()
	}()
	server := newJobTestServer(t)
	server.Analyzer = NewAnalyzerWithTimeout(time.Second)
	var now atomic.Int64
	now.Store(time.Now().UnixNano())
	server.jobs.now = func() time.Time { return time.Unix(0, now.Load()) }
	created := createTestJob(t, server, jobInput(provider.URL))
	first := waitAgentPhase(t, server, created.ID, "waiting_model")
	if first.Progress.PayloadBytes == 0 || first.Progress.ContextBytes == 0 || first.Progress.ResponseBytes != 0 {
		t.Fatal("waiting phase contains missing input counts or fabricated output bytes")
	}
	now.Add(int64(35 * time.Millisecond))
	w := jobRequest(server, "GET", "/api/agent/jobs/"+created.ID, "")
	var live AgentJobView
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &live) != nil || live.Progress == nil || live.Progress.ElapsedMS != 35 || live.Progress.Stage != "waiting_model" {
		t.Fatal("polling did not calculate elapsed time while the model stayed silent")
	}
	first.Progress.Stage = "synthetic-mutated-view"
	if current, _ := server.jobs.get(created.ID); current.Progress.Stage != "waiting_model" {
		t.Fatal("an external progress view can mutate stored job state")
	}
	close(allowHeaders)
	reading := waitAgentPhase(t, server, created.ID, "reading_response")
	if reading.Status != "running" || reading.Progress.ResponseBytes != 0 {
		t.Fatal("headers were mistaken for a completed response")
	}
	close(allowBody)
	completed := waitJob(t, server, created.ID, "completed")
	waitJobSlots(t, server, 0)
	if completed.Progress == nil || completed.Progress.Stage != "completed" || completed.Progress.ResponseBytes != len(mockJobCompletion()) {
		t.Fatal("completed job lost final provider phase or response size")
	}
	now.Add(int64(time.Second))
	if terminal, _ := server.jobs.get(created.ID); terminal.Progress.ElapsedMS != completed.Progress.ElapsedMS {
		t.Fatal("terminal job elapsed time kept increasing")
	}
}

type synchronizedAgentLog struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (s *synchronizedAgentLog) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buffer.Write(p)
}

func (s *synchronizedAgentLog) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buffer.String()
}

func TestAgentTimeoutReportsRealWaitingOrReadingPhaseAndSafeLogs(t *testing.T) {
	for _, sendHeaders := range []bool{false, true} {
		name, expectedPhase := "before headers", "waiting_model"
		if sendHeaders {
			name, expectedPhase = "after headers", "reading_response"
		}
		t.Run(name, func(t *testing.T) {
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.Copy(io.Discard, r.Body)
				if sendHeaders {
					w.WriteHeader(200)
					w.(http.Flusher).Flush()
				}
				select {
				case <-r.Context().Done():
				case <-time.After(time.Second):
				}
			}))
			defer provider.Close()
			server := newJobTestServer(t)
			server.Analyzer = NewAnalyzerWithTimeout(50 * time.Millisecond)
			var logs synchronizedAgentLog
			previousOutput := log.Writer()
			log.SetOutput(&logs)
			defer log.SetOutput(previousOutput)
			created := createTestJob(t, server, jobInput(provider.URL+"/synthetic-private-provider-path"))
			failed := waitJob(t, server, created.ID, "failed")
			waitJobSlots(t, server, 0)
			if failed.ErrorCode != "timeout" || failed.Progress == nil || failed.Progress.Stage != expectedPhase || failed.Progress.ElapsedMS < 40 || failed.Analysis != nil {
				t.Fatal("timeout did not preserve its actual provider phase and safe error code")
			}
			deadline := time.Now().Add(time.Second)
			for !strings.Contains(logs.String(), "agent_job event=finish") && time.Now().Before(deadline) {
				time.Sleep(time.Millisecond)
			}
			text := logs.String()
			if !strings.Contains(text, "stage="+expectedPhase) || !strings.Contains(text, "error_code=timeout") || !strings.Contains(text, "payload_bytes=") || !strings.Contains(text, "job_id="+created.ID) {
				t.Fatal("timeout logs lack safe provider-phase metrics or correlation")
			}
			for _, forbidden := range []string{provider.URL, "synthetic-private-provider-path", "private-model-key", "private-HAR-cookie", "private-HAR-body", "mock-model", "deadline exceeded", "Post \""} {
				if strings.Contains(text, forbidden) {
					t.Fatal("phase logs leaked provider configuration, HAR data, or raw errors")
				}
			}
		})
	}
}

func TestAgentProgressCannotOverwriteCancelledJobsOrReleaseSlotsEarly(t *testing.T) {
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
		return jsonResponse(200, mockJobCompletion(), nil), nil
	})
	first := createTestJob(t, server, jobInput("https://8.8.8.8"))
	second := createTestJob(t, server, jobInput("https://8.8.8.8"))
	<-started
	<-started
	waitAgentPhase(t, server, first.ID, "waiting_model")
	jobRequest(server, "DELETE", "/api/agent/jobs/"+first.ID, "")
	jobRequest(server, "DELETE", "/api/agent/jobs/"+second.ID, "")
	if len(server.agentSlots) != 2 {
		t.Fatal("progress cancellation released slots before provider workers exited")
	}
	if saturated := jobRequest(server, "POST", "/api/agent/jobs", jobInput("https://8.8.8.8")); saturated.Code != 429 {
		t.Fatal("new work bypassed still-running cancelled provider workers")
	}
	release <- struct{}{}
	release <- struct{}{}
	waitJobSlots(t, server, 0)
	for _, id := range []string{first.ID, second.ID} {
		view := waitJob(t, server, id, "cancelled")
		if view.Progress == nil || view.Progress.Stage != "waiting_model" || view.Analysis != nil {
			t.Fatal("late progress or successful response overwrote cancellation")
		}
	}
}
