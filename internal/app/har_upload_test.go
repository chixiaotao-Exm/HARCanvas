package app

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func uploadTestHAR(t *testing.T, server *Server, raw string) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", "capture.har")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.WriteString(part, raw)
	_ = writer.Close()
	request := httptest.NewRequest("POST", "/api/har/upload", &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	return response
}
func TestUploadLargeHARPreservesOriginalAndOffersBoundedPreview(t *testing.T) {
	server := NewServer(t.TempDir())
	responseText := strings.Repeat("中", 12<<20)
	raw, _ := json.Marshal(map[string]any{"log": map[string]any{"pages": []any{map[string]any{"id": "page-1", "title": "演示", "startedDateTime": "2026-10-23T00:00:00Z"}}, "entries": []any{map[string]any{"pageref": "page-1", "startedDateTime": "2026-10-23T00:00:01Z", "request": map[string]any{"url": "https://example.test/data", "method": "POST", "postData": map[string]string{"text": "original-body"}}, "response": map[string]any{"status": 200, "content": map[string]string{"mimeType": "text/plain", "text": responseText}}}}}})
	if len(raw) <= 32<<20 {
		t.Fatal("fixture does not prove large upload support")
	}
	response := uploadTestHAR(t, server, string(raw))
	if response.Code != http.StatusOK {
		t.Fatalf("upload status %d", response.Code)
	}
	var parsed ParseResult
	if err := json.Unmarshal(response.Body.Bytes(), &parsed); err != nil {
		t.Fatal(err)
	}
	if len(parsed.Requests) != 1 || len(parsed.Pages) != 1 {
		t.Fatal("lost provenance")
	}
	request := parsed.Requests[0]
	if request.PageID != "page-1" || request.StartedDateTime == "" || request.Body != "original-body" || !request.ResponseBodyTruncated || len(request.ResponseBody) > uploadPreviewLimit || request.ResponseDetailURL == "" {
		t.Fatal("wrong import preview or provenance")
	}
	details := httptest.NewRecorder()
	server.ServeHTTP(details, httptest.NewRequest("GET", request.ResponseDetailURL, nil))
	var full struct {
		Request Request `json:"request"`
	}
	_ = json.Unmarshal(details.Body.Bytes(), &full)
	if details.Code != 200 || full.Request.ResponseBody != responseText {
		t.Fatal("complete response lost")
	}
}
func TestUploadRejectsMalformedHARWithoutFallingBackToSample(t *testing.T) {
	server := NewServer(t.TempDir())
	for _, raw := range []string{"", `{"log":{}}`, "invalid"} {
		response := uploadTestHAR(t, server, raw)
		if response.Code < 400 {
			t.Fatal("bad HAR accepted")
		}
	}
}

func TestRejectedUploadDoesNotStoreDataOrEvictUsableCaptures(t *testing.T) {
	server := NewServer(t.TempDir())
	for i := 0; i < 3; i++ {
		if err := server.uploads.put(fmt.Sprintf("existing-%d", i), []Request{{ID: "req-1", ResponseBody: "kept"}}); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := json.Marshal(map[string]any{"log": map[string]any{"entries": []any{map[string]any{
		"request":  map[string]any{"method": "POST", "url": "https://example.test/data", "headers": []any{map[string]string{"name": "X-Large", "value": strings.Repeat("x", 32<<20)}}},
		"response": map[string]any{"status": 200, "content": map[string]string{"text": "rejected capture"}},
	}}}})
	if err != nil {
		t.Fatal(err)
	}
	response := uploadTestHAR(t, server, string(raw))
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized preview status %d", response.Code)
	}
	server.uploads.mu.Lock()
	defer server.uploads.mu.Unlock()
	if len(server.uploads.items) != 3 {
		t.Fatal("rejected upload changed stored captures")
	}
	for i := 0; i < 3; i++ {
		if _, ok := server.uploads.items[fmt.Sprintf("existing-%d", i)]; !ok {
			t.Fatal("rejected upload evicted an existing capture")
		}
	}
}

func TestUploadStoreCountsMetadataAndRejectsOversizeBeforeEviction(t *testing.T) {
	store := newHARUploadStore()
	if err := store.put("existing", []Request{{ID: "req-1", ResponseBody: "kept"}}); err != nil {
		t.Fatal(err)
	}
	// Shared strings keep this fixture small while representing over 512 MiB
	// of retained request/header content in the store's accounting.
	header := strings.Repeat("x", 1<<20)
	requests := make([]Request, 513)
	for i := range requests {
		requests[i] = Request{ID: fmt.Sprintf("req-%d", i), Headers: map[string]string{"X-Large": header}}
	}
	if err := store.put("too-large", requests); err == nil {
		t.Fatal("metadata bypassed the stored-content limit")
	}
	if _, ok := store.get("existing", "req-1"); !ok {
		t.Fatal("oversized replacement evicted existing data")
	}
}
