package app

import (
	"context"
	"encoding/json"
	"time"
)

type FlowEvent struct {
	ResourceID  string    `json:"resourceId,omitempty"`
	ExecutionID string    `json:"executionId,omitempty"`
	ScopePath   []string  `json:"scopePath,omitempty"`
	Iteration   int       `json:"iteration,omitempty"`
	RunID       string    `json:"runId"`
	Seq         int64     `json:"seq"`
	NodeID      string    `json:"nodeId"`
	Status      string    `json:"status"`
	Time        time.Time `json:"time"`
	DurationMS  int64     `json:"durationMs,omitempty"`
	ErrorCode   string    `json:"errorCode,omitempty"`
	Message     string    `json:"message,omitempty"`
}

type PendingInput struct {
	BrowserSessionID string   `json:"browserSessionId,omitempty"`
	ViewURL          string   `json:"viewUrl,omitempty"`
	ExecutionID      string   `json:"executionId,omitempty"`
	ScopePath        []string `json:"scopePath,omitempty"`
	Iteration        int      `json:"iteration,omitempty"`
	NodeID           string   `json:"nodeId"`
	Variable         string   `json:"variable"`
	Label            string   `json:"label"`
	Prompt           string   `json:"prompt"`
}

type executionError struct{ Code, Message string }

func (e *executionError) Error() string { return e.Message }

type executionHooks struct {
	Event      func(FlowEvent)
	Step       func(Step)
	AwaitInput func(context.Context, PendingInput) (string, error)
}

func snapshotFlow(flow Flow) Flow {
	data, err := json.Marshal(flow)
	if err != nil {
		return Flow{}
	}
	var snapshot Flow
	if json.Unmarshal(data, &snapshot) != nil {
		return Flow{}
	}
	return snapshot
}

func (r *Runner) Run(ctx context.Context, flow Flow) (RunResult, error) {
	flow = snapshotFlow(flow)
	g, err := validateFlow(flow)
	if err != nil {
		return RunResult{Status: "error", Steps: []Step{}, Variables: map[string]any{}}, err
	}
	ctx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	return r.executeFlow(ctx, flow, g, executionHooks{}), nil
}
