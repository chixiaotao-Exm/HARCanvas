package app

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestOptionalBasicAuthConfiguration(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })
	handler, err := OptionalBasicAuth(next, "", "")
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest("GET", "/api/health", nil))
	if w.Code != 204 {
		t.Fatal("unconfigured local mode was changed")
	}
	for _, config := range [][2]string{{"only-user", ""}, {"", "only-password"}, {"invalid:user", "password"}} {
		if _, err := OptionalBasicAuth(next, config[0], config[1]); err == nil {
			t.Fatal("incomplete or invalid configuration was accepted")
		}
	}
}

func TestRequiredBasicAuthFailsClosedForEmptyEffectiveCredentials(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })
	for _, config := range [][2]string{{"", ""}, {"user", ""}, {"", "password"}} {
		if handler, err := ConfiguredBasicAuth(next, config[0], config[1], true); err == nil || handler != nil {
			t.Fatal("required authentication accepted empty effective credentials")
		}
	}
	handler, err := ConfiguredBasicAuth(next, "user", "password", true)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("GET", "/", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal("required authentication was bypassed")
	}
	r = httptest.NewRequest("GET", "/", nil)
	r.SetBasicAuth("user", "password")
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != 204 {
		t.Fatal("required authentication rejected valid credentials")
	}
}

func TestBasicAuthProtectsAllRoutesAndChallengesWithoutLeakingCredentials(t *testing.T) {
	server := NewServer(t.TempDir())
	server.SampleHAR = ""
	handler, err := OptionalBasicAuth(server, "private-user", "private:password")
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/", "/assets/index.js", "/api/health", "/api/har/parse", "/api/agent/analyze", "/api/flow/run", "/api/har/example", "/api/har/example/requests/req-1", "/unknown"} {
		for _, authorization := range []string{"", "Bearer wrong", "Basic invalid-base64"} {
			r := httptest.NewRequest("GET", path, nil)
			if authorization != "" {
				r.Header.Set("Authorization", authorization)
			}
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != 401 || w.Header().Get("Cache-Control") != "no-store" || !strings.Contains(w.Header().Get("WWW-Authenticate"), `Basic realm="HAR Canvas"`) {
				t.Fatalf("route %s did not challenge consistently: status=%d", path, w.Code)
			}
			if strings.Contains(w.Body.String(), "private-user") || strings.Contains(w.Body.String(), "private:password") {
				t.Fatal("credentials appeared in the authentication response")
			}
		}
	}
	for _, credentials := range [][2]string{{"private-user", "wrong"}, {"wrong", "private:password"}, {"", "private:password"}} {
		r := httptest.NewRequest("GET", "/api/health", nil)
		r.SetBasicAuth(credentials[0], credentials[1])
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != 401 {
			t.Fatal("incorrect credentials were accepted")
		}
	}
	r := httptest.NewRequest("GET", "/api/health", nil)
	r.SetBasicAuth("private-user", "private:password")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"status":"ok"`) {
		t.Fatal("valid credentials did not reach the application")
	}
}
