package app

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestServerAPIAndSPAFallback(t *testing.T) {
	web := t.TempDir()
	if err := os.WriteFile(filepath.Join(web, "index.html"), []byte("<html>canvas</html>"), 0600); err != nil {
		t.Fatal(err)
	}
	server := NewServer(web)
	for _, test := range []struct {
		method, path, body, contentType string
		status                          int
	}{
		{"GET", "/api/health", "", "", 200},
		{"POST", "/api/health", "{}", "application/json", 405},
		{"POST", "/api/har/parse", `{"har":{"log":{"entries":[]}}}`, "application/json", 200},
		{"POST", "/api/har/parse", `{"har":{}}`, "application/json", 400},
		{"POST", "/api/har/parse", `{"har":{}}`, "text/plain", 415},
		{"POST", "/api/flow/run", `{"nodes":[],"edges":[]}`, "application/json", 400},
		{"GET", "/api/unknown", "", "", 404},
		{"GET", "/project/123", "", "", 200},
		{"GET", "/missing.js", "", "", 404},
		{"GET", "/..%5Cgo.mod", "", "", 404},
	} {
		r := httptest.NewRequest(test.method, test.path, strings.NewReader(test.body))
		if test.contentType != "" {
			r.Header.Set("Content-Type", test.contentType)
		}
		w := httptest.NewRecorder()
		server.ServeHTTP(w, r)
		if w.Code != test.status {
			t.Errorf("%s %s returned %d: %s", test.method, test.path, w.Code, w.Body)
		}
	}
	flow := Flow{Nodes: []FlowNode{block("input", BlockData{Kind: "input", Variable: "name", Value: "世界"}), block("out", BlockData{Kind: "output", Template: "你好，{{name}}"})}, Edges: []FlowEdge{connect("input", "out")}}
	body, _ := json.Marshal(flow)
	r := httptest.NewRequest(http.MethodPost, "/api/flow/run", bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	server.ServeHTTP(w, r)
	var result RunResult
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || result.Output != "你好，世界" || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("API integration failed: %s %v", w.Body, err)
	}
}
