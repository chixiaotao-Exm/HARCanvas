package app

import "encoding/json"

type Request struct {
	ID                    string            `json:"id"`
	PageID                string            `json:"pageId,omitempty"`
	StartedAt             string            `json:"startedAt,omitempty"`
	StartedDateTime       string            `json:"startedDateTime,omitempty"`
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
	ResponseDetailURL     string            `json:"responseDetailUrl,omitempty"`
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
	Pages    []HARPage  `json:"pages,omitempty"`
}
type HARPage struct {
	ID              string `json:"id"`
	Title           string `json:"title"`
	StartedDateTime string `json:"startedDateTime"`
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
type SuggestionInputField struct {
	Name        string `json:"name"`
	Target      string `json:"target"`
	Path        string `json:"path"`
	Placeholder string `json:"placeholder,omitempty"`
	Required    *bool  `json:"required,omitempty"`
}
type Suggestion struct {
	RequestID    string                 `json:"requestId"`
	Label        string                 `json:"label"`
	Description  string                 `json:"description"`
	Category     string                 `json:"category"`
	Dependencies []string               `json:"dependencies"`
	Confidence   string                 `json:"confidence"`
	Variables    []SuggestionVariable   `json:"variables"`
	Group        string                 `json:"group,omitempty"`
	Inputs       []string               `json:"inputs,omitempty"`
	InputFields  []SuggestionInputField `json:"inputFields,omitzero"`
	Outputs      []string               `json:"outputs,omitempty"`
	Evidence     []string               `json:"evidence,omitempty"`
	Uncertainty  string                 `json:"uncertainty,omitempty"`
	Readiness    string                 `json:"readiness,omitempty"`
}
type Analysis struct {
	Summary     string       `json:"summary"`
	Suggestions []Suggestion `json:"suggestions"`
	Warnings    []string     `json:"warnings"`
}
type BlockData struct {
	Kind              string                `json:"kind"`
	Label             string                `json:"label"`
	Description       string                `json:"description,omitempty"`
	RequestID         string                `json:"requestId,omitempty"`
	Method            string                `json:"method,omitempty"`
	URL               string                `json:"url,omitempty"`
	Headers           map[string]string     `json:"headers,omitempty"`
	Body              string                `json:"body,omitempty"`
	Variable          string                `json:"variable,omitempty"`
	Value             string                `json:"value,omitempty"`
	Source            string                `json:"source,omitempty"`
	Path              string                `json:"path,omitempty"`
	Operator          string                `json:"operator,omitempty"`
	Expected          string                `json:"expected,omitempty"`
	Template          string                `json:"template,omitempty"`
	AcceptStatus      string                `json:"acceptStatus,omitempty"`
	CaptureID         string                `json:"captureId,omitempty"`
	OriginalRequestID string                `json:"originalRequestId,omitempty"`
	BrowserAction     string                `json:"browserAction,omitempty"`
	Selector          string                `json:"selector,omitempty"`
	Text              string                `json:"text,omitempty"`
	SessionID         string                `json:"sessionId,omitempty"`
	ProxyID           string                `json:"proxyId,omitempty"`
	ProfileID         string                `json:"profileId,omitempty"`
	Proxy             *ProxyConfig          `json:"proxy,omitempty"`
	Profile           *BrowserProfileConfig `json:"profile,omitempty"`
	Session           *SessionConfig        `json:"session,omitempty"`
	Loop              *LoopConfig           `json:"loop,omitempty"`
}

type ProxyConfig struct {
	CredentialsMissing bool   `json:"credentialsMissing,omitempty"`
	URL                string `json:"url"`
	SessionToken       string `json:"sessionToken,omitempty"`
	Rotation           string `json:"rotation,omitempty"`
	RotationMinutes    int    `json:"rotationMinutes,omitempty"`
}
type BrowserViewport struct {
	Width  int `json:"width"`
	Height int `json:"height"`
}
type BrowserProfileConfig struct {
	ID        string          `json:"id,omitempty"`
	Name      string          `json:"name,omitempty"`
	Browser   string          `json:"browser,omitempty"`
	Locale    string          `json:"locale,omitempty"`
	Timezone  string          `json:"timezone,omitempty"`
	Viewport  BrowserViewport `json:"viewport"`
	UserAgent string          `json:"userAgent,omitempty"`
}
type SessionConfig struct {
	Name      string `json:"name,omitempty"`
	ProxyID   string `json:"proxyId,omitempty"`
	ProfileID string `json:"profileId,omitempty"`
	Persist   bool   `json:"persist,omitempty"`
}
type ResourceDefaults struct {
	SessionID string `json:"sessionId,omitempty"`
	ProxyID   string `json:"proxyId,omitempty"`
	ProfileID string `json:"profileId,omitempty"`
}
type ResourceBinding struct {
	ID         string `json:"id,omitempty"`
	ResourceID string `json:"resourceId"`
	TargetID   string `json:"targetId"`
}
type LoopConfig struct {
	Mode            string     `json:"mode,omitempty"`
	Count           int        `json:"count,omitempty"`
	Items           string     `json:"items,omitempty"`
	ItemVariable    string     `json:"itemVariable,omitempty"`
	IndexVariable   string     `json:"indexVariable,omitempty"`
	Nodes           []FlowNode `json:"nodes"`
	Edges           []FlowEdge `json:"edges"`
	EntryID         string     `json:"entryId,omitempty"`
	ContinueOnError bool       `json:"continueOnError,omitempty"`
	FreshSession    bool       `json:"freshSession,omitempty"`
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
	ProjectID        string            `json:"projectId,omitempty"`
	EntryID          string            `json:"entryId,omitempty"`
	EntryNodeID      string            `json:"entryNodeId,omitempty"`
	Nodes            []FlowNode        `json:"nodes"`
	Edges            []FlowEdge        `json:"edges"`
	Inputs           map[string]string `json:"inputs"`
	Defaults         ResourceDefaults  `json:"defaults,omitempty"`
	ResourceBindings []ResourceBinding `json:"resourceBindings,omitempty"`
}
type Step struct {
	ResourceID  string   `json:"resourceId,omitempty"`
	ExecutionID string   `json:"executionId,omitempty"`
	ScopePath   []string `json:"scopePath,omitempty"`
	Iteration   int      `json:"iteration,omitempty"`
	NodeID      string   `json:"nodeId"`
	Label       string   `json:"label"`
	Kind        string   `json:"kind"`
	Status      string   `json:"status"`
	DurationMS  int64    `json:"durationMs"`
	Result      any      `json:"result"`
	Error       string   `json:"error,omitempty"`
	ErrorCode   string   `json:"errorCode,omitempty"`
}
type RunResult struct {
	Status    string         `json:"status"`
	Steps     []Step         `json:"steps"`
	Variables map[string]any `json:"variables"`
	Output    any            `json:"output"`
}
