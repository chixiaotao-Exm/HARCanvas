package app

// AnalysisContext is bounded, untrusted HAR metadata. It never supplies code or
// execution instructions to the runner.
type AnalysisContext struct {
	Truncated bool                 `json:"truncated,omitempty"`
	Goal      string               `json:"goal"`
	Catalog   []RequestCatalog     `json:"catalog"`
	Groups    []AnalysisGroup      `json:"groups"`
	Relations []FieldRelation      `json:"relations"`
	Previous  []PreviousSuggestion `json:"previous"`
}
type RequestCatalog struct {
	ID       string `json:"id"`
	Method   string `json:"method"`
	Domain   string `json:"domain"`
	Path     string `json:"path"`
	Category string `json:"category"`
	PageID   string `json:"pageId,omitempty"`
}
type AnalysisGroup struct {
	ID         string   `json:"id"`
	Label      string   `json:"label"`
	Kind       string   `json:"kind"`
	RequestIDs []string `json:"requestIds"`
}
type FieldRelation struct {
	SourceRequestID string `json:"sourceRequestId"`
	TargetRequestID string `json:"targetRequestId"`
	SourcePath      string `json:"sourcePath"`
	TargetPath      string `json:"targetPath"`
	Evidence        string `json:"evidence"`
}
type PreviousSuggestion struct {
	RequestID    string   `json:"requestId"`
	Label        string   `json:"label"`
	Dependencies []string `json:"dependencies"`
}
