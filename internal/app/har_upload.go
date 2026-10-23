package app

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const uploadPreviewLimit = 16 << 10

type harUpload struct {
	requests map[string]Request
	created  time.Time
	bytes    int
}
type harUploadStore struct {
	mu     sync.Mutex
	items  map[string]harUpload
	expiry *time.Timer
}

func newHARUploadStore() *harUploadStore { return &harUploadStore{items: map[string]harUpload{}} }
func (s *harUploadStore) pruneLocked() {
	now := time.Now()
	for id, item := range s.items {
		if now.Sub(item.created) >= 30*time.Minute {
			delete(s.items, id)
		}
	}
}
func (s *harUploadStore) scheduleLocked() {
	if s.expiry != nil {
		return
	}
	var next time.Time
	for _, item := range s.items {
		at := item.created.Add(30 * time.Minute)
		if next.IsZero() || at.Before(next) {
			next = at
		}
	}
	if next.IsZero() {
		return
	}
	s.expiry = time.AfterFunc(time.Until(next), func() { s.mu.Lock(); defer s.mu.Unlock(); s.expiry = nil; s.pruneLocked(); s.scheduleLocked() })
}
func newHARUploadID() (string, error) {
	var random [18]byte
	if _, err := rand.Read(random[:]); err != nil {
		return "", errors.New("无法创建导入记录")
	}
	return base64.RawURLEncoding.EncodeToString(random[:]), nil
}
func (s *harUploadStore) put(id string, requests []Request) error {
	item := harUpload{requests: map[string]Request{}, created: time.Now()}
	for _, request := range requests {
		item.requests[request.ID] = request
		item.bytes += len(request.ResponseBody) + len(request.Body)
		for _, value := range []string{request.ID, request.PageID, request.StartedAt, request.StartedDateTime, request.Method, request.URL, request.Domain, request.Path, request.Category, request.MimeType} {
			item.bytes += len(value)
		}
		for _, values := range []map[string]string{request.Headers, request.ResponseHeaders, request.Query} {
			for key, value := range values {
				item.bytes += len(key) + len(value)
			}
		}
	}
	// An oversized replacement must never evict an already usable capture.
	if item.bytes > 512<<20 {
		return errors.New("HAR 解析后内容超过 512 MiB，请缩小抓包范围")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneLocked()
	for {
		total := item.bytes
		for _, old := range s.items {
			total += old.bytes
		}
		if len(s.items) < 3 && total <= 512<<20 {
			break
		}
		var oldestID string
		var oldest time.Time
		for key, old := range s.items {
			if oldestID == "" || old.created.Before(oldest) {
				oldestID = key
				oldest = old.created
			}
		}
		if oldestID == "" {
			return errors.New("HAR 解析后内容超过 512 MiB，请缩小抓包范围")
		}
		delete(s.items, oldestID)
	}
	s.items[id] = item
	s.scheduleLocked()
	return nil
}
func (s *harUploadStore) get(id, requestID string) (Request, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneLocked()
	item, ok := s.items[id]
	if !ok {
		return Request{}, false
	}
	request, ok := item.requests[requestID]
	return request, ok
}

func (s *Server) uploadHAR(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		methodError(w, "POST")
		return
	}
	select {
	case s.uploadSlots <- struct{}{}:
		defer func() { <-s.uploadSlots }()
	default:
		writeError(w, 429, "已有两个 HAR 正在导入，请稍后重试。")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, sampleFileLimit+(1<<20))
	reader, err := r.MultipartReader()
	if err != nil {
		writeError(w, 415, "请通过文件选择器上传 HAR 文件。")
		return
	}
	var raw []byte
	for {
		part, partErr := reader.NextPart()
		if partErr == io.EOF {
			break
		}
		if partErr != nil {
			writeError(w, 400, "读取上传文件失败。")
			return
		}
		if part.FormName() != "file" || raw != nil {
			part.Close()
			writeError(w, 400, "一次只能上传一个名为 file 的 HAR 文件。")
			return
		}
		raw, err = io.ReadAll(io.LimitReader(part, sampleFileLimit+1))
		part.Close()
		if err != nil {
			writeError(w, 400, "读取上传文件失败。")
			return
		}
		if len(raw) > sampleFileLimit {
			writeError(w, 413, "HAR 文件超过 256 MiB，请缩小抓包范围。")
			return
		}
	}
	if len(raw) == 0 {
		writeError(w, 400, "请选择非空 HAR 文件。")
		return
	}
	parsed, err := ParseHAR(raw)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	if r.Context().Err() != nil {
		return
	}
	id, err := newHARUploadID()
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	preview := parsed
	preview.Requests = make([]Request, len(parsed.Requests))
	count := 0
	for i, request := range parsed.Requests {
		request.ResponseBodyBytes = len(request.ResponseBody)
		request.ResponseDetailURL = "/api/har/uploads/" + id + "/requests/" + request.ID
		if len(request.ResponseBody) > uploadPreviewLimit {
			cut := uploadPreviewLimit
			if utf8.ValidString(request.ResponseBody) {
				for cut > 0 && !utf8.RuneStart(request.ResponseBody[cut]) {
					cut--
				}
			}
			request.ResponseBody = request.ResponseBody[:cut]
			request.ResponseBodyTruncated = true
			count++
		}
		preview.Requests[i] = request
	}
	if count > 0 {
		preview.Warnings = append(preview.Warnings, fmt.Sprintf("%d 条响应显示前 16 KiB；可按需读取完整响应（导入后保留 30 分钟）。请求正文和请求头保持完整。", count))
	}
	encoded, err := json.Marshal(preview)
	if err != nil {
		writeError(w, 500, "无法编码 HAR 解析结果。")
		return
	}
	if len(encoded) > 32<<20 {
		writeError(w, 413, "请求头与正文超过 32 MiB，请缩小抓包范围；未静默删除请求数据。")
		return
	}
	if r.Context().Err() != nil {
		return
	}
	// Commit only imports that can actually be returned to the browser. A
	// rejected preview must retain neither its HAR nor evict previous imports.
	if err := s.uploads.put(id, parsed.Requests); err != nil {
		writeError(w, 413, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(200)
	_, _ = w.Write(encoded)
}
func (s *Server) serveUploadedHAR(w http.ResponseWriter, r *http.Request, suffix string) {
	if r.Method != "GET" {
		methodError(w, "GET")
		return
	}
	parts := strings.Split(suffix, "/")
	if len(parts) != 3 || !agentJobID.MatchString(parts[0]) || parts[1] != "requests" || !identifier.MatchString(parts[2]) {
		writeError(w, 404, "导入记录不存在。")
		return
	}
	request, ok := s.uploads.get(parts[0], parts[2])
	if !ok {
		writeError(w, 404, "完整响应已过期或被释放，请重新导入 HAR。")
		return
	}
	writeJSON(w, 200, map[string]Request{"request": request})
}
