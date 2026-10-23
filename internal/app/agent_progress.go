package app

import (
	"context"
	"log"
	"sync"
	"time"
)

type AnalysisProgress struct {
	Stage         string `json:"stage"`
	ElapsedMS     int64  `json:"elapsedMs"`
	PayloadBytes  int    `json:"payloadBytes,omitempty"`
	ContextBytes  int    `json:"contextBytes,omitempty"`
	ResponseBytes int    `json:"responseBytes,omitempty"`
}

type AnalysisObserver func(AnalysisProgress)

type analysisJobIDKey struct{}

type analysisReporter struct {
	mu       sync.Mutex
	ctx      context.Context
	started  time.Time
	requests int
	progress AnalysisProgress
	observer AnalysisObserver
}

func analysisStageRank(stage string) int {
	switch stage {
	case "preparing":
		return 1
	case "waiting_model":
		return 2
	case "reading_response":
		return 3
	case "validating":
		return 4
	case "completed":
		return 5
	default:
		return 0
	}
}

func newAnalysisReporter(ctx context.Context, requests int, observer AnalysisObserver) *analysisReporter {
	return &analysisReporter{ctx: ctx, requests: requests, started: time.Now(), observer: observer}
}

// Transport callbacks can run on different goroutines and early response
// headers can race a completed request write. Never regress the visible phase.
func (r *analysisReporter) report(stage string, update func(*AnalysisProgress)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if analysisStageRank(stage) < analysisStageRank(r.progress.Stage) {
		return
	}
	r.progress.Stage = stage
	if update != nil {
		update(&r.progress)
	}
	r.progress.ElapsedMS = time.Since(r.started).Milliseconds()
	r.logLocked("stage", "none")
	if r.observer != nil {
		func() {
			// Progress reporting must not change a paid provider call's outcome.
			defer func() { _ = recover() }()
			r.observer(r.progress)
		}()
	}
}

func (r *analysisReporter) log(event, code string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.progress.ElapsedMS = time.Since(r.started).Milliseconds()
	r.logLocked(event, code)
}

func (r *analysisReporter) logLocked(event, code string) {
	requestID := RequestID(r.ctx)
	if requestID == "" {
		requestID = "-"
	}
	jobID, _ := r.ctx.Value(analysisJobIDKey{}).(string)
	if jobID == "" {
		jobID = "-"
	}
	log.Printf("agent_model event=%s request_id=%s job_id=%s stage=%s requests=%d payload_bytes=%d context_bytes=%d response_bytes=%d duration_ms=%d error_code=%s", event, requestID, jobID, r.progress.Stage, r.requests, r.progress.PayloadBytes, r.progress.ContextBytes, r.progress.ResponseBytes, r.progress.ElapsedMS, code)
}
