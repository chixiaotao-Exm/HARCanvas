package app

import "encoding/json"

type Request struct {
	ID                    string            `json:"id"`
	Method                string            `json:"method"`
	URL                   string            `json:"url"`
	Domain                string            `json:"domain"`
	Path                  string            `json:"path"`
	Category              string            `json:"category"`
	MimeType              string            `json:"mimeType"`
	Status                int               `json:"status"`
	Duration              float64           `json:"duration"`
	Headers               map[string]string `json:"headers"`
	Body                  string            `json:"body"`
	ResponseBody          string            `json:"responseBody"`
	ResponseBodyTruncated bool              `json:"responseBodyTruncated,omitempty"`
	ResponseBodyBytes     int               `json:"responseBodyBytes,omitempty"`
	ResponseHeaders       map[string]string `json:"responseHeaders"`
	Query                 map[string]string `json:"query"`
}
type HARSummary struct {
	Total   int      `json:"total"`
	API     int      `json:"api"`
	Static  int      `json:"static"`
	Domains []string `json:"domains"`
}
type ParseResult struct {
	Requests []Request  `json:"requests"`
	Summary  HARSummary `json:"summary"`
	Warnings []string   `json:"warnings"`
}
type AgentConfig struct {
	BaseURL string `json:"baseUrl"`
	APIKey  string `json:"apiKey"`
	Model   string `json:"model"`
}
type SuggestionVariable struct {
	Name        string `json:"name"`
	Source      string `json:"source"`
	Description string `json:"description"`
}
type Suggestion struct {
	RequestID    string               `json:"requestId"`
	Label        string               `json:"label"`
	Description  string               `json:"description"`
	Category     string               `json:"category"`
	Dependencies []string             `json:"dependencies"`
	Confidence   string               `json:"confidence"`
	Variables    []SuggestionVariable `json:"variables"`
}
type Analysis struct {
	Summary     string       `json:"summary"`
	Suggestions []Suggestion `json:"suggestions"`
	Warnings    []string     `json:"warnings"`
}
type BlockData struct {
	Kind        string            `json:"kind"`
	Label       string            `json:"label"`
	Description string            `json:"description,omitempty"`
	RequestID   string            `json:"requestId,omitempty"`
	Method      string            `json:"method,omitempty"`
	URL         string            `json:"url,omitempty"`
	Headers     map[string]string `json:"headers,omitempty"`
	Body        string            `json:"body,omitempty"`
	Variable    string            `json:"variable,omitempty"`
	Value       string            `json:"value,omitempty"`
	Source      string            `json:"source,omitempty"`
	Path        string            `json:"path,omitempty"`
	Operator    string            `json:"operator,omitempty"`
	Expected    string            `json:"expected,omitempty"`
	Template    string            `json:"template,omitempty"`
}
type FlowNode struct {
	ID       string          `json:"id"`
	Type     string          `json:"type"`
	Position json.RawMessage `json:"position,omitempty"`
	Data     BlockData       `json:"data"`
}
type FlowEdge struct {
	ID           string `json:"id"`
	Source       string `json:"source"`
	Target       string `json:"target"`
	SourceHandle string `json:"sourceHandle,omitempty"`
}
type Flow struct {
	Nodes  []FlowNode        `json:"nodes"`
	Edges  []FlowEdge        `json:"edges"`
	Inputs map[string]string `json:"inputs"`
}
type Step struct {
	NodeID     string `json:"nodeId"`
	Label      string `json:"label"`
	Kind       string `json:"kind"`
	Status     string `json:"status"`
	DurationMS int64  `json:"durationMs"`
	Result     any    `json:"result"`
	Error      string `json:"error,omitempty"`
}
type RunResult struct {
	Status    string         `json:"status"`
	Steps     []Step         `json:"steps"`
	Variables map[string]any `json:"variables"`
	Output    any            `json:"output"`
}
