package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"
)

type requestIDKey struct{}

// RequestID correlates a browser error with server logs without logging input data.
func RequestID(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey{}).(string)
	return id
}

func RequestLogging(next http.Handler) http.Handler {
	return requestLogging(next, log.Default())
}

func requestLogging(next http.Handler, logger *log.Logger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		var random [12]byte
		id := ""
		if _, err := rand.Read(random[:]); err == nil {
			id = hex.EncodeToString(random[:])
		} else {
			id = fmt.Sprintf("%x", started.UnixNano())
		}
		w.Header().Set("X-Request-ID", id)
		r = r.WithContext(context.WithValue(r.Context(), requestIDKey{}, id))
		out := &loggedResponse{ResponseWriter: w}
		route := requestLogRoute(r.URL.Path)
		method := r.Method
		switch method {
		case "GET", "HEAD", "POST", "DELETE", "PUT", "PATCH", "OPTIONS":
		default:
			method = "OTHER"
		}
		logger.Printf("http_start request_id=%s method=%s route=%s", id, method, route)
		defer func() {
			if recover() != nil {
				logger.Printf("http_panic request_id=%s route=%s", id, route)
				if out.status == 0 {
					writeError(out, http.StatusInternalServerError, "服务处理请求时发生异常，请提供错误编号以便排查。")
				}
			}
			status := out.status
			if status == 0 {
				status = http.StatusOK
			}
			logger.Printf("http_done request_id=%s method=%s route=%s status=%d duration_ms=%d bytes=%d", id, method, route, status, time.Since(started).Milliseconds(), out.bytes)
		}()
		next.ServeHTTP(out, r)
	})
}

// Log fixed route names only: URLs, query strings, credentials and HAR content
// must never enter the request log, including on unknown routes.
func requestLogRoute(path string) string {
	switch path {
	case "/api/health", "/api/har/parse", "/api/har/upload", "/api/har/imports", "/api/har/example", "/api/agent/analyze", "/api/agent/jobs", "/api/flow/run", "/api/flow/validate", "/api/flow/jobs":
		return path
	case "/":
		return "/"
	}
	if strings.HasPrefix(path, "/api/agent/jobs/") {
		return "/api/agent/jobs/:id"
	}
	if strings.HasPrefix(path, "/api/flow/jobs/") {
		return "/api/flow/jobs/:id"
	}
	if strings.HasPrefix(path, "/api/har/uploads/") {
		return "/api/har/uploads/:id/requests/:id"
	}
	if strings.HasPrefix(path, "/api/har/imports/") {
		parts := strings.Split(strings.TrimPrefix(path, "/api/har/imports/"), "/")
		if len(parts) == 2 {
			switch parts[1] {
			case "chunks", "complete", "result":
				return "/api/har/imports/:id/" + parts[1]
			}
		}
		return "/api/har/imports/:id"
	}
	if strings.HasPrefix(path, "/api/har/example/requests/") {
		return "/api/har/example/requests/:id"
	}
	if strings.HasPrefix(path, "/assets/") {
		return "/assets/:file"
	}
	return "other"
}

type loggedResponse struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (w *loggedResponse) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
		w.ResponseWriter.WriteHeader(status)
	}
}

func (w *loggedResponse) Write(data []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	n, err := w.ResponseWriter.Write(data)
	w.bytes += n
	return n, err
}

func (w *loggedResponse) Unwrap() http.ResponseWriter { return w.ResponseWriter }
