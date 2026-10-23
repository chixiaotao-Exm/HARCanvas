package app

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

type FlowJobView struct {
	ID           string        `json:"id"`
	Status       string        `json:"status"`
	Events       []FlowEvent   `json:"events"`
	Seq          int64         `json:"seq"`
	PendingInput *PendingInput `json:"pendingInput,omitempty"`
	Result       *RunResult    `json:"result,omitempty"`
	Error        string        `json:"error,omitempty"`
}

type flowJob struct {
	id, status string
	events     []FlowEvent
	nodeStates map[string]string
	nodeOrder  []string
	steps      map[string]Step
	seq        int64
	pending    *PendingInput
	resume     chan string
	result     *RunResult
	message    string
	finishedAt time.Time
	cancel     context.CancelFunc
}

type flowJobStore struct {
	mu     sync.Mutex
	items  map[string]*flowJob
	ttl    time.Duration
	limit  int
	now    func() time.Time
	expiry *time.Timer
}

func newFlowJobStore() *flowJobStore {
	return &flowJobStore{items: map[string]*flowJob{}, ttl: 15 * time.Minute, limit: 128, now: time.Now}
}
func flowTerminal(status string) bool {
	return status == "completed" || status == "failed" || status == "cancelled"
}
func (s *flowJobStore) pruneLocked(now time.Time) {
	for id, job := range s.items {
		if !job.finishedAt.IsZero() && !now.Before(job.finishedAt.Add(s.ttl)) {
			delete(s.items, id)
		}
	}
}
func (s *flowJobStore) scheduleExpiryLocked() {
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

func (s *flowJobStore) create(cancel context.CancelFunc, g *graph) (FlowJobView, error) {
	var random [18]byte
	if _, err := rand.Read(random[:]); err != nil {
		return FlowJobView{}, errors.New("无法创建运行任务，请重试。")
	}
	id := base64.RawURLEncoding.EncodeToString(random[:])
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneLocked(s.now())
	if len(s.items) >= s.limit {
		oldestID := ""
		var oldest time.Time
		for key, job := range s.items {
			if !job.finishedAt.IsZero() && (oldestID == "" || job.finishedAt.Before(oldest)) {
				oldestID = key
				oldest = job.finishedAt
			}
		}
		if oldestID == "" {
			return FlowJobView{}, errors.New("运行任务数量已达上限，请稍后重试。")
		}
		delete(s.items, oldestID)
	}
	job := &flowJob{id: id, status: "running", events: []FlowEvent{}, nodeStates: map[string]string{}, steps: map[string]Step{}, resume: make(chan string, 1), cancel: cancel}
	for _, nodeID := range g.order {
		if !g.reachable[nodeID] {
			continue
		}
		job.nodeOrder = append(job.nodeOrder, nodeID)
		s.appendEventLocked(job, FlowEvent{NodeID: nodeID, Status: "pending", Time: s.now().UTC()})
	}
	s.items[id] = job
	s.scheduleExpiryLocked()
	return s.viewLocked(job, 0), nil
}

func (s *flowJobStore) appendEventLocked(job *flowJob, event FlowEvent) {
	job.seq++
	event.Seq = job.seq
	event.RunID = job.id
	if event.Time.IsZero() {
		event.Time = s.now().UTC()
	}
	job.events = append(job.events, event)
	job.nodeStates[event.NodeID] = event.Status
}
func (s *flowJobStore) record(id string, event FlowEvent) {
	s.mu.Lock()
	defer s.mu.Unlock()
	job, ok := s.items[id]
	if !ok || flowTerminal(job.status) {
		return
	}
	if event.Status == "pending" && job.nodeStates[event.NodeID] == "pending" {
		return
	}
	s.appendEventLocked(job, event)
}
func (s *flowJobStore) saveStep(id string, step Step) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if job := s.items[id]; job != nil {
		job.steps[step.NodeID] = step
	}
}

func (s *flowJobStore) viewLocked(job *flowJob, after int64) FlowJobView {
	view := FlowJobView{ID: job.id, Status: job.status, Events: []FlowEvent{}, Seq: job.seq, Error: job.message}
	for _, event := range job.events {
		if event.Seq > after {
			view.Events = append(view.Events, event)
		}
	}
	if job.pending != nil {
		pending := *job.pending
		view.PendingInput = &pending
	}
	if job.result != nil {
		summary := RunResult{Status: job.result.Status, Steps: make([]Step, 0, len(job.result.Steps))}
		for _, step := range job.result.Steps {
			step.Result = nil
			if step.Status == "error" && step.ErrorCode == "execution_failed" {
				step.Error = "步骤执行失败，请打开结果详情查看原因。"
			}
			summary.Steps = append(summary.Steps, step)
		}
		view.Result = &summary
	}
	return view
}
func (s *flowJobStore) get(id string, after int64) (FlowJobView, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneLocked(s.now())
	job, ok := s.items[id]
	if !ok {
		return FlowJobView{}, false
	}
	return s.viewLocked(job, after), true
}

func (s *flowJobStore) cancelJob(id string) (FlowJobView, bool) {
	s.mu.Lock()
	s.pruneLocked(s.now())
	job, ok := s.items[id]
	if !ok {
		s.mu.Unlock()
		return FlowJobView{}, false
	}
	var cancel context.CancelFunc
	if !flowTerminal(job.status) {
		job.status = "cancelled"
		job.finishedAt = s.now()
		job.pending = nil
		cancel = job.cancel
		job.cancel = nil
		for _, nodeID := range job.nodeOrder {
			switch job.nodeStates[nodeID] {
			case "pending", "running", "waiting_input":
				s.appendEventLocked(job, FlowEvent{NodeID: nodeID, Status: "cancelled", ErrorCode: "cancelled", Message: "运行已取消。"})
			}
		}
		s.scheduleExpiryLocked()
	}
	view := s.viewLocked(job, 0)
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	return view, true
}

func (s *flowJobStore) awaitInput(ctx context.Context, id string, pending PendingInput) (string, error) {
	s.mu.Lock()
	job := s.items[id]
	if job == nil || flowTerminal(job.status) {
		s.mu.Unlock()
		return "", context.Canceled
	}
	job.status = "waiting_input"
	job.pending = &pending
	s.appendEventLocked(job, FlowEvent{NodeID: pending.NodeID, Status: "waiting_input", Message: pending.Prompt})
	resume := job.resume
	s.mu.Unlock()
	select {
	case value := <-resume:
		if err := ctx.Err(); err != nil {
			return "", err
		}
		return value, nil
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

func (s *flowJobStore) resumeJob(id string, inputs map[string]string) (FlowJobView, int, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneLocked(s.now())
	job, ok := s.items[id]
	if !ok {
		return FlowJobView{}, 404, "运行任务不存在或已过期。"
	}
	if job.status != "waiting_input" || job.pending == nil {
		return FlowJobView{}, 409, "这个任务当前没有等待人工输入。"
	}
	value, provided := inputs[job.pending.Variable]
	if !provided {
		return FlowJobView{}, 400, "请提供当前步骤需要的人工输入。"
	}
	if len(value) > 2<<20 {
		return FlowJobView{}, 413, "人工输入超过 2 MiB。"
	}
	nodeID := job.pending.NodeID
	job.pending = nil
	job.status = "running"
	s.appendEventLocked(job, FlowEvent{NodeID: nodeID, Status: "running", Message: "已收到人工输入，继续执行。"})
	job.resume <- value
	return s.viewLocked(job, 0), 200, ""
}

func (s *flowJobStore) finish(id string, result *RunResult, message string) FlowJobView {
	s.mu.Lock()
	defer s.mu.Unlock()
	job, ok := s.items[id]
	if !ok {
		return FlowJobView{ID: id, Status: "failed", Events: []FlowEvent{}}
	}
	if job.status != "cancelled" {
		job.status = "failed"
		if result != nil {
			switch result.Status {
			case "success":
				job.status = "completed"
			case "cancelled":
				job.status = "cancelled"
			}
		}
		job.message = message
		job.finishedAt = s.now()
	}
	if job.status == "cancelled" && result != nil {
		copyResult := *result
		copyResult.Status = "cancelled"
		result = &copyResult
	}
	job.result = result
	job.pending = nil
	job.cancel = nil
	s.scheduleExpiryLocked()
	return s.viewLocked(job, job.seq)
}

func (s *flowJobStore) result(id, nodeID string) (any, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneLocked(s.now())
	job, ok := s.items[id]
	if !ok {
		return nil, 404
	}
	if nodeID != "" {
		step, found := job.steps[nodeID]
		if !found {
			return nil, 404
		}
		return step, 200
	}
	if job.result == nil {
		return nil, 409
	}
	return job.result, 200
}

func (s *Server) validateFlow(w http.ResponseWriter, r *http.Request) {
	var input Flow
	if !decodeBody(w, r, &input) {
		return
	}
	writeJSON(w, 200, ValidateFlow(input))
}
func (s *Server) createFlowJob(w http.ResponseWriter, r *http.Request) {
	var flow Flow
	if !decodeBody(w, r, &flow) {
		return
	}
	flow = snapshotFlow(flow)
	g, validation := inspectFlow(flow)
	if !validation.Valid {
		writeJSON(w, 400, validation)
		return
	}
	select {
	case s.runSlots <- struct{}{}:
	default:
		writeError(w, 429, "已有两个流程正在运行，请稍后重试。")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	view, err := s.flowJobs.create(cancel, g)
	if err != nil {
		cancel()
		<-s.runSlots
		writeError(w, 429, err.Error())
		return
	}
	requestID := RequestID(r.Context())
	log.Printf("flow_job event=start request_id=%s job_id=%s nodes=%d", requestID, view.ID, len(validation.ReachableNodeIDs))
	go s.runFlowJob(ctx, cancel, view.ID, requestID, flow, g)
	writeJSON(w, 202, view)
}

func (s *Server) runFlowJob(ctx context.Context, cancel context.CancelFunc, id, requestID string, flow Flow, g *graph) {
	start := time.Now()
	var result *RunResult
	message := ""
	stage := "completed"
	defer func() {
		if recover() != nil {
			stage = "panic"
			message = "流程执行发生内部错误，请检查运行记录。"
			if result == nil {
				result = &RunResult{Status: "error", Steps: []Step{}}
			}
			s.flowJobs.failRemaining(id, "internal_error", message)
		}
		view := s.flowJobs.finish(id, result, message)
		<-s.runSlots
		cancel()
		log.Printf("flow_job event=finish request_id=%s job_id=%s duration_ms=%d status=%s stage=%s", requestID, id, time.Since(start).Milliseconds(), view.Status, stage)
	}()
	run := s.Runner.executeFlow(ctx, flow, g, executionHooks{Event: func(event FlowEvent) { s.flowJobs.record(id, event) }, Step: func(step Step) { s.flowJobs.saveStep(id, step) }, AwaitInput: func(ctx context.Context, pending PendingInput) (string, error) {
		return s.flowJobs.awaitInput(ctx, id, pending)
	}})
	result = &run
	if run.Status != "success" {
		stage = run.Status
	}
}

func (s *flowJobStore) failRemaining(id, code, message string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	job := s.items[id]
	if job == nil || flowTerminal(job.status) {
		return
	}
	for _, nodeID := range job.nodeOrder {
		switch job.nodeStates[nodeID] {
		case "running", "waiting_input":
			s.appendEventLocked(job, FlowEvent{NodeID: nodeID, Status: "error", ErrorCode: code, Message: message})
		case "pending":
			s.appendEventLocked(job, FlowEvent{NodeID: nodeID, Status: "skipped", Message: "前面的步骤失败，后续步骤已跳过。"})
		}
	}
}

func (s *Server) serveFlowJob(w http.ResponseWriter, r *http.Request, path string) {
	parts := strings.Split(path, "/")
	id := parts[0]
	if !agentJobID.MatchString(id) {
		writeError(w, 404, "运行任务不存在或已过期。")
		return
	}
	if len(parts) == 2 && parts[1] == "resume" {
		if r.Method != "POST" {
			methodError(w, "POST")
			return
		}
		var input struct {
			Inputs map[string]string `json:"inputs"`
		}
		if !decodeBody(w, r, &input) {
			return
		}
		view, status, message := s.flowJobs.resumeJob(id, input.Inputs)
		if status != 200 {
			writeError(w, status, message)
		} else {
			writeJSON(w, status, view)
		}
		return
	}
	if (len(parts) == 2 && parts[1] == "result") || (len(parts) == 3 && parts[1] == "results") {
		if r.Method != "GET" {
			methodError(w, "GET")
			return
		}
		nodeID := ""
		if len(parts) == 3 {
			nodeID = parts[2]
			if !identifier.MatchString(nodeID) {
				writeError(w, 404, "步骤结果不存在。")
				return
			}
		}
		result, status := s.flowJobs.result(id, nodeID)
		if status != 200 {
			message := "步骤结果或运行任务不存在。"
			if status == 409 {
				message = "流程尚未结束，请继续查询执行状态。"
			}
			writeError(w, status, message)
		} else {
			writeJSON(w, 200, result)
		}
		return
	}
	if len(parts) != 1 {
		writeError(w, 404, "运行接口不存在。")
		return
	}
	if r.Method != "GET" && r.Method != "DELETE" {
		methodError(w, "GET, DELETE")
		return
	}
	after := int64(0)
	if value := r.URL.Query().Get("after"); value != "" {
		var err error
		after, err = strconv.ParseInt(value, 10, 64)
		if err != nil || after < 0 {
			writeError(w, 400, "事件序号需要是非负整数。")
			return
		}
	}
	var view FlowJobView
	var found bool
	if r.Method == "DELETE" {
		view, found = s.flowJobs.cancelJob(id)
	} else {
		view, found = s.flowJobs.get(id, after)
	}
	if !found {
		writeError(w, 404, "运行任务不存在或已过期。")
		return
	}
	writeJSON(w, 200, view)
}
