package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func writeExample(t *testing.T, path, body, response string) {
	t.Helper()
	data := map[string]any{"log": map[string]any{"entries": []any{map[string]any{
		"request":  map[string]any{"method": "POST", "url": "https://example.com/api", "headers": []any{map[string]string{"name": "Cookie", "value": "visible=unchanged"}}, "postData": map[string]string{"mimeType": "application/json", "text": body}},
		"response": map[string]any{"status": 200, "content": map[string]string{"mimeType": "application/json", "text": response}},
	}}}}
	encoded, err := json.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, encoded, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestExamplePreviewAndLazyDetailShareImmutableSnapshot(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "capture.har")
	requestBody := strings.Repeat("q", 70000)
	responseBody := strings.Repeat("界", 30000)
	writeExample(t, filename, requestBody, responseBody)
	server := NewServer(t.TempDir())
	server.SampleHAR = filename
	noNetwork := roundTripFunc(func(*http.Request) (*http.Response, error) {
		t.Fatal("sample loading must never run a request or call an agent")
		return nil, nil
	})
	server.Runner.Client.Transport = noNetwork
	server.Analyzer.Client.Transport = noNetwork
	get := func(path string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", path, nil)
		w := httptest.NewRecorder()
		server.ServeHTTP(w, r)
		return w
	}
	w := get("/api/har/example")
	if w.Code != 200 {
		t.Fatalf("example returned %d", w.Code)
	}
	var preview ExampleResult
	if err := json.Unmarshal(w.Body.Bytes(), &preview); err != nil {
		t.Fatal(err)
	}
	if preview.Name != "capture.har" || preview.FileName != "capture.har" || preview.PreviewedResponses != 1 || preview.ResponsePreviewLimitBytes != samplePreviewLimit || !preview.FullResponseAvailable {
		t.Fatal("example metadata missing")
	}
	if len(preview.Requests) != 1 {
		t.Fatal("example request count changed")
	}
	request := preview.Requests[0]
	if !request.ResponseBodyTruncated || request.ResponseBodyBytes != len(responseBody) || len(request.ResponseBody) > samplePreviewLimit || !utf8.ValidString(request.ResponseBody) {
		t.Fatal("response preview bytes or Unicode boundary incorrect")
	}
	if request.Body != requestBody || headerValue(request.Headers, "Cookie") != "visible=unchanged" {
		t.Fatal("request body or headers were cropped")
	}
	if len(preview.Warnings) == 0 {
		t.Fatal("response preview must be explicit in warnings")
	}
	// Replacing the original file must not change IDs or detail data beneath an
	// already loaded list. A server restart is the explicit reload boundary.
	writeExample(t, filename, "replacement", "new response")
	w = get("/api/har/example/requests/req-1")
	var detail struct {
		Request Request `json:"request"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &detail); err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 || detail.Request.ResponseBody != responseBody || detail.Request.Body != requestBody || detail.Request.ResponseBodyTruncated {
		t.Fatal("lazy detail did not preserve the same complete snapshot")
	}
	for _, path := range []string{"/api/har/example/requests/req-999", "/api/har/example/requests/..%2F..%2Fgo.mod", "/api/har/example/requests/C:%5Csecret.har"} {
		if w := get(path); w.Code != 404 {
			t.Errorf("invalid detail ID returned %d", w.Code)
		}
	}
}

func TestExampleMissingAndOversizedFiles(t *testing.T) {
	server := NewServer(t.TempDir())
	server.SampleHAR = filepath.Join(t.TempDir(), "missing.har")
	r := httptest.NewRequest("GET", "/api/har/example", nil)
	w := httptest.NewRecorder()
	server.ServeHTTP(w, r)
	if w.Code != 404 {
		t.Fatalf("missing example returned %d", w.Code)
	}
	file, err := os.Create(filepath.Join(t.TempDir(), "large.har"))
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(sampleFileLimit + 1); err != nil {
		file.Close()
		t.Fatal(err)
	}
	filename := file.Name()
	file.Close()
	server.SampleHAR = filename
	w = httptest.NewRecorder()
	server.ServeHTTP(w, r)
	if w.Code != 422 {
		t.Fatalf("oversized local example returned %d", w.Code)
	}
}

func TestUploadLimitRemains32MiB(t *testing.T) {
	server := NewServer(t.TempDir())
	// Padding inside a JSON string avoids the decoder rejecting an otherwise
	// malformed payload before it reaches the real HTTP upload size boundary.
	body := `{"har":{"padding":"` + strings.Repeat("x", 32<<20) + `","log":{"entries":[]}}}`
	r := httptest.NewRequest("POST", "/api/har/parse", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	server.ServeHTTP(w, r)
	if w.Code != 413 {
		t.Fatalf("oversized upload returned %d", w.Code)
	}
}

// Opt-in integration check for a developer's locally supplied large capture.
// It emits aggregate sizes only and never replays requests or calls a model.
func TestOptionalLocalSampleSmoke(t *testing.T) {
	filename := os.Getenv("HAR_CANVAS_SAMPLE_SMOKE")
	if filename == "" {
		t.Skip("set HAR_CANVAS_SAMPLE_SMOKE to a local HAR path for the read-only integration check")
	}
	server := NewServer(t.TempDir())
	server.SampleHAR = filename
	start := time.Now()
	snapshot, err := server.loadSample()
	if err != nil {
		t.Fatal(err)
	}
	var metadata struct {
		Summary            HARSummary `json:"summary"`
		PreviewedResponses int        `json:"previewedResponses"`
		FileBytes          int64      `json:"fileBytes"`
	}
	if err := json.Unmarshal(snapshot.payload, &metadata); err != nil {
		t.Fatal(err)
	}
	if metadata.Summary.Total != len(snapshot.requests) || len(snapshot.payload) > samplePayloadLimit {
		t.Fatal("sample metadata and snapshot limits do not match")
	}
	t.Logf("fileBytes=%d requests=%d api=%d static=%d domains=%d previewedResponses=%d initialJSONBytes=%d loadMs=%d", metadata.FileBytes, metadata.Summary.Total, metadata.Summary.API, metadata.Summary.Static, len(metadata.Summary.Domains), metadata.PreviewedResponses, len(snapshot.payload), time.Since(start).Milliseconds())
}
