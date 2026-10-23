package app

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

const syntheticAnalysisSecret = "synthetic-sensitive-provider-HAR-value"

func analysisCompletion(content string) string {
	body, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": content}}}})
	return string(body)
}

type failedAnalysisBody struct{}

func (failedAnalysisBody) Read([]byte) (int, error) {
	return 0, errors.New(syntheticAnalysisSecret)
}
func (failedAnalysisBody) Close() error { return nil }

func TestAgentErrorsAreTypedAndNeverEchoProviderValuesAcrossAPIs(t *testing.T) {
	validSuggestion := `{"requestId":"req-1","label":"用途","description":"用途说明"}`
	cases := []struct {
		name, requestID, content, code string
		transportError, readError      bool
		status                         int
	}{
		{name: "unknown request", requestID: "req-1", content: `{"summary":"x","suggestions":[{"requestId":"` + syntheticAnalysisSecret + `","label":"x","description":"用途"}]}`, code: "provider_analysis_invalid"},
		{name: "invalid dependency", requestID: "req-1", content: `{"summary":"x","suggestions":[{"requestId":"req-1","label":"x","description":"用途","dependencies":["` + syntheticAnalysisSecret + `"]}]}`, code: "provider_analysis_invalid"},
		{name: "duplicate request", requestID: syntheticAnalysisSecret, content: `{"summary":"x","suggestions":[{"requestId":"` + syntheticAnalysisSecret + `","label":"x","description":"用途"},{"requestId":"` + syntheticAnalysisSecret + `","label":"x","description":"用途"}]}`, code: "provider_analysis_invalid"},
		{name: "missing description", requestID: syntheticAnalysisSecret, content: `{"summary":"x","suggestions":[{"requestId":"` + syntheticAnalysisSecret + `","label":"x"}]}`, code: "provider_analysis_invalid"},
		{name: "JSON wrong type", requestID: "req-1", content: `{"summary":"x","suggestions":"` + syntheticAnalysisSecret + `"}`, code: "provider_analysis_invalid"},
		{name: "malformed JSON", requestID: "req-1", content: `{"summary":"` + syntheticAnalysisSecret + `","suggestions":[` + validSuggestion, code: "provider_analysis_invalid"},
		{name: "transport error", requestID: "req-1", transportError: true, code: "provider_unavailable"},
		{name: "response read error", requestID: "req-1", readError: true, code: "provider_response_failed"},
		{name: "HTTP error body", requestID: "req-1", content: syntheticAnalysisSecret, status: 401, code: "provider_http_error"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server := newJobTestServer(t)
			server.Analyzer.Client.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
				if tc.transportError {
					return nil, errors.New(syntheticAnalysisSecret)
				}
				if tc.readError {
					return &http.Response{StatusCode: 200, Header: http.Header{}, Body: failedAnalysisBody{}}, nil
				}
				status := tc.status
				if status == 0 {
					status = 200
				}
				return jsonResponse(status, analysisCompletion(tc.content), nil), nil
			})
			config := AgentConfig{BaseURL: "https://8.8.8.8/private-provider-path/v1", APIKey: "synthetic-private-model-key", Model: "test-model"}
			requests := []Request{{ID: tc.requestID, Headers: map[string]string{"Cookie": syntheticAnalysisSecret}, Body: syntheticAnalysisSecret}}
			_, err := server.Analyzer.Analyze(context.Background(), config, requests)
			var failure *AnalysisError
			if !errors.As(err, &failure) || failure.Code != tc.code {
				t.Fatal("analysis error did not have the expected application error type and code")
			}
			assertSafeAnalysisDiagnostic(t, failure.Error())
			input, err := json.Marshal(map[string]any{"config": config, "requests": requests})
			if err != nil {
				t.Fatal("failed to encode synthetic test input")
			}
			syncResponse := jobRequest(server, "POST", "/api/agent/analyze", string(input))
			var syncFailure struct {
				Error, ErrorCode string
			}
			if syncResponse.Code != 502 || json.Unmarshal(syncResponse.Body.Bytes(), &syncFailure) != nil || syncFailure.ErrorCode != tc.code || syncFailure.Error != failure.Error() {
				t.Fatal("synchronous analysis did not return the controlled typed error")
			}
			assertSafeAnalysisDiagnostic(t, syncResponse.Body.String())
			created := createTestJob(t, server, string(input))
			view := waitJob(t, server, created.ID, "failed")
			if view.ErrorCode != tc.code || view.Error != failure.Error() || view.Analysis != nil {
				t.Fatal("asynchronous analysis did not preserve the same controlled typed error")
			}
			polled := jobRequest(server, "GET", "/api/agent/jobs/"+created.ID, "")
			var polledView AgentJobView
			if polled.Code != 200 || json.Unmarshal(polled.Body.Bytes(), &polledView) != nil || polledView.ErrorCode != tc.code || polledView.Error != failure.Error() {
				t.Fatal("job polling did not serialize the controlled typed error")
			}
			assertSafeAnalysisDiagnostic(t, polled.Body.String())
		})
	}
}

func assertSafeAnalysisDiagnostic(t *testing.T, value string) {
	t.Helper()
	if strings.TrimSpace(value) == "" {
		t.Fatal("analysis diagnostic is empty")
	}
	for _, forbidden := range []string{syntheticAnalysisSecret, "synthetic-private-model-key", "8.8.8.8", "private-provider-path", "cannot unmarshal", "unexpected end of JSON", "Post \""} {
		if strings.Contains(value, forbidden) {
			t.Fatal("analysis diagnostic echoed untrusted data or raw parser/transport details")
		}
	}
}

func TestPublicAnalysisErrorFallsBackForUnknownErrors(t *testing.T) {
	for _, err := range []error{nil, errors.New(syntheticAnalysisSecret), io.ErrUnexpectedEOF} {
		failure := publicAnalysisError(err)
		if failure.Code != "internal_error" {
			t.Fatal("unknown error did not receive a controlled fallback type")
		}
		assertSafeAnalysisDiagnostic(t, failure.Error())
	}
}
