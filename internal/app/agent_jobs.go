package app

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"log"
	"net/http"
	"regexp"
	"sync"
	"time"
)

type AgentJobView struct {
	ID        string    `json:"id"`
	Status    string    `json:"status"`
	Analysis  *Analysis `json:"analysis,omitempty"`
	Error     string    `json:"error,omitempty"`
	ErrorCode string    `json:"errorCode,omitempty"`
}

type agentJob struct {
	view       AgentJobView
	createdAt  time.Time
	finishedAt time.Time
	cancel     context.CancelFunc
}

// A stored job contains no provider configuration or HAR request data. Only
// the bounded worker closure retains inputs while a model call is running.
type agentJobStore struct {
	mu     sync.Mutex
	items  map[string]*agentJob
	ttl    time.Duration
	limit  int
	now    func() time.Time
	expiry *time.Timer
}

func newAgentJobStore() *agentJobStore {
	return &agentJobStore{items: map[string]*agentJob{}, ttl: 15 * time.Minute, limit: 128, now: time.Now}
}

func (s *agentJobStore) pruneLocked(now time.Time) {
	for id, job := range s.items {
		if !job.finishedAt.IsZero() && !now.Before(job.finishedAt.Add(s.ttl)) {
			delete(s.items, id)
		}
	}
}

// Only stores with terminal jobs have a timer. Its callback removes expired
// results and stops scheduling once no terminal jobs remain. NewServer itself
// starts no goroutine, and polling never extends a job's fixed retention TTL.
func (s *agentJobStore) scheduleExpiryLocked() {
	if s.expiry != nil {
		return
	}
	var earliest time.Time
	for _, job := range s.items {
		if job.finishedAt.IsZero() {
			continue
		}
		expires := job.finishedAt.Add(s.ttl)
		if earliest.IsZero() || expires.Before(earliest) {
			earliest = expires
		}
	}
	if earliest.IsZero() {
		return
	}
	delay := earliest.Sub(s.now())
	if delay < 0 {
		delay = 0
	}
	s.expiry = time.AfterFunc(delay, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		s.expiry = nil
		s.pruneLocked(s.now())
		s.scheduleExpiryLocked()
	})
}

func (s *agentJobStore) create(cancel context.CancelFunc) (AgentJobView, error) {
	var random [18]byte
	if _, err := rand.Read(random[:]); err != nil {
		return AgentJobView{}, errors.New("无法创建分析任务，请重试。")
	}
	id := base64.RawURLEncoding.EncodeToString(random[:])
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	s.pruneLocked(now)
	if len(s.items) >= s.limit {
		oldestID := ""
		var oldest time.Time
		for key, job := range s.items {
			if job.finishedAt.IsZero() {
				continue
			}
			if oldestID == "" || job.finishedAt.Before(oldest) {
				oldestID = key
				oldest = job.finishedAt
			}
		}
		if oldestID == "" {
			return AgentJobView{}, errors.New("分析任务数量已达上限，请稍后重试。")
		}
		delete(s.items, oldestID)
	}
	view := AgentJobView{ID: id, Status: "running"}
	s.items[id] = &agentJob{view: view, createdAt: now, cancel: cancel}
	s.scheduleExpiryLocked()
	return view, nil
}

func (s *agentJobStore) get(id string) (AgentJobView, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneLocked(s.now())
	job, ok := s.items[id]
	if !ok {
		return AgentJobView{}, false
	}
	return job.view, true
}

func (s *agentJobStore) cancelJob(id string) (AgentJobView, bool) {
	s.mu.Lock()
	s.pruneLocked(s.now())
	job, ok := s.items[id]
	if !ok {
		s.mu.Unlock()
		return AgentJobView{}, false
	}
	var cancel context.CancelFunc
	if job.view.Status == "running" {
		job.view.Status = "cancelled"
		job.finishedAt = s.now()
		cancel = job.cancel
		job.cancel = nil
		s.scheduleExpiryLocked()
	}
	view := job.view
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	return view, true
}

func (s *agentJobStore) finish(id, status string, analysis *Analysis, failure *AnalysisError) AgentJobView {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneLocked(s.now())
	job, ok := s.items[id]
	if !ok {
		return AgentJobView{ID: id, Status: status}
	}
	if job.view.Status == "running" {
		job.view.Status = status
		job.view.Analysis = analysis
		if failure != nil {
			job.view.Error = failure.Error()
			job.view.ErrorCode = failure.Code
		}
		job.finishedAt = s.now()
		job.cancel = nil
		s.scheduleExpiryLocked()
	}
	return job.view
}

var agentJobID = regexp.MustCompile(`^[A-Za-z0-9_-]{24}$`)

func (s *Server) createAgentJob(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Config   AgentConfig     `json:"config"`
		Requests []Request       `json:"requests"`
		Context  AnalysisContext `json:"context"`
	}
	if !decodeBody(w, r, &input) {
		return
	}
	select {
	case s.agentSlots <- struct{}{}:
	default:
		writeError(w, 429, "已有两个模型分析正在运行，请稍后重试。")
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	view, err := s.jobs.create(cancel)
	if err != nil {
		cancel()
		<-s.agentSlots
		writeError(w, 429, err.Error())
		return
	}
	requestID := RequestID(r.Context())
	log.Printf("agent_job event=start request_id=%s job_id=%s requests=%d", requestID, view.ID, len(input.Requests))
	go s.runAgentJob(ctx, cancel, view.ID, requestID, input.Config, input.Requests, input.Context)
	writeJSON(w, http.StatusAccepted, view)
}

func (s *Server) serveAgentJob(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != "GET" && r.Method != "DELETE" {
		methodError(w, "GET, DELETE")
		return
	}
	if !agentJobID.MatchString(id) {
		writeError(w, 404, "分析任务不存在或已过期。")
		return
	}
	var view AgentJobView
	var exists bool
	if r.Method == "DELETE" {
		view, exists = s.jobs.cancelJob(id)
	} else {
		view, exists = s.jobs.get(id)
	}
	if !exists {
		writeError(w, 404, "分析任务不存在或已过期。")
		return
	}
	writeJSON(w, 200, view)
}

func (s *Server) runAgentJob(ctx context.Context, cancel context.CancelFunc, id, requestID string, config AgentConfig, requests []Request, contexts ...AnalysisContext) {
	start := time.Now()
	status, stage := "failed", "analysis"
	var analysis *Analysis
	var failure *AnalysisError
	defer func() {
		if recover() != nil {
			status = "failed"
			stage = "panic"
			analysis = nil
			failure = publicAnalysisError(nil)
		}
		if ctx.Err() == context.Canceled {
			status = "cancelled"
			stage = "cancelled"
			analysis = nil
			failure = nil
		}
		view := s.jobs.finish(id, status, analysis, failure)
		<-s.agentSlots
		cancel()
		log.Printf("agent_job event=finish request_id=%s job_id=%s requests=%d duration_ms=%d status=%s stage=%s", requestID, id, len(requests), time.Since(start).Milliseconds(), view.Status, stage)
	}()
	var analysisContext AnalysisContext
	if len(contexts) > 0 {
		analysisContext = contexts[0]
	}
	result, err := s.Analyzer.AnalyzeWithContext(ctx, config, requests, analysisContext)
	if err != nil {
		failure = publicAnalysisError(err)
		return
	}
	status = "completed"
	stage = "completed"
	analysis = &result
}
