package app

import (
	"context"
	"net/http"
	"strconv"
	"testing"
	"time"
)

func savedCookieRunner() *Runner {
	r := NewRunner()
	r.Client.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.URL.Path == "/set" {
			return jsonResponse(200, `{}`, http.Header{"Set-Cookie": []string{"login=retained; Path=/"}}), nil
		}
		return jsonResponse(200, `{"cookie":`+strconv.Quote(req.Header.Get("Cookie"))+`}`, nil), nil
	})
	return r
}
func savedCookieFlow(project, session, path string, persist bool) Flow {
	return Flow{ProjectID: project, Nodes: []FlowNode{block(session, BlockData{Kind: "browserSession", Session: &SessionConfig{Persist: persist}}), block("request", BlockData{Kind: "request", URL: "https://8.8.8.8/" + path, SessionID: session}), block("out", BlockData{Kind: "output", Template: "{{request.body.cookie}}"})}, Edges: []FlowEdge{connect("request", "out")}}
}
func seedSavedCookie(t *testing.T, r *Runner, flow Flow) {
	t.Helper()
	flow.Nodes = flow.Nodes[:2]
	flow.Edges = nil
	result, err := r.Run(context.Background(), flow)
	if err != nil || result.Status != "success" {
		t.Fatalf("seed %+v %v", result, err)
	}
}

func TestSavedHTTPSessionsExplicitReuseAndIsolation(t *testing.T) {
	for _, persist := range []bool{false, true} {
		r := savedCookieRunner()
		seedSavedCookie(t, r, savedCookieFlow("projectA", "accountA", "set", persist))
		flow := savedCookieFlow("projectA", "accountA", "check", persist)
		result, err := r.Run(context.Background(), flow)
		want := ""
		if persist {
			want = "login=retained"
		}
		if err != nil || result.Status != "success" || result.Output != want {
			t.Fatalf("persist=%v %+v %v", persist, result, err)
		}
		if persist {
			for _, other := range []Flow{savedCookieFlow("projectB", "accountA", "check", true), savedCookieFlow("projectA", "accountB", "check", true)} {
				result, err := r.Run(context.Background(), other)
				if err != nil || result.Output != "" {
					t.Fatalf("saved session isolation failed %+v %v", result, err)
				}
			}
		}
	}
}
func TestSavedHTTPSessionConfigurationVersionStartsFresh(t *testing.T) {
	r := savedCookieRunner()
	seedSavedCookie(t, r, savedCookieFlow("projectA", "accountA", "set", true))
	flow := savedCookieFlow("projectA", "accountA", "check", true)
	flow.Nodes = append(flow.Nodes, block("profile", BlockData{Kind: "profile", Profile: &BrowserProfileConfig{UserAgent: "different/1"}}))
	flow.Nodes[0].Data.Session.ProfileID = "profile"
	result, err := r.Run(context.Background(), flow)
	if err != nil || result.Output != "" {
		t.Fatalf("changed config reused cookies %+v %v", result, err)
	}
	// Returning to the original version may explicitly reuse that version's state.
	result, err = r.Run(context.Background(), savedCookieFlow("projectA", "accountA", "check", true))
	if err != nil || result.Output != "login=retained" {
		t.Fatalf("original version lost %+v %v", result, err)
	}
}
func TestSavedHTTPSessionsReserveUntilRunCompletes(t *testing.T) {
	r := savedCookieRunner()
	flow := savedCookieFlow("projectA", "accountA", "check", true)
	rr := newRunResources(r, flow)
	if _, err := rr.config(flow.Nodes[1], ResourceDefaults{}, ""); err != nil {
		t.Fatal(err)
	}
	result, err := r.Run(context.Background(), flow)
	if err != nil || result.Status != "error" || result.Steps[0].ErrorCode != "saved_session_busy" {
		t.Fatalf("busy saved session mutated %+v %v", result, err)
	}
	rr.close()
	result, err = r.Run(context.Background(), flow)
	if err != nil || result.Status != "success" {
		t.Fatalf("saved reservation not released %+v %v", result, err)
	}
}
func TestSavedHTTPSessionExpirationAndBound(t *testing.T) {
	r := savedCookieRunner()
	clock := time.Now()
	store := r.sessionStore()
	store.now = func() time.Time { return clock }
	store.limit = 1
	seedSavedCookie(t, r, savedCookieFlow("projectA", "accountA", "set", true))
	clock = clock.Add(31 * time.Minute)
	result, err := r.Run(context.Background(), savedCookieFlow("projectA", "accountA", "check", true))
	if err != nil || result.Output != "" {
		t.Fatalf("expired cookie retained %+v %v", result, err)
	}
	seedSavedCookie(t, r, savedCookieFlow("projectA", "accountA", "set", true))
	result, err = r.Run(context.Background(), savedCookieFlow("projectA", "accountB", "check", true))
	if err != nil || result.Output != "" {
		t.Fatal(err)
	}
	if len(store.items) != 1 {
		t.Fatal("saved store unbounded")
	}
	result, err = r.Run(context.Background(), savedCookieFlow("projectA", "accountA", "check", true))
	if err != nil || result.Output != "" {
		t.Fatalf("evicted cookie retained %+v %v", result, err)
	}
}
func TestSavedHTTPSessionsRequireProjectIdentityAndValidSnapshot(t *testing.T) {
	r := savedCookieRunner()
	flow := savedCookieFlow("", "accountA", "set", true)
	if _, err := r.Run(context.Background(), flow); err == nil {
		t.Fatal("persistent session accepted without namespace")
	}
	if len(r.sessionStore().items) != 0 {
		t.Fatal("invalid flow acquired saved state")
	}
	flow.ProjectID = "projectA"
	flow.Nodes[1].Data.ProxyID = "missing"
	if _, err := r.Run(context.Background(), flow); err == nil {
		t.Fatal("invalid resource accepted")
	}
	if len(r.sessionStore().items) != 0 {
		t.Fatal("invalid config partially acquired saved state")
	}
}
func TestFreshLoopOverridesSavedSessionPersistence(t *testing.T) {
	r := savedCookieRunner()
	seedSavedCookie(t, r, savedCookieFlow("projectA", "accountA", "set", true))
	flow := savedCookieFlow("projectA", "accountA", "check", true)
	rr := newRunResources(r, flow)
	defer rr.close()
	config, err := rr.config(flow.Nodes[1], ResourceDefaults{}, "repeat:1/session")
	if err != nil || config.SessionPersistent || config.StableSessionID != "" {
		t.Fatalf("fresh loop reused saved state %+v %v", config, err)
	}
}
