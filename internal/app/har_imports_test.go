package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func newImportTestServer(t *testing.T) *Server {
	t.Helper()
	server := NewServer(t.TempDir())
	t.Cleanup(func() {
		server.imports.mu.Lock()
		for id := range server.imports.items {
			server.imports.removeLocked(id)
		}
		if server.imports.expiry != nil {
			server.imports.expiry.Stop()
		}
		server.imports.mu.Unlock()
		server.imports.workers.Wait()
		server.uploads.mu.Lock()
		if server.uploads.expiry != nil {
			server.uploads.expiry.Stop()
		}
		server.uploads.mu.Unlock()
	})
	return server
}

func importHTTPRequest(server *Server, method, path string, body io.Reader, contentType string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, body)
	if contentType != "" {
		r.Header.Set("Content-Type", contentType)
	}
	r = r.WithContext(context.WithValue(r.Context(), requestIDKey{}, "synthetic-import-request-id"))
	w := httptest.NewRecorder()
	server.ServeHTTP(w, r)
	return w
}

func createImport(t *testing.T, server *Server, size int) HARImportView {
	t.Helper()
	w := importHTTPRequest(server, "POST", "/api/har/imports", strings.NewReader(fmt.Sprintf(`{"size":%d}`, size)), "application/json")
	var view HARImportView
	if w.Code != 201 || json.Unmarshal(w.Body.Bytes(), &view) != nil || view.Status != "uploading" || view.Size != int64(size) || view.ChunkSize != 1<<20 || !agentJobID.MatchString(view.ID) {
		t.Fatalf("create import returned unexpected status/view: %d", w.Code)
	}
	return view
}

func putImportChunk(server *Server, id string, offset int, chunk []byte) *httptest.ResponseRecorder {
	return importHTTPRequest(server, "PUT", fmt.Sprintf("/api/har/imports/%s/chunks?offset=%d", id, offset), bytes.NewReader(chunk), "application/octet-stream")
}

func uploadImport(t *testing.T, server *Server, raw []byte) HARImportView {
	t.Helper()
	view := createImport(t, server, len(raw))
	for offset := 0; offset < len(raw); offset += int(harImportChunkSize) {
		end := min(offset+int(harImportChunkSize), len(raw))
		w := putImportChunk(server, view.ID, offset, raw[offset:end])
		if w.Code != 200 {
			t.Fatalf("chunk returned %d", w.Code)
		}
	}
	return view
}

func importAction(server *Server, method, id, action string) *httptest.ResponseRecorder {
	path := "/api/har/imports/" + id
	if action != "" {
		path += "/" + action
	}
	return importHTTPRequest(server, method, path, nil, "")
}

func waitImport(t *testing.T, server *Server, id, status string) HARImportView {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		w := importAction(server, "GET", id, "")
		var view HARImportView
		if w.Code == 200 && json.Unmarshal(w.Body.Bytes(), &view) == nil && view.Status == status {
			return view
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("import did not become %s", status)
	return HARImportView{}
}

func syntheticImportHAR(response string) []byte {
	raw, _ := json.Marshal(map[string]any{"log": map[string]any{"pages": []any{map[string]string{"id": "page-1", "title": "synthetic page"}}, "entries": []any{map[string]any{
		"pageref": "page-1", "startedDateTime": "2026-10-23T00:00:00Z",
		"request":  map[string]any{"method": "POST", "url": "https://synthetic.invalid/details", "headers": []any{map[string]string{"name": "Cookie", "value": "synthetic-original-cookie"}}, "postData": map[string]string{"text": "synthetic-original-body", "mimeType": "application/json"}},
		"response": map[string]any{"status": 200, "content": map[string]string{"mimeType": "text/plain", "text": response}},
	}}}})
	return raw
}

func TestHARImportMultipleChunksRetriesAndFullResponseDetail(t *testing.T) {
	server := newImportTestServer(t)
	var calls atomic.Int32
	server.imports.parse = func(raw json.RawMessage) (ParseResult, error) {
		calls.Add(1)
		return ParseHAR(raw)
	}
	server.Runner.Client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
		t.Error("HAR import attempted request replay")
		return nil, errors.New("replay prohibited")
	})
	fullBody := strings.Repeat("中", 800_000)
	raw := syntheticImportHAR(fullBody)
	view := createImport(t, server, len(raw))
	if w := importAction(server, "GET", view.ID, "result"); w.Code != 409 {
		t.Fatal("unparsed import exposed a result")
	}
	first := raw[:harImportChunkSize]
	for i := 0; i < 2; i++ {
		w := putImportChunk(server, view.ID, 0, first)
		var progress HARImportView
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &progress) != nil || progress.ReceivedBytes != harImportChunkSize {
			t.Fatal("first chunk or identical confirmed retry was not idempotent")
		}
	}
	conflict := bytes.Clone(first)
	conflict[100] ^= 1
	if w := putImportChunk(server, view.ID, 0, conflict); w.Code != 409 {
		t.Fatal("different content at confirmed offset was accepted")
	}
	if w := putImportChunk(server, view.ID, int(2*harImportChunkSize), raw[2*harImportChunkSize:]); w.Code != 409 {
		t.Fatal("future offset was accepted")
	}
	if w := importAction(server, "POST", view.ID, "complete"); w.Code != 409 || calls.Load() != 0 {
		t.Fatal("incomplete file started parsing")
	}
	for offset := int(harImportChunkSize); offset < len(raw); offset += int(harImportChunkSize) {
		if w := putImportChunk(server, view.ID, offset, raw[offset:min(offset+int(harImportChunkSize), len(raw))]); w.Code != 200 {
			t.Fatalf("remaining chunk failed: %d", w.Code)
		}
	}
	if w := importAction(server, "POST", view.ID, "complete"); w.Code != 202 {
		t.Fatalf("complete did not immediately return accepted: %d", w.Code)
	}
	finished := waitImport(t, server, view.ID, "completed")
	server.imports.workers.Wait()
	if finished.RequestID != "synthetic-import-request-id" || calls.Load() != 1 || len(server.uploadSlots) != 0 {
		t.Fatal("completion lost correlation, repeated parsing, or retained its slot")
	}
	if w := importAction(server, "POST", view.ID, "complete"); w.Code != 200 || calls.Load() != 1 {
		t.Fatal("completed import was parsed again")
	}
	result := importAction(server, "GET", view.ID, "result")
	var parsed ParseResult
	if result.Code != 200 || json.Unmarshal(result.Body.Bytes(), &parsed) != nil || len(parsed.Requests) != 1 || len(parsed.Pages) != 1 {
		t.Fatal("completed result lost original capture structure")
	}
	request := parsed.Requests[0]
	if request.Body != "synthetic-original-body" || request.Headers["Cookie"] != "synthetic-original-cookie" || request.PageID != "page-1" || !request.ResponseBodyTruncated || len(request.ResponseBody) > uploadPreviewLimit {
		t.Fatal("import changed original request values or failed to preview the response")
	}
	detail := importHTTPRequest(server, "GET", request.ResponseDetailURL, nil, "")
	var full struct{ Request Request }
	if detail.Code != 200 || json.Unmarshal(detail.Body.Bytes(), &full) != nil || full.Request.ResponseBody != fullBody {
		t.Fatal("full captured response was lost")
	}
	deleted := importAction(server, "DELETE", view.ID, "")
	var afterDelete HARImportView
	if deleted.Code != 200 || json.Unmarshal(deleted.Body.Bytes(), &afterDelete) != nil || afterDelete.Status != "completed" || importAction(server, "GET", view.ID, "result").Code != 200 || importHTTPRequest(server, "GET", request.ResponseDetailURL, nil, "").Code != 200 {
		t.Fatal("terminal cleanup revoked a successful import or detail")
	}
	server.imports.mu.Lock()
	defer server.imports.mu.Unlock()
	if len(server.imports.items[view.ID].raw) != 0 {
		t.Fatal("completed import retained its raw upload buffer")
	}
}

type interruptedImportBody struct{ data []byte }

func (b *interruptedImportBody) Read(p []byte) (int, error) {
	if len(b.data) == 0 {
		return 0, io.ErrUnexpectedEOF
	}
	n := copy(p, b.data)
	b.data = b.data[n:]
	return n, nil
}
func (*interruptedImportBody) Close() error { return nil }

func TestHARImportInterruptedAndWrongSizeChunksNeverAdvanceOffset(t *testing.T) {
	server := newImportTestServer(t)
	raw := syntheticImportHAR("synthetic response")
	view := createImport(t, server, len(raw))
	path := "/api/har/imports/" + view.ID + "/chunks?offset=0"
	w := importHTTPRequest(server, "PUT", path, &interruptedImportBody{data: raw[:len(raw)/2]}, "application/octet-stream")
	if w.Code != 400 || !strings.Contains(w.Body.String(), "upload_incomplete") {
		t.Fatal("interrupted body did not produce a controlled incomplete-upload failure")
	}
	if w = putImportChunk(server, view.ID, 0, raw[:len(raw)-1]); w.Code != 400 {
		t.Fatal("short chunk was accepted")
	}
	server.imports.mu.Lock()
	item := server.imports.items[view.ID]
	unchanged := item.view.ReceivedBytes == 0 && len(item.raw) == 0 && !item.reading
	server.imports.mu.Unlock()
	if !unchanged || importAction(server, "POST", view.ID, "complete").Code != 409 {
		t.Fatal("partial chunk polluted import state or allowed completion")
	}
	if w = putImportChunk(server, view.ID, 0, raw); w.Code != 200 {
		t.Fatal("complete retry failed after an interrupted chunk")
	}
	if importAction(server, "POST", view.ID, "complete").Code != 202 {
		t.Fatal("retried full upload could not complete")
	}
	waitImport(t, server, view.ID, "completed")
}

func TestHARImportCancellationKeepsParserSlotAndCannotPublishLate(t *testing.T) {
	server := newImportTestServer(t)
	for i := 0; i < 3; i++ {
		if err := server.uploads.put(fmt.Sprintf("retained-%d", i), []Request{{ID: "req-1", ResponseBody: "kept"}}); err != nil {
			t.Fatal(err)
		}
	}
	entered, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	server.imports.parse = func(raw json.RawMessage) (ParseResult, error) {
		calls.Add(1)
		close(entered)
		<-release
		return ParseHAR(raw)
	}
	defer close(release)
	first := uploadImport(t, server, syntheticImportHAR("late result"))
	second := createImport(t, server, 1)
	ctx, cancel := context.WithCancel(context.Background())
	r := httptest.NewRequest("POST", "/api/har/imports/"+first.ID+"/complete", nil).WithContext(ctx)
	w := httptest.NewRecorder()
	server.ServeHTTP(w, r)
	if w.Code != 202 {
		t.Fatal("complete failed")
	}
	<-entered
	cancel()
	if importAction(server, "GET", first.ID, "").Code != 200 {
		t.Fatal("closing complete request removed the detached parser")
	}
	if repeated := importAction(server, "POST", first.ID, "complete"); repeated.Code != 202 || calls.Load() != 1 {
		t.Fatal("running complete was not idempotent")
	}
	if importAction(server, "DELETE", first.ID, "").Code != 200 {
		t.Fatal("parser cancellation failed")
	}
	waitImport(t, server, first.ID, "cancelled")
	if len(server.uploadSlots) != 2 {
		t.Fatal("cancellation freed a parser slot before its worker exited")
	}
	busy := importHTTPRequest(server, "POST", "/api/har/imports", strings.NewReader(`{"size":1}`), "application/json")
	if busy.Code != 429 || uploadTestHAR(t, server, `{"log":{"entries":[]}}`).Code != 429 {
		t.Fatal("legacy and chunk imports did not share active slots")
	}
	release <- struct{}{}
	server.imports.workers.Wait()
	if len(server.uploadSlots) != 1 || importAction(server, "GET", first.ID, "result").Code != 409 {
		t.Fatal("cancelled worker retained a slot or exposed a late result")
	}
	server.uploads.mu.Lock()
	retained := len(server.uploads.items) == 3
	for i := 0; i < 3; i++ {
		_, exists := server.uploads.items[fmt.Sprintf("retained-%d", i)]
		retained = retained && exists
	}
	server.uploads.mu.Unlock()
	if !retained {
		t.Fatal("cancelled parser committed or evicted a complete capture")
	}
	third := createImport(t, server, 1)
	importAction(server, "DELETE", second.ID, "")
	importAction(server, "DELETE", third.ID, "")
	if len(server.uploadSlots) != 0 {
		t.Fatal("cancelling idle uploads did not release resources")
	}
}

func TestHARImportIdleAndTerminalExpiryAndCapacity(t *testing.T) {
	server := newImportTestServer(t)
	var now atomic.Int64
	now.Store(time.Now().UnixNano())
	server.imports.now = func() time.Time { return time.Unix(0, now.Load()) }
	server.imports.limit = 3
	first, second := createImport(t, server, 1), createImport(t, server, 1)
	now.Add(int64(15 * time.Minute))
	if importAction(server, "GET", first.ID, "").Code != 404 || importAction(server, "GET", second.ID, "").Code != 404 || len(server.uploadSlots) != 0 {
		t.Fatal("idle imports failed to expire and release their buffers/slots")
	}
	active := createImport(t, server, 1)
	var terminalIDs []string
	for i := 0; i < 4; i++ {
		now.Add(int64(time.Second))
		view := createImport(t, server, 1)
		terminalIDs = append(terminalIDs, view.ID)
		importAction(server, "DELETE", view.ID, "")
	}
	if importAction(server, "GET", active.ID, "").Code != 200 || importAction(server, "GET", terminalIDs[0], "").Code != 404 {
		t.Fatal("record capacity evicted an active import or retained the oldest terminal")
	}
	server.imports.mu.Lock()
	count := len(server.imports.items)
	server.imports.mu.Unlock()
	if count > 3 {
		t.Fatal("import metadata exceeded its cap")
	}
	importAction(server, "DELETE", active.ID, "")
	now.Add(int64(30 * time.Minute))
	if importAction(server, "GET", terminalIDs[len(terminalIDs)-1], "").Code != 404 {
		t.Fatal("terminal import polling extended retention")
	}
}

func TestHARImportResultBudgetEvictsOldTerminalInsteadOfFailingNewImport(t *testing.T) {
	server := newImportTestServer(t)
	raw := syntheticImportHAR("small response")
	first := uploadImport(t, server, raw)
	importAction(server, "POST", first.ID, "complete")
	waitImport(t, server, first.ID, "completed")
	server.imports.workers.Wait()
	server.imports.mu.Lock()
	server.imports.resultLimit = len(server.imports.items[first.ID].result) + 4
	server.imports.mu.Unlock()
	second := uploadImport(t, server, raw)
	importAction(server, "POST", second.ID, "complete")
	waitImport(t, server, second.ID, "completed")
	if importAction(server, "GET", first.ID, "result").Code != 404 || importAction(server, "GET", second.ID, "result").Code != 200 {
		t.Fatal("result budget rejected a valid new import or retained an over-budget old result")
	}
}

func TestHARImportInputLimitsAndFailuresAreExplicit(t *testing.T) {
	server := newImportTestServer(t)
	for _, input := range []string{`{"size":0}`, `{"size":-1}`, `{"size":268435457}`} {
		if importHTTPRequest(server, "POST", "/api/har/imports", strings.NewReader(input), "application/json").Code < 400 {
			t.Fatal("invalid file size accepted")
		}
	}
	view := createImport(t, server, int(harImportChunkSize))
	if putImportChunk(server, view.ID, 0, make([]byte, int(harImportChunkSize)+1)).Code != 413 {
		t.Fatal("oversized chunk bypassed the per-request limit")
	}
	if importAction(server, "GET", view.ID, "chunks").Code != 405 || importAction(server, "POST", view.ID, "result").Code != 405 {
		t.Fatal("invalid import methods accepted")
	}
	importAction(server, "DELETE", view.ID, "")
	for _, panicParser := range []bool{false, true} {
		server.imports.parse = func(json.RawMessage) (ParseResult, error) {
			if panicParser {
				panic("synthetic-secret-parser-text")
			}
			return ParseResult{}, errors.New("synthetic-secret-parser-text")
		}
		invalid := uploadImport(t, server, []byte("invalid"))
		importAction(server, "POST", invalid.ID, "complete")
		failed := waitImport(t, server, invalid.ID, "failed")
		server.imports.workers.Wait()
		if failed.Error == "" || failed.ErrorCode == "" || strings.Contains(failed.Error, "synthetic-secret") || len(server.uploadSlots) != 0 {
			t.Fatal("parser failure was hidden, echoed raw data, or leaked active resources")
		}
	}
}

type blockedImportBody struct {
	data    []byte
	started chan struct{}
	release chan struct{}
	once    atomic.Bool
}

func (b *blockedImportBody) Read(p []byte) (int, error) {
	if b.once.CompareAndSwap(false, true) {
		close(b.started)
	}
	<-b.release
	if len(b.data) == 0 {
		return 0, io.EOF
	}
	n := copy(p, b.data)
	b.data = b.data[n:]
	return n, nil
}

// Deliberately emulate a body implementation that does not unblock in Close:
// cancellation must retain its resource slot until the active read exits.
func (*blockedImportBody) Close() error { return nil }

func TestHARImportConcurrentChunkAndCancelledReadRetainResourceAccounting(t *testing.T) {
	server := newImportTestServer(t)
	raw := syntheticImportHAR("response")
	first, second := createImport(t, server, len(raw)), createImport(t, server, 1)
	started, release := make(chan struct{}), make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	finished := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		finished <- importHTTPRequest(server, "PUT", "/api/har/imports/"+first.ID+"/chunks?offset=0", &blockedImportBody{data: raw, started: started, release: release}, "application/octet-stream")
	}()
	<-started
	if putImportChunk(server, first.ID, 0, raw).Code != 409 {
		t.Fatal("overlapping in-flight chunk reads were accepted")
	}
	importAction(server, "DELETE", first.ID, "")
	if len(server.uploadSlots) != 2 || importHTTPRequest(server, "POST", "/api/har/imports", strings.NewReader(`{"size":1}`), "application/json").Code != 429 {
		t.Fatal("cancelled but still-active chunk read released its capacity early")
	}
	close(release)
	if response := <-finished; response.Code != 409 {
		t.Fatal("a cancelled chunk committed bytes after its read completed")
	}
	view := waitImport(t, server, first.ID, "cancelled")
	if view.ReceivedBytes != 0 || len(server.uploadSlots) != 1 {
		t.Fatal("cancelled read polluted committed byte count or retained a resource slot")
	}
	third := createImport(t, server, 1)
	importAction(server, "DELETE", second.ID, "")
	importAction(server, "DELETE", third.ID, "")
}

func TestHARImportExpiryTimerReleasesIdleUploadWithoutPolling(t *testing.T) {
	server := newImportTestServer(t)
	server.imports.idleTTL = 20 * time.Millisecond
	createImport(t, server, 1)
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		server.imports.mu.Lock()
		cleared := len(server.imports.items) == 0 && server.imports.expiry == nil
		server.imports.mu.Unlock()
		if cleared && len(server.uploadSlots) == 0 {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("idle import cleanup depended on another request")
}
