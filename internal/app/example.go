package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"unicode/utf8"
)

const samplePreviewLimit = 64 << 10
const sampleFileLimit = 256 << 20
const samplePayloadLimit = 32 << 20

type ExampleResult struct {
	ParseResult
	Name                      string `json:"name"`
	FileName                  string `json:"fileName"`
	FileBytes                 int64  `json:"fileBytes"`
	ResponsePreviewLimitBytes int    `json:"responsePreviewLimitBytes"`
	PreviewedResponses        int    `json:"previewedResponses"`
	FullResponseAvailable     bool   `json:"fullResponseAvailable"`
}

type sampleSnapshot struct {
	requests map[string]Request
	payload  []byte
}

// The snapshot is immutable after its first successful load. Lists and lazy
// detail reads therefore always describe the same capture, even if the local
// file changes. Restart the server to load a replacement capture.
func (s *Server) loadSample() (*sampleSnapshot, error) {
	s.sampleMu.Lock()
	defer s.sampleMu.Unlock()
	if s.sample != nil {
		return s.sample, nil
	}
	if s.SampleHAR == "" {
		return nil, os.ErrNotExist
	}
	file, err := os.Open(s.SampleHAR)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, os.ErrNotExist
		}
		return nil, errors.New("cannot read the configured local HAR example")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return nil, errors.New("configured HAR example must be a regular local file")
	}
	if info.Size() > sampleFileLimit {
		return nil, errors.New("local HAR example exceeds 256 MiB file limit")
	}
	raw, err := io.ReadAll(io.LimitReader(file, sampleFileLimit+1))
	if err != nil {
		return nil, errors.New("reading local HAR example failed")
	}
	if len(raw) > sampleFileLimit {
		return nil, errors.New("local HAR example exceeds 256 MiB file limit")
	}
	parsed, err := ParseHAR(raw)
	if err != nil {
		return nil, fmt.Errorf("invalid local HAR example: %w", err)
	}
	preview := ExampleResult{ParseResult: parsed, Name: filepath.Base(s.SampleHAR), FileName: filepath.Base(s.SampleHAR), FileBytes: int64(len(raw)), ResponsePreviewLimitBytes: samplePreviewLimit, FullResponseAvailable: true}
	preview.Requests = make([]Request, len(parsed.Requests))
	snapshot := &sampleSnapshot{requests: make(map[string]Request, len(parsed.Requests))}
	for i, request := range parsed.Requests {
		request.ResponseBodyBytes = len(request.ResponseBody)
		snapshot.requests[request.ID] = request
		if len(request.ResponseBody) > samplePreviewLimit {
			cut := samplePreviewLimit
			if utf8.ValidString(request.ResponseBody) {
				for cut > 0 && !utf8.RuneStart(request.ResponseBody[cut]) {
					cut--
				}
			}
			request.ResponseBody = request.ResponseBody[:cut]
			request.ResponseBodyTruncated = true
			preview.PreviewedResponses++
		}
		preview.Requests[i] = request
	}
	preview.Warnings = append([]string{}, parsed.Warnings...)
	if preview.PreviewedResponses > 0 {
		preview.Warnings = append(preview.Warnings, fmt.Sprintf("Local example: %d response bodies show only the first 64 KiB. Full responses can be loaded on demand; original request bodies and headers are unchanged. The source HAR file is unchanged.", preview.PreviewedResponses))
	}
	snapshot.payload, err = json.Marshal(preview)
	if err != nil {
		return nil, errors.New("cannot encode local HAR example")
	}
	if len(snapshot.payload) > samplePayloadLimit {
		return nil, errors.New("local HAR example preview exceeds 32 MiB JSON limit; use a smaller capture. Request bodies and headers were not silently removed")
	}
	s.sample = snapshot
	return snapshot, nil
}

func (s *Server) serveExample(w http.ResponseWriter, r *http.Request, id string) {
	snapshot, err := s.loadSample()
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeError(w, 404, "No local HAR example is configured or the configured file does not exist")
		} else {
			writeError(w, 422, err.Error())
		}
		return
	}
	if r.Context().Err() != nil {
		return
	}
	if id != "" {
		request, exists := snapshot.requests[id]
		if !exists {
			writeError(w, 404, "Example request not found")
			return
		}
		writeJSON(w, 200, map[string]Request{"request": request})
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(200)
	_, _ = w.Write(snapshot.payload)
}
