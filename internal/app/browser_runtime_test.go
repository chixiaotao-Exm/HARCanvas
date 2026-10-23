package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestBrowserProxyRequiresCredentialsAndGuardsTargets(t *testing.T) {
	fixture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "fixture") }))
	defer fixture.Close()
	guard := NewNetworkGuard(true)
	proxy, err := newGuardedBrowserProxy(guard, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.close()
	proxyURL, _ := url.Parse(proxy.settings()["server"])
	transport := &http.Transport{Proxy: http.ProxyURL(proxyURL)}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 5 * time.Second}
	response, err := client.Get(fixture.URL)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 407 {
		t.Fatalf("unauthenticated proxy status %d", response.StatusCode)
	}
	proxyURL.User = url.UserPassword("canvas", proxy.token)
	transport.Proxy = http.ProxyURL(proxyURL)
	response, err = client.Get(fixture.URL)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if string(body) != "fixture" {
		t.Fatalf("proxy response %d %q", response.StatusCode, body)
	}
	blocked, err := newGuardedBrowserProxy(NewNetworkGuard(false), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer blocked.close()
	blockedURL, _ := url.Parse(blocked.settings()["server"])
	blockedURL.User = url.UserPassword("canvas", blocked.token)
	blockedTransport := &http.Transport{Proxy: http.ProxyURL(blockedURL)}
	defer blockedTransport.CloseIdleConnections()
	blockedClient := &http.Client{Transport: blockedTransport, Timeout: 5 * time.Second}
	response, err = blockedClient.Get(fixture.URL)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 403 {
		t.Fatalf("private destination status %d", response.StatusCode)
	}
}

func TestBrowserRuntimeRejectsUnscopedAndUnavailableOperations(t *testing.T) {
	runtime := NewBrowserRuntime(BrowserRuntimeOptions{WorkerPath: filepath.Join(t.TempDir(), "missing-worker.mjs")})
	defer runtime.Close()
	_, err := runtime.Execute(context.Background(), FlowNode{ID: "browser", Data: BlockData{Kind: "browser", BrowserAction: "read", Selector: "body"}}, EffectiveResources{}, map[string]any{}, map[string]any{}, nil)
	if err == nil || !strings.Contains(err.Error(), "运行会话") {
		t.Fatal("missing browser session should fail")
	}
	_, err = runtime.Execute(context.Background(), FlowNode{ID: "browser", Data: BlockData{Kind: "browser", BrowserAction: "read", Selector: "body"}}, EffectiveResources{ExecutionSessionID: "run:main"}, map[string]any{}, map[string]any{}, nil)
	if err == nil || !strings.Contains(err.Error(), "尚未安装") {
		t.Fatalf("missing worker not reported: %v", err)
	}
	request := httptest.NewRequest("GET", "/api/browser/sessions/"+strings.Repeat("a", 48)+"/view", nil)
	response := httptest.NewRecorder()
	runtime.ServeHTTP(response, request)
	if response.Code != 404 {
		t.Fatalf("unknown session %d", response.Code)
	}
	_, err = runtime.Execute(context.Background(), FlowNode{ID: "handoff", Data: BlockData{Kind: "browserVerification"}}, EffectiveResources{ExecutionSessionID: "run:default"}, map[string]any{}, map[string]any{}, nil)
	if err == nil || !strings.Contains(err.Error(), "可暂停") {
		t.Fatalf("manual browser requires await: %v", err)
	}
}

func TestBrowserWorkerExitReclaimsSavedCapacityAndView(t *testing.T) {
	runtime := NewBrowserRuntime(BrowserRuntimeOptions{MaxContexts: 1, WorkerPath: filepath.Join(t.TempDir(), "missing-worker.mjs")})
	worker := &browserWorker{done: make(chan struct{})}
	ready := make(chan struct{})
	close(ready)
	proxy, err := newGuardedBrowserProxy(NewNetworkGuard(true), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.close()
	session := &browserSession{id: "old", executionID: "saved:old", viewID: strings.Repeat("a", 48), persistent: true, ready: ready, worker: worker, proxy: proxy}
	session.idleTimer = time.AfterFunc(time.Hour, func() {})
	runtime.worker = worker
	runtime.sessions[session.executionID] = session
	runtime.views[session.viewID] = session
	runtime.workerExited(worker)
	close(worker.done)
	if len(runtime.sessions) != 0 || len(runtime.views) != 0 || runtime.worker != nil {
		t.Fatal("dead worker retained saved browser capacity")
	}
	if proxy.ctx.Err() == nil {
		t.Fatal("dead worker retained proxy listener")
	}
	_, err = runtime.session(context.Background(), EffectiveResources{ExecutionSessionID: "newrun:main"})
	if err == nil || strings.Contains(err.Error(), "上限") {
		t.Fatalf("new session blocked by stale capacity: %v", err)
	}
}

func TestBrowserCloseScopePreservesOuterAndSavedSessions(t *testing.T) {
	runtime := NewBrowserRuntime(BrowserRuntimeOptions{})
	defer runtime.Close()
	ready := make(chan struct{})
	close(ready)
	proxy, err := newGuardedBrowserProxy(NewNetworkGuard(true), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.close()
	inner := &browserSession{executionID: "run:loop:inner", ready: ready, proxy: proxy, manual: true, viewID: strings.Repeat("b", 48)}
	outer := &browserSession{executionID: "run:main", ready: ready}
	saved := &browserSession{executionID: "run:loop:saved", persistent: true, ready: ready}
	other := &browserSession{executionID: "other:loop:inner", ready: ready}
	for _, session := range []*browserSession{inner, outer, saved, other} {
		runtime.sessions[session.executionID] = session
	}
	runtime.views[inner.viewID] = inner
	if err = runtime.CloseScope(context.Background(), ""); err != nil || len(runtime.sessions) != 4 {
		t.Fatal("empty scope must not discard contexts")
	}
	if err = runtime.CloseScope(context.Background(), "run:loop:"); err != nil {
		t.Fatal(err)
	}
	if len(runtime.sessions) != 3 || len(runtime.views) != 0 || !inner.closed || inner.manual || proxy.ctx.Err() == nil {
		t.Fatal("scope retained its context, view, or proxy")
	}
	for _, session := range []*browserSession{outer, saved, other} {
		if runtime.sessions[session.executionID] != session || session.closed {
			t.Fatal("scope disposed an outer, saved, or unrelated context")
		}
	}
}

func TestBrowserRuntimeFreshScopeReleasesContexts(t *testing.T) {
	if os.Getenv("HAR_CANVAS_BROWSER_TEST") != "1" {
		t.Skip("set HAR_CANVAS_BROWSER_TEST=1 after installing scripts dependencies and Chromium")
	}
	fixture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.WriteString(w, `<input id="value"><button id="save" onclick="localStorage.setItem('scope',document.querySelector('#value').value)">Save</button><p id="previous"></p><script>document.querySelector('#previous').textContent=localStorage.getItem('scope')||''</script>`)
	}))
	defer fixture.Close()
	runtime := NewBrowserRuntime(BrowserRuntimeOptions{MaxContexts: 2, WorkerPath: filepath.Join("..", "..", "scripts", "browser-worker.mjs"), Guard: NewNetworkGuard(true)})
	defer runtime.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	invoke := func(resources EffectiveResources, action, selector, text string) map[string]any {
		t.Helper()
		data := BlockData{Kind: "browser", BrowserAction: action, Selector: selector, Text: text}
		if action == "navigate" {
			data.URL = fixture.URL
		}
		result, err := runtime.Execute(ctx, FlowNode{ID: "browser", Data: data}, resources, map[string]any{}, map[string]any{}, nil)
		if err != nil {
			t.Fatal(err)
		}
		return result.(map[string]any)
	}
	outer := EffectiveResources{ExecutionSessionID: "fresh:outer:main"}
	invoke(outer, "navigate", "", "")
	invoke(outer, "fill", "#value", "outer-value")
	invoke(outer, "click", "#save", "")
	for _, scope := range []string{"one", "two", "three", "four", "five"} {
		prefix := "fresh:loop/" + scope + ":"
		resources := EffectiveResources{ExecutionSessionID: prefix + "main"}
		invoke(resources, "navigate", "", "")
		if previous := invoke(resources, "read", "#previous", "")["text"]; previous != "" {
			t.Fatalf("fresh scope inherited localStorage: %v", previous)
		}
		invoke(resources, "fill", "#value", scope)
		invoke(resources, "click", "#save", "")
		if err := runtime.CloseScope(ctx, prefix); err != nil {
			t.Fatal(err)
		}
		runtime.mu.Lock()
		remaining := len(runtime.sessions)
		runtime.mu.Unlock()
		if remaining != 1 {
			t.Fatalf("finished scope retained context, %d remain", remaining)
		}
	}
	invoke(outer, "navigate", "", "")
	if value := invoke(outer, "read", "#previous", "")["text"]; value != "outer-value" {
		t.Fatalf("closing fresh scope lost outer state: %v", value)
	}
}

func TestBrowserRuntimeRealActionsAndManualHandoff(t *testing.T) {
	if os.Getenv("HAR_CANVAS_BROWSER_TEST") != "1" {
		t.Skip("set HAR_CANVAS_BROWSER_TEST=1 after installing scripts dependencies and Chromium")
	}
	fixture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.WriteString(w, `<!doctype html><title>Browser fixture</title><style>body{margin:0}input{position:absolute;left:20px;top:20px;width:220px;height:30px}button{position:absolute;left:20px;top:70px;width:140px;height:35px}#result{position:absolute;left:20px;top:130px}</style><input id="value"><button id="go" onclick="document.querySelector('#result').textContent=document.querySelector('#value').value;localStorage.setItem('last',document.querySelector('#value').value)">Apply</button><p id="result"></p><script>document.querySelector('#result').textContent=localStorage.getItem('last')||''</script>`)
	}))
	defer fixture.Close()
	runtime := NewBrowserRuntime(BrowserRuntimeOptions{WorkerPath: filepath.Join("..", "..", "scripts", "browser-worker.mjs"), Guard: NewNetworkGuard(true)})
	defer runtime.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	resources := EffectiveResources{SessionID: "main", ExecutionSessionID: "testrun:main", Profile: &BrowserProfileConfig{Browser: "chromium", Locale: "en-US", Timezone: "UTC", Viewport: BrowserViewport{Width: 960, Height: 640}}}
	run := func(data BlockData, res EffectiveResources) map[string]any {
		t.Helper()
		data.Kind = "browser"
		result, err := runtime.Execute(ctx, FlowNode{ID: "step", Data: data}, res, map[string]any{}, map[string]any{}, nil)
		if err != nil {
			t.Fatal(err)
		}
		return result.(map[string]any)
	}
	opened := run(BlockData{URL: fixture.URL}, resources)
	applied := opened["applied"].(map[string]any)
	if applied["locale"] != "en-US" || applied["timezone"] != "UTC" {
		t.Fatalf("actual profile %#v", applied)
	}
	run(BlockData{BrowserAction: "fill", Selector: "#value", Text: "synthetic-value"}, resources)
	run(BlockData{BrowserAction: "click", Selector: "#go"}, resources)
	read := run(BlockData{BrowserAction: "read", Selector: "#result"}, resources)
	if read["text"] != "synthetic-value" {
		t.Fatalf("read result %#v", read)
	}
	other := resources
	other.ExecutionSessionID = "testrun:other"
	run(BlockData{URL: fixture.URL}, other)
	if value := run(BlockData{BrowserAction: "read", Selector: "#result"}, other)["text"]; value != "" {
		t.Fatalf("contexts leaked localStorage %v", value)
	}
	var viewID string
	await := func(ctx context.Context, input PendingInput) (string, error) {
		viewID = input.BrowserSessionID
		if len(viewID) != 48 || input.ViewURL == "" {
			t.Fatalf("missing handoff scope %#v", input)
		}
		response := httptest.NewRecorder()
		runtime.ServeHTTP(response, httptest.NewRequest("GET", input.ViewURL, nil))
		if response.Code != 200 {
			t.Fatalf("view %d %s", response.Code, response.Body.String())
		}
		var screenshot struct {
			Image string `json:"image"`
			MIME  string `json:"mimeType"`
		}
		if json.Unmarshal(response.Body.Bytes(), &screenshot) != nil {
			t.Fatal("invalid screenshot")
		}
		bytes, err := base64.StdEncoding.DecodeString(screenshot.Image)
		if err != nil || len(bytes) < 1000 || screenshot.MIME != "image/jpeg" {
			t.Fatalf("missing actual screenshot %d %v", len(bytes), err)
		}
		for _, action := range []string{`{"action":"click","x":50,"y":35}`, `{"action":"press","key":"Control+A"}`, `{"action":"type","text":"manual-value"}`, `{"action":"click","x":50,"y":85}`} {
			request := httptest.NewRequest("POST", "/api/browser/sessions/"+viewID+"/action", strings.NewReader(action))
			request.Header.Set("Content-Type", "application/json")
			response = httptest.NewRecorder()
			runtime.ServeHTTP(response, request)
			if response.Code != 200 {
				t.Fatalf("manual action %d %s", response.Code, response.Body.String())
			}
		}
		return "continue", nil
	}
	_, err := runtime.Execute(ctx, FlowNode{ID: "manual", Data: BlockData{Kind: "browserVerification"}}, resources, map[string]any{}, map[string]any{}, await)
	if err != nil {
		t.Fatal(err)
	}
	if value := run(BlockData{BrowserAction: "read", Selector: "#result"}, resources)["text"]; value != "manual-value" {
		t.Fatalf("manual handoff did not keep context %v", value)
	}
	response := httptest.NewRecorder()
	runtime.ServeHTTP(response, httptest.NewRequest("GET", "/api/browser/sessions/"+viewID+"/view", nil))
	if response.Code != 404 {
		t.Fatalf("handoff should expire after continue %d", response.Code)
	}
	if err = runtime.CloseRun(ctx, "testrun"); err != nil {
		t.Fatal(err)
	}
	runtime.mu.Lock()
	remaining := len(runtime.sessions)
	runtime.mu.Unlock()
	if remaining != 0 {
		t.Fatalf("run leaked %d contexts", remaining)
	}
	// An explicitly saved session keeps its actual local storage across runs,
	// rejects simultaneous use, and is disposed after the configured idle TTL.
	runtime.options.IdleTimeout = 100 * time.Millisecond
	saved := resources
	saved.ExecutionSessionID = "savedrun1:main"
	saved.SessionPersistent = true
	saved.StableSessionID = "synthetic-stable-session"
	run(BlockData{URL: fixture.URL}, saved)
	run(BlockData{BrowserAction: "fill", Selector: "#value", Text: "saved-value"}, saved)
	run(BlockData{BrowserAction: "click", Selector: "#go"}, saved)
	if err = runtime.CloseRun(ctx, "savedrun1"); err != nil {
		t.Fatal(err)
	}
	saved.ExecutionSessionID = "savedrun2:main"
	if value := run(BlockData{BrowserAction: "read", Selector: "#result"}, saved)["text"]; value != "saved-value" {
		t.Fatalf("saved browser state lost: %v", value)
	}
	concurrent := saved
	concurrent.ExecutionSessionID = "savedrun3:main"
	_, err = runtime.Execute(ctx, FlowNode{ID: "read", Data: BlockData{Kind: "browser", BrowserAction: "read", Selector: "#result"}}, concurrent, map[string]any{}, map[string]any{}, nil)
	if err == nil || !strings.Contains(err.Error(), "另一个运行") {
		t.Fatalf("concurrent saved context accepted: %v", err)
	}
	if err = runtime.CloseRun(ctx, "savedrun2"); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		runtime.mu.Lock()
		remaining = len(runtime.sessions)
		runtime.mu.Unlock()
		if remaining == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("saved browser context did not expire")
		}
		time.Sleep(20 * time.Millisecond)
	}
	// A crashed worker must release saved capacity immediately, not after TTL.
	runtime.options.MaxContexts = 1
	runtime.options.IdleTimeout = time.Hour
	saved.ExecutionSessionID = "crashrun:main"
	saved.StableSessionID = "crash-stable-session"
	run(BlockData{URL: fixture.URL}, saved)
	if err = runtime.CloseRun(ctx, "crashrun"); err != nil {
		t.Fatal(err)
	}
	runtime.mu.Lock()
	crashed := runtime.worker
	runtime.mu.Unlock()
	if err = crashed.cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-crashed.done:
	case <-time.After(5 * time.Second):
		t.Fatal("browser worker stalled after process exit")
	}
	runtime.mu.Lock()
	remaining = len(runtime.sessions)
	runtime.mu.Unlock()
	if remaining != 0 {
		t.Fatalf("dead worker retained %d sessions", remaining)
	}
	recovery := resources
	recovery.ExecutionSessionID = "recovery:main"
	run(BlockData{URL: fixture.URL}, recovery)
	if err = runtime.CloseRun(ctx, "recovery"); err != nil {
		t.Fatal(err)
	}
}
