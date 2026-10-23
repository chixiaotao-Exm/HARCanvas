package app

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

const harImportChunkSize int64 = 1 << 20

type HARImportView struct {
	ID            string `json:"id"`
	Status        string `json:"status"`
	Size          int64  `json:"size"`
	ReceivedBytes int64  `json:"receivedBytes"`
	ChunkSize     int64  `json:"chunkSize"`
	Error         string `json:"error,omitempty"`
	ErrorCode     string `json:"errorCode,omitempty"`
	RequestID     string `json:"requestId,omitempty"`
}

type harImport struct {
	view       HARImportView
	raw        []byte
	result     []byte
	updatedAt  time.Time
	finishedAt time.Time
	ctx        context.Context
	cancel     context.CancelFunc
	reading    bool
	worker     bool
	slotHeld   bool
}

type harImportStore struct {
	mu          sync.Mutex
	items       map[string]*harImport
	slots       chan struct{}
	expiry      *time.Timer
	idleTTL     time.Duration
	terminalTTL time.Duration
	limit       int
	resultLimit int
	now         func() time.Time
	parse       func(json.RawMessage) (ParseResult, error)
	workers     sync.WaitGroup
}

func newHARImportStore(slots chan struct{}) *harImportStore {
	return &harImportStore{items: map[string]*harImport{}, slots: slots, idleTTL: 15 * time.Minute, terminalTTL: 30 * time.Minute, limit: 32, resultLimit: 64 << 20, now: time.Now, parse: ParseHAR}
}

func (s *harImportStore) releaseLocked(item *harImport) {
	if item.slotHeld && !item.reading && !item.worker && item.view.Status != "uploading" && item.view.Status != "parsing" {
		item.slotHeld = false
		<-s.slots
	}
}

func (s *harImportStore) removeLocked(id string) {
	item := s.items[id]
	if item == nil {
		return
	}
	delete(s.items, id)
	item.cancel()
	item.raw = nil
	item.result = nil
	if item.view.Status == "uploading" || item.view.Status == "parsing" {
		item.view.Status = "cancelled"
	}
	s.releaseLocked(item)
}

func (s *harImportStore) pruneLocked() {
	now := s.now()
	for id, item := range s.items {
		if item.view.Status == "uploading" && now.Sub(item.updatedAt) >= s.idleTTL || !item.finishedAt.IsZero() && now.Sub(item.finishedAt) >= s.terminalTTL {
			s.removeLocked(id)
		}
	}
}

func (s *harImportStore) scheduleLocked() {
	if s.expiry != nil {
		return
	}
	var next time.Time
	for _, item := range s.items {
		at := item.finishedAt.Add(s.terminalTTL)
		if item.view.Status == "uploading" {
			at = item.updatedAt.Add(s.idleTTL)
		} else if item.finishedAt.IsZero() {
			continue
		}
		if next.IsZero() || at.Before(next) {
			next = at
		}
	}
	if next.IsZero() {
		return
	}
	delay := next.Sub(s.now())
	if delay < time.Millisecond {
		delay = time.Millisecond
	}
	s.expiry = time.AfterFunc(delay, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		s.expiry = nil
		s.pruneLocked()
		s.scheduleLocked()
	})
}

func (s *harImportStore) oldestTerminalLocked(except string, requireResult bool) string {
	oldestID := ""
	var oldest time.Time
	for id, item := range s.items {
		if id == except || item.finishedAt.IsZero() || item.worker || item.reading || requireResult && len(item.result) == 0 {
			continue
		}
		if oldestID == "" || item.finishedAt.Before(oldest) {
			oldestID, oldest = id, item.finishedAt
		}
	}
	return oldestID
}

// The result budget is separate from the two bounded raw uploads and the
// existing 512 MiB complete-response store. Old terminal results may expire
// earlier under memory pressure; active imports are never evicted for capacity.
func (s *harImportStore) reserveResultLocked(id string, size int) bool {
	for {
		total := size
		for key, item := range s.items {
			if key != id {
				total += len(item.result)
			}
		}
		if total <= s.resultLimit {
			return true
		}
		oldest := s.oldestTerminalLocked(id, true)
		if oldest == "" {
			return false
		}
		s.removeLocked(oldest)
	}
}

func (s *Server) createHARImport(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		methodError(w, "POST")
		return
	}
	var input struct {
		Size int64 `json:"size"`
	}
	if !decodeBody(w, r, &input) {
		return
	}
	if input.Size <= 0 || input.Size > sampleFileLimit {
		writeHARFailure(w, harFailure{400, "invalid_size", "请选择非空且不超过 256 MiB 的 HAR 文件。"})
		return
	}
	id, err := newHARUploadID()
	if err != nil {
		writeHARFailure(w, harFailure{500, "import_create_failed", "无法创建导入记录，请重试。"})
		return
	}
	store := s.imports
	store.mu.Lock()
	store.pruneLocked()
	select {
	case store.slots <- struct{}{}:
	default:
		store.mu.Unlock()
		writeHARFailure(w, harFailure{429, "import_busy", "已有两个 HAR 正在上传或解析，请完成或取消后重试。"})
		return
	}
	for len(store.items) >= store.limit {
		oldest := store.oldestTerminalLocked("", false)
		if oldest == "" {
			<-store.slots
			store.mu.Unlock()
			writeHARFailure(w, harFailure{429, "import_limit", "导入记录已达上限，请稍后重试。"})
			return
		}
		store.removeLocked(oldest)
	}
	ctx, cancel := context.WithCancel(context.Background())
	view := HARImportView{ID: id, Status: "uploading", Size: input.Size, ChunkSize: harImportChunkSize, RequestID: RequestID(r.Context())}
	store.items[id] = &harImport{view: view, ctx: ctx, cancel: cancel, updatedAt: store.now(), slotHeld: true}
	store.scheduleLocked()
	store.mu.Unlock()
	logHARStage(view.RequestID, id, "created", "", time.Now(), 0, input.Size)
	writeJSON(w, http.StatusCreated, view)
}

func (s *Server) serveHARImport(w http.ResponseWriter, r *http.Request, suffix string) {
	parts := strings.Split(suffix, "/")
	if len(parts) > 2 || !agentJobID.MatchString(parts[0]) {
		writeHARFailure(w, harFailure{404, "import_expired", "导入记录不存在或已过期，请重新导入 HAR。"})
		return
	}
	id := parts[0]
	if len(parts) == 2 {
		switch parts[1] {
		case "chunks":
			s.uploadHARChunk(w, r, id)
		case "complete":
			s.completeHARImport(w, r, id)
		case "result":
			s.serveHARImportResult(w, r, id)
		default:
			writeHARFailure(w, harFailure{404, "import_not_found", "导入接口不存在。"})
		}
		return
	}
	if r.Method != "GET" && r.Method != "DELETE" {
		methodError(w, "GET, DELETE")
		return
	}
	store := s.imports
	store.mu.Lock()
	store.pruneLocked()
	item := store.items[id]
	if item == nil {
		store.mu.Unlock()
		writeHARFailure(w, harFailure{404, "import_expired", "导入记录不存在或已过期，请重新导入 HAR。"})
		return
	}
	if r.Method == "DELETE" && (item.view.Status == "uploading" || item.view.Status == "parsing") {
		item.view.Status = "cancelled"
		item.finishedAt = store.now()
		item.raw = nil
		item.cancel()
		store.releaseLocked(item)
		store.scheduleLocked()
	}
	view := item.view
	store.mu.Unlock()
	if r.Method == "DELETE" {
		logHARStage(RequestID(r.Context()), id, "cancel", "", time.Now(), view.ReceivedBytes, view.Size)
	}
	writeJSON(w, 200, view)
}

func (s *Server) uploadHARChunk(w http.ResponseWriter, r *http.Request, id string) {
	started := time.Now()
	if r.Method != "PUT" {
		methodError(w, "PUT")
		return
	}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/octet-stream" {
		writeHARFailure(w, harFailure{415, "invalid_chunk_type", "请以 application/octet-stream 上传文件分片。"})
		return
	}
	offsetText := r.URL.Query().Get("offset")
	offset, err := strconv.ParseInt(offsetText, 10, 64)
	if err != nil || offset < 0 || offset%harImportChunkSize != 0 {
		writeHARFailure(w, harFailure{409, "chunk_offset_conflict", "分片位置无效，请查询已接收字节后继续。"})
		return
	}
	store := s.imports
	store.mu.Lock()
	store.pruneLocked()
	item := store.items[id]
	if item == nil {
		store.mu.Unlock()
		writeHARFailure(w, harFailure{404, "import_expired", "导入记录不存在或已过期，请重新导入 HAR。"})
		return
	}
	if item.view.Status != "uploading" || item.reading || offset > item.view.ReceivedBytes || offset >= item.view.Size {
		store.mu.Unlock()
		writeHARFailure(w, harFailure{409, "chunk_state_conflict", "当前不能接收该分片，请查询导入状态后继续。"})
		return
	}
	expected := min(harImportChunkSize, item.view.Size-offset)
	item.reading = true
	item.updatedAt = store.now()
	store.mu.Unlock()
	defer func() {
		store.mu.Lock()
		item.reading = false
		store.releaseLocked(item)
		store.mu.Unlock()
	}()
	r.Body = http.MaxBytesReader(w, r.Body, harImportChunkSize)
	stop := context.AfterFunc(item.ctx, func() { _ = r.Body.Close() })
	defer stop()
	chunk, readErr := io.ReadAll(r.Body)
	if readErr != nil {
		failure := harReadFailure(r.Context(), readErr)
		if item.ctx.Err() != nil {
			failure = harReadFailure(item.ctx, readErr)
		}
		logHARStage(RequestID(r.Context()), id, "chunk_read_failed", failure.code, started, int64(len(chunk)), expected)
		writeHARFailure(w, failure)
		return
	}
	if r.Context().Err() != nil {
		failure := harReadFailure(r.Context(), r.Context().Err())
		logHARStage(RequestID(r.Context()), id, "chunk_read_failed", failure.code, started, int64(len(chunk)), expected)
		writeHARFailure(w, failure)
		return
	}
	if int64(len(chunk)) != expected {
		logHARStage(RequestID(r.Context()), id, "chunk_read_failed", "chunk_size_mismatch", started, int64(len(chunk)), expected)
		writeHARFailure(w, harFailure{400, "chunk_size_mismatch", "分片未完整上传或大小不正确，请从已确认的位置重试。"})
		return
	}
	store.mu.Lock()
	if store.items[id] != item || item.view.Status != "uploading" || item.ctx.Err() != nil {
		store.mu.Unlock()
		writeHARFailure(w, harFailure{409, "chunk_state_conflict", "导入已取消或过期，请重新导入。"})
		return
	}
	if offset < item.view.ReceivedBytes {
		end := offset + int64(len(chunk))
		if end > item.view.ReceivedBytes || !bytes.Equal(item.raw[int(offset):int(end)], chunk) {
			store.mu.Unlock()
			writeHARFailure(w, harFailure{409, "chunk_content_conflict", "该位置已接收不同内容，请重新导入原文件。"})
			return
		}
	} else if offset == item.view.ReceivedBytes {
		// Bound capacity growth by declared size, including the final fragment.
		needed := len(item.raw) + len(chunk)
		if needed > cap(item.raw) {
			capacity := min(int(item.view.Size), max(needed, cap(item.raw)*2))
			grown := make([]byte, len(item.raw), capacity)
			copy(grown, item.raw)
			item.raw = grown
		}
		item.raw = append(item.raw, chunk...)
		item.view.ReceivedBytes += int64(len(chunk))
	} else {
		store.mu.Unlock()
		writeHARFailure(w, harFailure{409, "chunk_offset_conflict", "分片位置冲突，请查询已接收字节后继续。"})
		return
	}
	item.updatedAt = store.now()
	view := item.view
	store.mu.Unlock()
	logHARStage(RequestID(r.Context()), id, "chunk_committed", "", started, view.ReceivedBytes, view.Size)
	writeJSON(w, 200, view)
}

func (s *Server) completeHARImport(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != "POST" {
		methodError(w, "POST")
		return
	}
	store := s.imports
	store.mu.Lock()
	store.pruneLocked()
	item := store.items[id]
	if item == nil {
		store.mu.Unlock()
		writeHARFailure(w, harFailure{404, "import_expired", "导入记录不存在或已过期，请重新导入 HAR。"})
		return
	}
	if item.view.Status != "uploading" {
		view := item.view
		store.mu.Unlock()
		status := 200
		if view.Status == "parsing" {
			status = 202
		}
		writeJSON(w, status, view)
		return
	}
	if item.reading || item.view.ReceivedBytes != item.view.Size {
		store.mu.Unlock()
		writeHARFailure(w, harFailure{409, "upload_incomplete", "文件尚未完整上传，请继续上传剩余分片。"})
		return
	}
	item.view.Status = "parsing"
	item.view.RequestID = RequestID(r.Context())
	item.worker = true
	raw := item.raw
	item.raw = nil
	view := item.view
	store.workers.Add(1)
	store.mu.Unlock()
	go s.runHARImport(item, raw)
	writeJSON(w, 202, view)
}

func (s *Server) runHARImport(item *harImport, raw []byte) {
	store := s.imports
	started := time.Now()
	id, requestID, size := item.view.ID, item.view.RequestID, item.view.Size
	var failure *harFailure
	defer func() {
		if recover() != nil {
			failure = &harFailure{500, "parse_internal_error", "HAR 解析发生内部错误，请重新导入。"}
		}
		store.mu.Lock()
		if store.items[id] == item && item.view.Status == "parsing" {
			if failure == nil {
				failure = &harFailure{500, "parse_internal_error", "HAR 解析未能完成，请重新导入。"}
			}
			item.view.Status = "failed"
			item.view.Error, item.view.ErrorCode = failure.message, failure.code
			item.finishedAt = store.now()
		}
		item.worker = false
		item.cancel()
		store.releaseLocked(item)
		store.scheduleLocked()
		view := item.view
		store.mu.Unlock()
		logHARStage(requestID, id, view.Status, view.ErrorCode, started, view.ReceivedBytes, size)
		store.workers.Done()
	}()
	logHARStage(requestID, id, "parse_start", "", started, int64(len(raw)), size)
	parsed, err := store.parse(raw)
	raw = nil
	if err != nil {
		failure = &harFailure{400, "invalid_har", "HAR 格式无效或记录数量超过限制，请检查文件后重新导入。"}
		return
	}
	if item.ctx.Err() != nil {
		return
	}
	logHARStage(requestID, id, "parse_done", "", started, size, size)
	uploadID, err := newHARUploadID()
	if err != nil {
		failure = &harFailure{500, "import_create_failed", "无法保存导入记录，请重新导入。"}
		return
	}
	_, encoded, previewFailure := prepareHARPreview(parsed, uploadID)
	if previewFailure != nil {
		failure = previewFailure
		return
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	// DELETE and expiry cannot interleave between the last cancellation check,
	// full-response retention (which can evict), and publishing the result.
	if store.items[id] != item || item.view.Status != "parsing" || item.ctx.Err() != nil {
		return
	}
	if len(encoded) > store.resultLimit {
		failure = &harFailure{413, "result_too_large", "解析结果超过内存保留上限，请缩小抓包范围。"}
		return
	}
	if !store.reserveResultLocked(id, len(encoded)) {
		failure = &harFailure{413, "result_too_large", "解析结果超过内存保留上限，请缩小抓包范围。"}
		return
	}
	if err := s.uploads.put(uploadID, parsed.Requests); err != nil {
		failure = &harFailure{413, "capture_too_large", "HAR 解析后内容超过保留上限，请缩小抓包范围。"}
		return
	}
	item.result = encoded
	item.view.Status = "completed"
	item.finishedAt = store.now()
}

func (s *Server) serveHARImportResult(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != "GET" {
		methodError(w, "GET")
		return
	}
	store := s.imports
	store.mu.Lock()
	store.pruneLocked()
	item := store.items[id]
	if item == nil {
		store.mu.Unlock()
		writeHARFailure(w, harFailure{404, "import_expired", "导入结果不存在或已过期，请重新导入 HAR。"})
		return
	}
	if item.view.Status != "completed" {
		store.mu.Unlock()
		writeHARFailure(w, harFailure{409, "result_not_ready", "导入尚未完成，请查询导入状态。"})
		return
	}
	encoded := item.result
	store.mu.Unlock()
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(200)
	_, _ = w.Write(encoded)
}
