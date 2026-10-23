package app

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRequestLogCorrelatesWithoutRecordingPrivateData(t *testing.T) {
	var logs bytes.Buffer
	handler := requestLogging(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if RequestID(r.Context()) == "" || RequestID(r.Context()) != w.Header().Get("X-Request-ID") {
			t.Error("request correlation ID is missing")
		}
		writeError(w, http.StatusBadGateway, "模拟错误")
	}), log.New(&logs, "", 0))
	r := httptest.NewRequest("POST", "/api/agent/jobs?key=private-query", strings.NewReader(`{"apiKey":"private-body"}`))
	r.Header.Set("Authorization", "Bearer private-header")
	r.Header.Set("Cookie", "private-cookie")
	r.Header.Set("X-Request-ID", "untrusted-client-id")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != http.StatusBadGateway || w.Header().Get("X-Request-ID") == "untrusted-client-id" {
		t.Fatal("status or server-generated ID lost")
	}
	text := logs.String()
	for _, value := range []string{"private-query", "private-body", "private-header", "private-cookie", "untrusted-client-id"} {
		if strings.Contains(text, value) {
			t.Fatalf("private input leaked into logs: %s", value)
		}
	}
	if !strings.Contains(text, "route=/api/agent/jobs status=502 duration_ms=") || !strings.Contains(text, w.Header().Get("X-Request-ID")) {
		t.Fatal("missing useful request diagnostics")
	}
}

func TestRequestLogMasksUnrecognizedPathsAndReturnsJSONOnPanic(t *testing.T) {
	var logs bytes.Buffer
	handler := requestLogging(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("private-panic-value")
	}), log.New(&logs, "", 0))
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest("GET", "/private-path-value?token=private-query", nil))
	var result map[string]string
	if w.Code != 500 || json.Unmarshal(w.Body.Bytes(), &result) != nil || result["error"] == "" {
		t.Fatal("panic must produce an explicit JSON error")
	}
	if strings.Contains(logs.String(), "private-") || !strings.Contains(logs.String(), "http_panic") || !strings.Contains(logs.String(), "route=other") {
		t.Fatal("panic or unknown route leaked private text")
	}
}
