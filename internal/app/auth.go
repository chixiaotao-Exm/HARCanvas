package app

import (
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"net/http"
	"strings"
)

// OptionalBasicAuth wraps the entire application. Its closure retains only
// fixed-size credential hashes; no route bypasses it when enabled.
func OptionalBasicAuth(next http.Handler, username, password string) (http.Handler, error) {
	return ConfiguredBasicAuth(next, username, password, false)
}

// ConfiguredBasicAuth fails closed when required, even when both environment
// values are absent or empty. Local callers may keep authentication optional.
func ConfiguredBasicAuth(next http.Handler, username, password string, required bool) (http.Handler, error) {
	if required && (username == "" || password == "") {
		return nil, errors.New("-require-auth requires nonempty HAR_CANVAS_USER and HAR_CANVAS_PASSWORD")
	}
	if username == "" && password == "" {
		return next, nil
	}
	if username == "" || password == "" {
		return nil, errors.New("HAR_CANVAS_USER and HAR_CANVAS_PASSWORD must both be configured")
	}
	if strings.Contains(username, ":") {
		return nil, errors.New("HAR_CANVAS_USER must not contain a colon")
	}
	expectedUser := sha256.Sum256([]byte(username))
	expectedPassword := sha256.Sum256([]byte(password))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, pass, valid := r.BasicAuth()
		userHash := sha256.Sum256([]byte(user))
		passwordHash := sha256.Sum256([]byte(pass))
		matches := subtle.ConstantTimeCompare(userHash[:], expectedUser[:]) & subtle.ConstantTimeCompare(passwordHash[:], expectedPassword[:])
		if !valid || matches != 1 {
			w.Header().Set("WWW-Authenticate", `Basic realm="HAR Canvas", charset="UTF-8"`)
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("X-Content-Type-Options", "nosniff")
			writeError(w, http.StatusUnauthorized, "Authentication required")
			return
		}
		next.ServeHTTP(w, r)
	}), nil
}
