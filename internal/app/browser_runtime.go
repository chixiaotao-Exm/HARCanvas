package app

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// BrowserRuntime executes ordinary Playwright actions. A guarded local HTTP
// proxy is the browser's only HTTP(S) route, including upstream SOCKS proxies.
type BrowserRuntimeOptions struct {
	NodePath    string
	WorkerPath  string
	MaxContexts int
	IdleTimeout time.Duration
	Guard       *NetworkGuard
}

type BrowserRuntime struct {
	options  BrowserRuntimeOptions
	mu       sync.Mutex
	worker   *browserWorker
	closed   bool
	sessions map[string]*browserSession
	views    map[string]*browserSession
}

type browserSession struct {
	id, executionID string
	viewID          string
	ownerRun        string
	persistent      bool
	idleTimer       *time.Timer
	fingerprint     [32]byte
	ready           chan struct{}
	err             error
	worker          *browserWorker
	proxy           *guardedBrowserProxy
	manual          bool
	closed          bool
}

type browserResponse struct {
	ID     string          `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

type browserWorker struct {
	cmd     *exec.Cmd
	input   io.WriteCloser
	sendMu  sync.Mutex
	mu      sync.Mutex
	pending map[string]chan browserResponse
	done    chan struct{}
}

func NewBrowserRuntime(options BrowserRuntimeOptions) *BrowserRuntime {
	if options.NodePath == "" {
		options.NodePath = os.Getenv("HAR_CANVAS_BROWSER_NODE")
	}
	if options.NodePath == "" {
		options.NodePath = "node"
	}
	if options.WorkerPath == "" {
		options.WorkerPath = os.Getenv("HAR_CANVAS_BROWSER_WORKER")
	}
	if options.WorkerPath == "" {
		options.WorkerPath = filepath.Join("scripts", "browser-worker.mjs")
	}
	if options.MaxContexts < 1 {
		options.MaxContexts = 4
	}
	if options.IdleTimeout <= 0 {
		options.IdleTimeout = 30 * time.Minute
	}
	if options.Guard == nil {
		options.Guard = NewNetworkGuard(false)
	}
	return &BrowserRuntime{options: options, sessions: map[string]*browserSession{}, views: map[string]*browserSession{}}
}

func browserOpaqueID() string {
	var bytes [24]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		panic("secure random source unavailable")
	}
	return hex.EncodeToString(bytes[:])
}

func (b *BrowserRuntime) getWorker() (*browserWorker, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return nil, &executionError{"browser_unavailable", "浏览器执行器已关闭。"}
	}
	if b.worker != nil {
		select {
		case <-b.worker.done:
			b.worker = nil
		default:
			return b.worker, nil
		}
	}
	path, err := filepath.Abs(b.options.WorkerPath)
	if err != nil {
		return nil, &executionError{"browser_unavailable", "无法定位浏览器执行器。"}
	}
	if _, err = os.Stat(path); err != nil {
		return nil, &executionError{"browser_unavailable", "浏览器执行器尚未安装，请安装 scripts/browser-worker.mjs 与 Playwright。"}
	}
	cmd := exec.Command(b.options.NodePath, path)
	cmd.Stderr = io.Discard // Playwright errors can contain URLs and credentials.
	input, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		input.Close()
		return nil, err
	}
	if err = cmd.Start(); err != nil {
		input.Close()
		return nil, &executionError{"browser_unavailable", "无法启动浏览器执行器，请检查 Node.js 与 Playwright 安装。"}
	}
	w := &browserWorker{cmd: cmd, input: input, pending: map[string]chan browserResponse{}, done: make(chan struct{})}
	b.worker = w
	go func() {
		scanner := bufio.NewScanner(output)
		scanner.Buffer(make([]byte, 65536), 16<<20)
		for scanner.Scan() {
			var response browserResponse
			if json.Unmarshal(scanner.Bytes(), &response) != nil {
				continue
			}
			w.mu.Lock()
			channel := w.pending[response.ID]
			delete(w.pending, response.ID)
			w.mu.Unlock()
			if channel != nil {
				channel <- response
			}
		}
		_ = cmd.Wait()
		b.workerExited(w)
		close(w.done)
	}()
	return w, nil
}

// A failed worker invalidates all of its contexts, including idle saved ones.
// Reclaim these before publishing done so a new run cannot hit stale capacity.
func (b *BrowserRuntime) workerExited(worker *browserWorker) {
	b.mu.Lock()
	if b.worker == worker {
		b.worker = nil
	}
	var proxies []*guardedBrowserProxy
	for key, session := range b.sessions {
		if session.worker != worker {
			continue
		}
		delete(b.sessions, key)
		delete(b.views, session.viewID)
		session.closed = true
		session.manual = false
		if session.idleTimer != nil {
			session.idleTimer.Stop()
		}
		// Creation publishes proxy state when ready closes. Its error path
		// handles a proxy still being initialized when the worker fails.
		select {
		case <-session.ready:
			if session.proxy != nil {
				proxies = append(proxies, session.proxy)
			}
		default:
		}
	}
	b.mu.Unlock()
	for _, proxy := range proxies {
		proxy.close()
	}
}

func (w *browserWorker) send(value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	w.sendMu.Lock()
	defer w.sendMu.Unlock()
	_, err = w.input.Write(append(data, '\n'))
	return err
}
func (w *browserWorker) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	id := browserOpaqueID()
	channel := make(chan browserResponse, 1)
	w.mu.Lock()
	w.pending[id] = channel
	w.mu.Unlock()
	defer func() { w.mu.Lock(); delete(w.pending, id); w.mu.Unlock() }()
	if err := w.send(map[string]any{"id": id, "method": method, "params": params}); err != nil {
		return nil, &executionError{"browser_unavailable", "浏览器执行器连接中断。"}
	}
	select {
	case response := <-channel:
		if response.Error != nil {
			return nil, &executionError{response.Error.Code, response.Error.Message}
		}
		return response.Result, nil
	case <-w.done:
		return nil, &executionError{"browser_unavailable", "浏览器执行器已停止，请检查运行环境后重新运行。"}
	case <-ctx.Done():
		_ = w.send(map[string]any{"method": "cancel", "params": map[string]string{"requestId": id}})
		return nil, ctx.Err()
	}
}

func (b *BrowserRuntime) session(ctx context.Context, resources EffectiveResources) (*browserSession, error) {
	if resources.ExecutionSessionID == "" {
		return nil, &executionError{"browser_session_missing", "浏览器步骤缺少运行会话。"}
	}
	encoded, _ := json.Marshal(struct {
		Proxy   *ProxyConfig
		Profile *BrowserProfileConfig
	}{resources.Proxy, resources.Profile})
	fingerprint := sha256.Sum256(encoded)
	key := resources.ExecutionSessionID
	runID := strings.SplitN(key, ":", 2)[0]
	if resources.SessionPersistent {
		if resources.StableSessionID == "" {
			return nil, &executionError{"browser_session_missing", "保存的浏览器会话缺少稳定标识。"}
		}
		key = "saved:" + resources.StableSessionID
	}
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return nil, &executionError{"browser_unavailable", "浏览器执行器已关闭。"}
	}
	existing := b.sessions[key]
	if existing != nil {
		if existing.ownerRun != "" && existing.ownerRun != runID {
			b.mu.Unlock()
			return nil, &executionError{"browser_session_busy", "这个保存的浏览器会话正被另一个运行使用，请等待它结束。"}
		}
		if existing.fingerprint != fingerprint {
			b.mu.Unlock()
			return nil, &executionError{"browser_resource_conflict", "保存的浏览器会话使用的代理或画像已变化，请改用固定配置或新的会话。"}
		}
		if existing.idleTimer != nil {
			existing.idleTimer.Stop()
			existing.idleTimer = nil
		}
		existing.ownerRun = runID
		b.mu.Unlock()
		select {
		case <-existing.ready:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		if existing.err != nil {
			return nil, existing.err
		}
		if existing.fingerprint != fingerprint {
			return nil, &executionError{"browser_resource_conflict", "同一个浏览器会话的代理和画像必须保持一致，请创建新会话。"}
		}
		return existing, nil
	}
	if len(b.sessions) >= b.options.MaxContexts {
		b.mu.Unlock()
		return nil, &executionError{"browser_capacity", "当前浏览器会话已达到上限，请结束其他运行或减少独立会话。"}
	}
	session := &browserSession{id: browserOpaqueID(), executionID: key, ownerRun: runID, persistent: resources.SessionPersistent, fingerprint: fingerprint, ready: make(chan struct{})}
	b.sessions[key] = session
	b.mu.Unlock()
	defer close(session.ready)
	worker, err := b.getWorker()
	if err == nil {
		proxy, proxyErr := newGuardedBrowserProxy(b.options.Guard, resources.Proxy)
		b.mu.Lock()
		session.worker = worker
		session.proxy = proxy
		b.mu.Unlock()
		err = proxyErr
	}
	if err == nil {
		_, err = worker.call(ctx, "create", map[string]any{"sessionId": session.id, "profile": resources.Profile, "proxy": session.proxy.settings()})
	}
	if err != nil {
		session.err = err
		if session.proxy != nil {
			session.proxy.close()
		}
		b.mu.Lock()
		delete(b.sessions, key)
		b.mu.Unlock()
		return nil, err
	}
	return session, nil
}

func (b *BrowserRuntime) checkedURL(ctx context.Context, address string) error {
	u, err := url.Parse(address)
	if err != nil {
		return &executionError{"browser_url", "网页地址格式不正确。"}
	}
	u.Fragment = ""
	if err = b.options.Guard.CheckURL(ctx, u); err != nil {
		return &executionError{"browser_url_blocked", "网页地址不受支持，或目标网络地址不允许访问。"}
	}
	return nil
}

func (b *BrowserRuntime) Execute(ctx context.Context, node FlowNode, resources EffectiveResources, variables, results map[string]any, await func(context.Context, PendingInput) (string, error)) (output any, executionErr error) {
	if node.Data.Kind != "browser" && node.Data.Kind != "browserVerification" {
		return nil, &executionError{"browser_action", "这个方块不是浏览器操作。"}
	}
	action := node.Data.BrowserAction
	if action == "" || node.Data.Kind == "browserVerification" {
		action = "navigate"
	}
	if node.Data.Kind == "browserVerification" && await == nil {
		return nil, &executionError{"browser_manual_required", "该步骤需要可暂停的运行模式，以便在浏览器中完成人工操作。"}
	}
	address := ""
	var err error
	if node.Data.URL != "" && (action == "navigate" || node.Data.Kind == "browserVerification") {
		address, err = renderTemplate(node.Data.URL, variables, results)
		if err != nil {
			return nil, err
		}
		if err = b.checkedURL(ctx, address); err != nil {
			return nil, err
		}
	}
	if node.Data.Kind == "browser" && action == "navigate" && address == "" {
		return nil, &executionError{"browser_url", "请填写要打开的网页地址。"}
	}
	selector, err := renderTemplate(node.Data.Selector, variables, results)
	if err != nil {
		return nil, err
	}
	text, err := renderTemplate(node.Data.Text, variables, results)
	if err != nil {
		return nil, err
	}
	if len(selector) > 4096 || len(text) > 65536 {
		return nil, &executionError{"browser_input_limit", "浏览器定位内容或填写内容过长。"}
	}
	session, err := b.session(ctx, resources)
	if err != nil {
		return nil, err
	}
	defer func() {
		var failure *executionError
		if executionErr != nil && (ctx.Err() != nil || errors.As(executionErr, &failure) && (failure.Code == "browser_closed" || failure.Code == "browser_unavailable")) {
			b.discardSession(session)
		}
	}()
	var result json.RawMessage
	if node.Data.Kind == "browser" || address != "" {
		result, err = session.worker.call(ctx, "execute", map[string]any{"sessionId": session.id, "action": action, "url": address, "selector": selector, "text": text})
		if err != nil {
			return nil, err
		}
	}
	if node.Data.Kind == "browserVerification" {
		b.mu.Lock()
		session.manual = true
		if session.viewID != "" {
			delete(b.views, session.viewID)
		}
		session.viewID = browserOpaqueID()
		viewID := session.viewID
		b.mu.Unlock()
		if _, err = session.worker.call(ctx, "manualStart", map[string]string{"sessionId": session.id, "viewToken": viewID}); err != nil {
			return nil, err
		}
		b.mu.Lock()
		b.views[viewID] = session
		b.mu.Unlock()
		_, err = await(ctx, PendingInput{NodeID: node.ID, Variable: node.Data.Variable, Label: node.Data.Label, Prompt: "在下方浏览器中完成网页操作，再点击继续。同一会话会保留当前网页和 Cookie。", BrowserSessionID: viewID, ViewURL: "/api/browser/sessions/" + viewID + "/view"})
		b.mu.Lock()
		session.manual = false
		delete(b.views, viewID)
		b.mu.Unlock()
		endCtx, endCancel := context.WithTimeout(context.Background(), 5*time.Second)
		_, endErr := session.worker.call(endCtx, "manualEnd", map[string]string{"sessionId": session.id, "viewToken": viewID})
		endCancel()
		if err == nil && endErr != nil {
			err = endErr
		}
		if err != nil {
			return nil, err
		}
		result, err = session.worker.call(ctx, "execute", map[string]any{"sessionId": session.id, "action": "read", "selector": "body"})
		if err != nil {
			return nil, err
		}
	}
	var decoded any
	if err = json.Unmarshal(result, &decoded); err != nil {
		return nil, errors.New("invalid browser result")
	}
	return decoded, nil
}

func (b *BrowserRuntime) CloseRun(ctx context.Context, runID string) error {
	b.mu.Lock()
	var closing []*browserSession
	for key, session := range b.sessions {
		if session.ownerRun == runID {
			delete(b.views, session.viewID)
			session.manual = false
			if session.persistent {
				session.ownerRun = ""
				session.idleTimer = time.AfterFunc(b.options.IdleTimeout, func() { b.expireSession(key, session) })
				continue
			}
			closing = append(closing, session)
			delete(b.sessions, key)
			session.closed = true
		}
	}
	b.mu.Unlock()
	var first error
	for _, session := range closing {
		select {
		case <-session.ready:
		case <-ctx.Done():
			return ctx.Err()
		}
		if session.proxy != nil {
			session.proxy.close()
		}
		if session.worker != nil {
			if _, err := session.worker.call(ctx, "close", map[string]string{"sessionId": session.id}); err != nil && first == nil {
				first = err
			}
		}
	}
	return first
}

// CloseScope releases temporary contexts after a fresh-session loop iteration.
// Saved sessions and contexts belonging to outer scopes retain their state.
func (b *BrowserRuntime) CloseScope(ctx context.Context, prefix string) error {
	if prefix == "" {
		return nil
	}
	b.mu.Lock()
	var closing []*browserSession
	for key, session := range b.sessions {
		if session.persistent || !strings.HasPrefix(session.executionID, prefix) {
			continue
		}
		delete(b.sessions, key)
		delete(b.views, session.viewID)
		session.closed = true
		session.manual = false
		if session.idleTimer != nil {
			session.idleTimer.Stop()
		}
		closing = append(closing, session)
	}
	b.mu.Unlock()
	var first error
	for _, session := range closing {
		select {
		case <-session.ready:
		case <-ctx.Done():
			return ctx.Err()
		}
		if session.proxy != nil {
			session.proxy.close()
		}
		if session.worker != nil {
			if _, err := session.worker.call(ctx, "close", map[string]string{"sessionId": session.id}); err != nil && first == nil {
				first = err
			}
		}
	}
	return first
}

func (b *BrowserRuntime) expireSession(key string, session *browserSession) {
	b.mu.Lock()
	if b.sessions[key] != session || session.ownerRun != "" {
		b.mu.Unlock()
		return
	}
	delete(b.sessions, key)
	delete(b.views, session.viewID)
	session.closed = true
	b.mu.Unlock()
	if session.proxy != nil {
		session.proxy.close()
	}
	if session.worker != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = session.worker.call(ctx, "close", map[string]string{"sessionId": session.id})
	}
}

func (b *BrowserRuntime) discardSession(session *browserSession) {
	b.mu.Lock()
	if b.sessions[session.executionID] != session {
		b.mu.Unlock()
		return
	}
	delete(b.sessions, session.executionID)
	delete(b.views, session.viewID)
	session.manual = false
	session.closed = true
	if session.idleTimer != nil {
		session.idleTimer.Stop()
	}
	b.mu.Unlock()
	if session.proxy != nil {
		session.proxy.close()
	}
	if session.worker != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = session.worker.call(ctx, "close", map[string]string{"sessionId": session.id})
	}
}

// Close stops worker processes when a containing server is shut down.
func (b *BrowserRuntime) Close() error {
	b.mu.Lock()
	b.closed = true
	worker := b.worker
	b.worker = nil
	var proxies []*guardedBrowserProxy
	for _, s := range b.sessions {
		if s.idleTimer != nil {
			s.idleTimer.Stop()
		}
		s.closed = true
		s.manual = false
		select {
		case <-s.ready:
			if s.proxy != nil {
				proxies = append(proxies, s.proxy)
			}
		default:
		}
	}
	b.sessions = map[string]*browserSession{}
	b.views = map[string]*browserSession{}
	b.mu.Unlock()
	for _, proxy := range proxies {
		proxy.close()
	}
	if worker != nil {
		worker.input.Close()
		select {
		case <-worker.done:
		case <-time.After(3 * time.Second):
			_ = worker.cmd.Process.Kill()
		}
	}
	return nil
}

var browserViewID = regexp.MustCompile(`^[a-f0-9]{48}$`)

func (b *BrowserRuntime) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/browser/sessions/"), "/")
	if len(parts) != 2 || !browserViewID.MatchString(parts[0]) {
		http.NotFound(w, r)
		return
	}
	b.mu.Lock()
	session := b.views[parts[0]]
	allowed := session != nil && session.manual && !session.closed
	b.mu.Unlock()
	if !allowed {
		writeError(w, 404, "浏览器接管已结束，或当前没有等待人工操作的会话。")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	var method string
	params := map[string]any{"sessionId": session.id, "viewToken": parts[0]}
	switch parts[1] {
	case "view":
		if r.Method != "GET" {
			methodError(w, "GET")
			return
		}
		method = "view"
	case "action":
		if r.Method != "POST" {
			methodError(w, "POST")
			return
		}
		if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
			writeError(w, 403, "请从当前项目页面操作浏览器。")
			return
		}
		var input struct {
			Action string  `json:"action"`
			X      float64 `json:"x"`
			Y      float64 `json:"y"`
			Text   string  `json:"text"`
			Key    string  `json:"key"`
			URL    string  `json:"url"`
			DeltaY float64 `json:"deltaY"`
		}
		if !decodeBody(w, r, &input) {
			return
		}
		method = "action"
		params["action"] = input.Action
		switch input.Action {
		case "click":
			if input.X < 0 || input.X > 7680 || input.Y < 0 || input.Y > 4320 {
				writeError(w, 400, "点击位置超出窗口范围。")
				return
			}
			params["x"] = input.X
			params["y"] = input.Y
		case "type":
			if len(input.Text) > 16384 {
				writeError(w, 400, "一次填写的内容过长。")
				return
			}
			params["text"] = input.Text
		case "press":
			if len(input.Key) > 64 || strings.ContainsAny(input.Key, "\r\n\x00") {
				writeError(w, 400, "按键格式不正确。")
				return
			}
			params["key"] = input.Key
		case "scroll":
			if input.DeltaY < -4000 || input.DeltaY > 4000 {
				writeError(w, 400, "滚动距离超出范围。")
				return
			}
			params["deltaY"] = input.DeltaY
		case "navigate":
			if err := b.checkedURL(ctx, input.URL); err != nil {
				writeError(w, 400, err.Error())
				return
			}
			params["url"] = input.URL
		default:
			writeError(w, 400, "暂不支持此浏览器操作。")
			return
		}
	default:
		http.NotFound(w, r)
		return
	}
	result, err := session.worker.call(ctx, method, params)
	if err != nil {
		writeError(w, 502, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(200)
	_, _ = w.Write(result)
}

type guardedBrowserProxy struct {
	listener  net.Listener
	server    *http.Server
	transport *http.Transport
	token     string
	guard     *NetworkGuard
	upstream  *ProxyConfig
	ctx       context.Context
	cancel    context.CancelFunc
}

func newGuardedBrowserProxy(guard *NetworkGuard, upstream *ProxyConfig) (*guardedBrowserProxy, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	proxy := &guardedBrowserProxy{listener: listener, token: browserOpaqueID(), guard: guard, upstream: upstream, ctx: ctx, cancel: cancel}
	proxy.transport = guard.NewClient(30 * time.Second).Transport.(*http.Transport)
	proxy.transport.DialContext = proxy.dial
	proxy.server = &http.Server{Handler: proxy, ReadHeaderTimeout: 10 * time.Second, MaxHeaderBytes: 1 << 20}
	go func() { _ = proxy.server.Serve(listener) }()
	return proxy, nil
}
func (p *guardedBrowserProxy) settings() map[string]string {
	return map[string]string{"server": "http://" + p.listener.Addr().String(), "username": "canvas", "password": p.token}
}
func (p *guardedBrowserProxy) close() {
	p.cancel()
	p.transport.CloseIdleConnections()
	_ = p.server.Close()
}
func (p *guardedBrowserProxy) dial(ctx context.Context, network, address string) (net.Conn, error) {
	if p.upstream != nil {
		return p.guard.dialProxy(ctx, network, address, *p.upstream)
	}
	return p.guard.dialContext(ctx, network, address)
}
func (p *guardedBrowserProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	expected := "Basic " + base64.StdEncoding.EncodeToString([]byte("canvas:"+p.token))
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("Proxy-Authorization")), []byte(expected)) != 1 {
		w.Header().Set("Proxy-Authenticate", `Basic realm="HARCanvas"`)
		http.Error(w, "proxy authentication required", 407)
		return
	}
	ctx, cancel := context.WithTimeout(p.ctx, 60*time.Second)
	defer cancel()
	if r.Method == "CONNECT" {
		if _, _, err := net.SplitHostPort(r.Host); err != nil {
			http.Error(w, "invalid destination", 400)
			return
		}
		upstream, err := p.dial(ctx, "tcp", r.Host)
		if err != nil {
			http.Error(w, "destination blocked or unavailable", 502)
			return
		}
		hijacker, ok := w.(http.Hijacker)
		if !ok {
			upstream.Close()
			http.Error(w, "tunnel unavailable", 500)
			return
		}
		client, buffer, err := hijacker.Hijack()
		if err != nil {
			upstream.Close()
			return
		}
		defer client.Close()
		defer upstream.Close()
		_, _ = buffer.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n")
		if buffer.Flush() != nil {
			return
		}
		stop := context.AfterFunc(p.ctx, func() { client.Close(); upstream.Close() })
		defer stop()
		copyDone := make(chan struct{}, 2)
		go func() { _, _ = io.Copy(upstream, buffer); copyDone <- struct{}{} }()
		go func() { _, _ = io.Copy(client, upstream); copyDone <- struct{}{} }()
		<-copyDone
		return
	}
	if r.URL.Scheme != "http" || p.guard.CheckURL(ctx, r.URL) != nil {
		http.Error(w, "destination blocked", 403)
		return
	}
	request := r.Clone(ctx)
	request.RequestURI = ""
	request.Header.Del("Proxy-Authorization")
	request.Header.Del("Proxy-Connection")
	request.Header.Del("Connection")
	request.Header.Del("Upgrade")
	response, err := p.transport.RoundTrip(request)
	if err != nil {
		http.Error(w, "destination blocked or unavailable", 502)
		return
	}
	defer response.Body.Close()
	for name, values := range response.Header {
		if strings.EqualFold(name, "Connection") || strings.EqualFold(name, "Transfer-Encoding") {
			continue
		}
		for _, value := range values {
			w.Header().Add(name, value)
		}
	}
	w.WriteHeader(response.StatusCode)
	_, _ = io.Copy(w, io.LimitReader(response.Body, 32<<20))
}
