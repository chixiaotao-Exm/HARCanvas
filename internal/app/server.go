package app

import (
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
)

type Server struct {
	Runner     *Runner
	Analyzer   *Analyzer
	WebDir     string
	SampleHAR  string
	sampleMu   sync.Mutex
	sample     *sampleSnapshot
	runSlots   chan struct{}
	agentSlots chan struct{}
}

func NewServer(webDir string) *Server {
	return &Server{Runner: NewRunner(), Analyzer: NewAnalyzer(), WebDir: webDir, SampleHAR: filepath.Join("samples", "re.har"), runSlots: make(chan struct{}, 2), agentSlots: make(chan struct{}, 2)}
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	if strings.HasPrefix(r.URL.Path, "/api/") {
		w.Header().Set("Cache-Control", "no-store")
		switch r.URL.Path {
		case "/api/health":
			if r.Method != "GET" {
				methodError(w, "GET")
				return
			}
			writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
		case "/api/har/parse":
			if r.Method != "POST" {
				methodError(w, "POST")
				return
			}
			var input struct {
				HAR json.RawMessage `json:"har"`
			}
			if !decodeBody(w, r, &input) {
				return
			}
			result, err := ParseHAR(input.HAR)
			if err != nil {
				writeError(w, 400, err.Error())
				return
			}
			writeJSON(w, 200, result)
		case "/api/har/example":
			if r.Method != "GET" {
				methodError(w, "GET")
				return
			}
			s.serveExample(w, r, "")
		case "/api/agent/analyze":
			if r.Method != "POST" {
				methodError(w, "POST")
				return
			}
			var input struct {
				Config   AgentConfig `json:"config"`
				Requests []Request   `json:"requests"`
			}
			if !decodeBody(w, r, &input) {
				return
			}
			select {
			case s.agentSlots <- struct{}{}:
				defer func() { <-s.agentSlots }()
			default:
				writeError(w, 429, "Two analyses are already running; retry when one finishes")
				return
			}
			result, err := s.Analyzer.Analyze(r.Context(), input.Config, input.Requests)
			if err != nil {
				writeError(w, 502, err.Error())
				return
			}
			writeJSON(w, 200, result)
		case "/api/flow/run":
			if r.Method != "POST" {
				methodError(w, "POST")
				return
			}
			var input Flow
			if !decodeBody(w, r, &input) {
				return
			}
			select {
			case s.runSlots <- struct{}{}:
				defer func() { <-s.runSlots }()
			default:
				writeError(w, 429, "Two flows are already running; retry when one finishes")
				return
			}
			result, err := s.Runner.Run(r.Context(), input)
			if err != nil {
				writeError(w, 400, err.Error())
				return
			}
			writeJSON(w, 200, result)
		default:
			if strings.HasPrefix(r.URL.Path, "/api/har/example/requests/") {
				if r.Method != "GET" {
					methodError(w, "GET")
					return
				}
				id := strings.TrimPrefix(r.URL.Path, "/api/har/example/requests/")
				if !identifier.MatchString(id) {
					writeError(w, 404, "Example request not found")
					return
				}
				s.serveExample(w, r, id)
			} else {
				writeError(w, 404, "API endpoint not found")
			}
		}
		return
	}
	if r.Method != "GET" && r.Method != "HEAD" {
		methodError(w, "GET, HEAD")
		return
	}
	clean := path.Clean("/" + r.URL.Path)
	if strings.ContainsAny(r.URL.Path, "\\:\x00") {
		http.NotFound(w, r)
		return
	}
	for _, part := range strings.Split(clean, "/") {
		if strings.HasPrefix(part, ".") {
			http.NotFound(w, r)
			return
		}
	}
	filePath := filepath.Join(s.WebDir, filepath.FromSlash(strings.TrimPrefix(clean, "/")))
	info, err := os.Stat(filePath)
	if err == nil && !info.IsDir() {
		http.ServeFile(w, r, filePath)
		return
	}
	if path.Ext(clean) != "" {
		http.NotFound(w, r)
		return
	}
	index := filepath.Join(s.WebDir, "index.html")
	if _, err := os.Stat(index); err != nil {
		http.Error(w, "Frontend build not found. Build web/ first, or run the Vite development server.", 503)
		return
	}
	http.ServeFile(w, r, index)
}

func decodeBody(w http.ResponseWriter, r *http.Request, target any) bool {
	contentType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || contentType != "application/json" {
		writeError(w, 415, "Content-Type must be application/json")
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, 32<<20)
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(target); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, 413, "JSON upload exceeds 32 MiB")
		} else {
			writeError(w, 400, "Invalid JSON: "+err.Error())
		}
		return false
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		writeError(w, 400, "Request body must contain one JSON object")
		return false
	}
	return true
}
func methodError(w http.ResponseWriter, allow string) {
	w.Header().Set("Allow", allow)
	writeError(w, 405, "Method not allowed")
}
func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
