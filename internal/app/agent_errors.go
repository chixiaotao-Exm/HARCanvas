package app

import "errors"

// AnalysisError contains only application-authored diagnostics. Provider text,
// request identifiers, JSON parser details, and transport errors never become
// browser-facing errors, even if they contain captured HAR values.
type AnalysisError struct {
	Code    string
	message string
}

func (e *AnalysisError) Error() string { return e.message }

func newAnalysisError(code, message string) *AnalysisError {
	return &AnalysisError{Code: code, message: message}
}

func publicAnalysisError(err error) *AnalysisError {
	var failure *AnalysisError
	if errors.As(err, &failure) && failure != nil {
		return failure
	}
	return newAnalysisError("internal_error", "模型分析任务发生内部错误，请重试。")
}
