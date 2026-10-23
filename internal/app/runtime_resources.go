package app

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strconv"
	"strings"
	"time"

	"golang.org/x/net/publicsuffix"
)

type EffectiveResources struct {
	SessionPersistent  bool
	StableSessionID    string
	ProxyID            string
	ProfileID          string
	SessionID          string
	ExecutionSessionID string
	Proxy              *ProxyConfig
	Profile            *BrowserProfileConfig
}

type BrowserExecutor interface {
	Execute(context.Context, FlowNode, EffectiveResources, map[string]any, map[string]any, func(context.Context, PendingInput) (string, error)) (any, error)
}
type BrowserRunCloser interface {
	CloseRun(context.Context, string) error
}
type BrowserScopeCloser interface {
	CloseScope(context.Context, string) error
}

type runtimeSession struct{ client *http.Client }
type runResources struct {
	runner    *Runner
	nodes     map[string]FlowNode
	bindings  []ResourceBinding
	sessions  map[string]*runtimeSession
	tokens    map[string]string
	start     time.Time
	now       func() time.Time
	runID     string
	defaults  ResourceDefaults
	projectID string
	saved     map[string]*savedSession
}

func newRunResources(r *Runner, flow Flow) *runResources {
	rr := &runResources{runner: r, nodes: map[string]FlowNode{}, sessions: map[string]*runtimeSession{}, tokens: map[string]string{}, start: time.Now(), now: time.Now, runID: randomSessionToken(), defaults: flow.Defaults, projectID: flow.ProjectID, saved: map[string]*savedSession{}}
	var collect func([]FlowNode)
	collect = func(nodes []FlowNode) {
		for _, n := range nodes {
			if resourceKind(n.Data.Kind) {
				rr.nodes[n.ID] = n
			}
			if n.Data.Loop != nil {
				collect(n.Data.Loop.Nodes)
			}
		}
	}
	collect(flow.Nodes)
	rr.bindings = append([]ResourceBinding(nil), flow.ResourceBindings...)
	return rr
}
func randomSessionToken() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("secure random source unavailable")
	}
	return hex.EncodeToString(b[:])
}
func (rr *runResources) close() {
	defer func() {
		if rr.runner != nil && len(rr.saved) > 0 {
			for key := range rr.saved {
				rr.runner.sessionStore().release(key, rr.runID)
			}
		}
	}()
	for _, s := range rr.sessions {
		s.client.CloseIdleConnections()
	}
	if closer, ok := rr.runner.Browser.(BrowserRunCloser); ok {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = closer.CloseRun(ctx, rr.runID)
	}
}

// A fresh iteration cannot use its state after that scope finishes. Release it
// before starting the next iteration so sequential work does not fill the
// browser's concurrent-context limit or retain every temporary HTTP cookie jar.
func (rr *runResources) closeScope(scopeKey string) {
	if scopeKey == "" {
		return
	}
	prefix := rr.runID + ":" + scopeKey + ":"
	for key, session := range rr.sessions {
		if strings.HasPrefix(key, prefix) {
			session.client.CloseIdleConnections()
			delete(rr.sessions, key)
		}
	}
	if closer, ok := rr.runner.Browser.(BrowserScopeCloser); ok {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = closer.CloseScope(ctx, prefix)
	}
}

func (rr *runResources) config(node FlowNode, defaults ResourceDefaults, scopeKey string) (EffectiveResources, error) {
	d := ResourceDefaults{node.Data.SessionID, node.Data.ProxyID, node.Data.ProfileID}
	for _, b := range rr.bindings {
		if b.TargetID != node.ID {
			continue
		}
		switch rr.nodes[b.ResourceID].Data.Kind {
		case "proxy":
			if d.ProxyID == "" {
				d.ProxyID = b.ResourceID
			}
		case "profile":
			if d.ProfileID == "" {
				d.ProfileID = b.ResourceID
			}
		case "browserSession":
			if d.SessionID == "" {
				d.SessionID = b.ResourceID
			}
		}
	}
	if d.SessionID == "" {
		d.SessionID = defaults.SessionID
	}
	if d.SessionID == "" {
		d.SessionID = rr.defaults.SessionID
	}
	if d.ProxyID == "" {
		d.ProxyID = defaults.ProxyID
	}
	if d.ProfileID == "" {
		d.ProfileID = defaults.ProfileID
	}
	session := rr.nodes[d.SessionID].Data.Session
	if session != nil {
		if d.ProxyID == "" {
			d.ProxyID = session.ProxyID
		}
		if d.ProfileID == "" {
			d.ProfileID = session.ProfileID
		}
		for _, b := range rr.bindings {
			if b.TargetID != d.SessionID {
				continue
			}
			switch rr.nodes[b.ResourceID].Data.Kind {
			case "proxy":
				if d.ProxyID == "" {
					d.ProxyID = b.ResourceID
				}
			case "profile":
				if d.ProfileID == "" {
					d.ProfileID = b.ResourceID
				}
			}
		}
	}
	if d.ProxyID == "" {
		d.ProxyID = rr.defaults.ProxyID
	}
	if d.ProfileID == "" {
		d.ProfileID = rr.defaults.ProfileID
	}
	result := EffectiveResources{SessionID: d.SessionID, ExecutionSessionID: rr.runID + ":" + scopeKey, ProxyID: d.ProxyID, ProfileID: d.ProfileID}
	if result.SessionID == "" {
		result.SessionID = "default"
		if node.Data.CaptureID != "" {
			result.SessionID = "capture:" + node.Data.CaptureID
		}
	}
	result.ExecutionSessionID += ":" + result.SessionID
	if d.ProxyID != "" {
		p := rr.nodes[d.ProxyID].Data.Proxy
		if p == nil {
			return result, &executionError{"resource_missing", "所选代理已删除，请重新选择。"}
		}
		copy := *p
		result.Proxy = &copy
		if p.Rotation != "" && p.Rotation != "fixed" {
			bucket := "run"
			if p.Rotation == "request" {
				bucket = randomSessionToken()
			} else if p.Rotation == "minutes" {
				bucket = strconv.FormatInt(int64(rr.now().Sub(rr.start)/time.Minute)/int64(p.RotationMinutes), 10)
			}
			key := d.ProxyID + ":" + bucket
			token := rr.tokens[key]
			if token == "" {
				token = randomSessionToken()
				rr.tokens[key] = token
			}
			u, _ := url.Parse(p.URL)
			pass, hasPass := u.User.Password()
			name := strings.Replace(u.User.Username(), p.SessionToken, token, 1)
			if hasPass {
				u.User = url.UserPassword(name, pass)
			} else {
				u.User = url.User(name)
			}
			result.Proxy.URL = u.String()
		}
	}
	if d.ProfileID != "" {
		p := rr.nodes[d.ProfileID].Data.Profile
		if p == nil {
			return result, &executionError{"resource_missing", "所选画像已删除，请重新选择。"}
		}
		copy := *p
		result.Profile = &copy
	}
	if session != nil && session.Persist && scopeKey == "" {
		result.SessionPersistent = true
		result.StableSessionID = stableSessionKey(rr.projectID, d.SessionID, result)
		if rr.runner != nil {
			if rr.saved[result.StableSessionID] == nil {
				saved, err := rr.runner.sessionStore().reserve(result.StableSessionID, rr.runID)
				if err != nil {
					return result, err
				}
				rr.saved[result.StableSessionID] = saved
			}
		}
	}
	return result, nil
}

func (rr *runResources) client(e EffectiveResources) (*http.Client, error) {
	key := e.ExecutionSessionID
	if e.SessionPersistent {
		key += ":" + e.StableSessionID
	}
	session := rr.sessions[key]
	if session == nil {
		client := *rr.runner.Client
		jar, _ := cookiejar.New(&cookiejar.Options{PublicSuffixList: publicsuffix.List})
		client.Jar = &trackingJar{CookieJar: jar}
		if e.SessionPersistent {
			if saved := rr.saved[e.StableSessionID]; saved != nil {
				client.Jar = saved.jar
			}
		}
		previous := client.CheckRedirect
		client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
			if len(via) >= 8 {
				return errors.New("too many redirects")
			}
			if len(via) > 0 && via[0].URL.Scheme == "https" && req.URL.Scheme != "https" {
				return errors.New("HTTPS to HTTP redirect is not allowed")
			}
			if err := rr.runner.Guard.CheckURL(req.Context(), req.URL); err != nil {
				return err
			}
			if previous != nil {
				return previous(req, via)
			}
			return nil
		}
		session = &runtimeSession{client: &client}
		rr.sessions[key] = session
	}
	if e.Proxy == nil {
		return session.client, nil
	}
	// Each logical request uses a fresh tunnel transport. Its redirects reuse that
	// same proxy identity; later requests can rotate without reusing old tunnels.
	client := *session.client
	client.Transport = rr.runner.Guard.proxyTransport(*e.Proxy)
	return &client, nil
}

func (g *NetworkGuard) proxyTransport(config ProxyConfig) *http.Transport {
	tr := g.NewClient(25 * time.Second).Transport.(*http.Transport)
	tr.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		return g.dialProxy(ctx, network, address, config)
	}
	tr.DisableKeepAlives = true
	return tr
}

func (g *NetworkGuard) dialProxy(ctx context.Context, network, address string, config ProxyConfig) (net.Conn, error) {
	resolved := config
	resolved.Rotation = "fixed"
	if err := validateProxyConfig(resolved); err != nil {
		return nil, errors.New("invalid proxy configuration")
	}
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	destinations, err := g.resolve(ctx, host)
	if err != nil {
		return nil, err
	}
	proxyURL, _ := url.Parse(config.URL)
	conn, err := g.dialContext(ctx, "tcp", proxyURL.Host)
	if err != nil {
		return nil, errors.New("proxy connection failed")
	}
	success := false
	defer func() {
		if !success {
			conn.Close()
		}
	}()
	deadline := time.Now().Add(20 * time.Second)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	_ = conn.SetDeadline(deadline)
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()
	if proxyURL.Scheme == "https" {
		secured := tls.Client(conn, &tls.Config{MinVersion: tls.VersionTLS12, ServerName: proxyURL.Hostname()})
		if err := secured.HandshakeContext(ctx); err != nil {
			return nil, errors.New("proxy TLS handshake failed")
		}
		conn = secured
	}
	target := net.JoinHostPort(destinations[0].Unmap().String(), port)
	if proxyURL.Scheme == "socks5" {
		err = socksHandshake(conn, proxyURL, target)
	} else {
		err = connectHandshake(conn, proxyURL, target)
	}
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	_ = conn.SetDeadline(time.Time{})
	success = true
	return conn, nil
}

func socksHandshake(conn net.Conn, u *url.URL, target string) error {
	methods := []byte{5, 1, 0}
	if u.User != nil {
		methods = []byte{5, 1, 2}
	}
	if _, err := conn.Write(methods); err != nil {
		return errors.New("SOCKS5 negotiation failed")
	}
	var reply [2]byte
	if _, err := io.ReadFull(conn, reply[:]); err != nil || reply[0] != 5 {
		return errors.New("SOCKS5 negotiation failed")
	}
	if reply[1] == 2 && u.User != nil {
		name := u.User.Username()
		pass, _ := u.User.Password()
		packet := append([]byte{1, byte(len(name))}, []byte(name)...)
		packet = append(packet, byte(len(pass)))
		packet = append(packet, []byte(pass)...)
		if _, err := conn.Write(packet); err != nil {
			return errors.New("proxy authentication failed")
		}
		if _, err := io.ReadFull(conn, reply[:]); err != nil || reply[1] != 0 {
			return errors.New("proxy authentication failed")
		}
	} else if reply[1] != 0 || u.User != nil {
		return errors.New("proxy authentication method rejected")
	}
	host, portText, _ := net.SplitHostPort(target)
	port, _ := strconv.Atoi(portText)
	ip := net.ParseIP(host)
	packet := []byte{5, 1, 0}
	if v4 := ip.To4(); v4 != nil {
		packet = append(packet, 1)
		packet = append(packet, v4...)
	} else {
		packet = append(packet, 4)
		packet = append(packet, ip.To16()...)
	}
	packet = append(packet, byte(port>>8), byte(port))
	if _, err := conn.Write(packet); err != nil {
		return errors.New("proxy tunnel failed")
	}
	var header [4]byte
	if _, err := io.ReadFull(conn, header[:]); err != nil || header[0] != 5 || header[1] != 0 {
		return errors.New("proxy tunnel rejected")
	}
	size := 0
	switch header[3] {
	case 1:
		size = 4
	case 4:
		size = 16
	case 3:
		var b [1]byte
		if _, err := io.ReadFull(conn, b[:]); err != nil {
			return err
		}
		size = int(b[0])
	default:
		return errors.New("invalid SOCKS5 response")
	}
	_, err := io.CopyN(io.Discard, conn, int64(size+2))
	return err
}
func connectHandshake(conn net.Conn, u *url.URL, target string) error {
	headers := "CONNECT " + target + " HTTP/1.1\r\nHost: " + target + "\r\n"
	if u.User != nil {
		password, _ := u.User.Password()
		headers += "Proxy-Authorization: Basic " + base64.StdEncoding.EncodeToString([]byte(u.User.Username()+":"+password)) + "\r\n"
	}
	headers += "\r\n"
	if _, err := io.WriteString(conn, headers); err != nil {
		return errors.New("proxy CONNECT failed")
	}
	reader := bufio.NewReader(io.LimitReader(conn, 64<<10))
	response, err := http.ReadResponse(reader, &http.Request{Method: "CONNECT"})
	if err != nil {
		return errors.New("invalid proxy CONNECT response")
	}
	if response.StatusCode != 200 {
		return errors.New("proxy CONNECT authentication or tunnel rejected")
	}
	if reader.Buffered() != 0 {
		return errors.New("unexpected data in proxy CONNECT response")
	}
	return nil
}

func (s *Server) testProxy(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Proxy ProxyConfig `json:"proxy"`
		URL   string      `json:"url"`
	}
	if !decodeBody(w, r, &input) {
		return
	}
	if err := validateProxyConfig(input.Proxy); err != nil {
		writeError(w, 400, err.Error())
		return
	}
	if input.URL == "" {
		input.URL = "https://api.ipify.org?format=json"
	}
	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()
	flow := Flow{Nodes: []FlowNode{{ID: "proxy", Type: "block", Data: BlockData{Kind: "proxy", Proxy: &input.Proxy}}, {ID: "test", Type: "block", Data: BlockData{Kind: "request", URL: input.URL, ProxyID: "proxy"}}}}
	start := time.Now()
	result, err := s.Runner.Run(ctx, flow)
	if err != nil {
		writeError(w, 400, "代理测试配置无效。")
		return
	}
	response := map[string]any{"status": result.Status, "durationMs": time.Since(start).Milliseconds()}
	if result.Status != "success" {
		response["message"] = "代理连接失败，请检查地址、凭据和目的地址。"
	} else if len(result.Steps) > 0 {
		if value, ok := result.Steps[0].Result.(map[string]any); ok {
			response["httpStatus"] = value["status"]
			if body, ok := value["body"].(map[string]any); ok {
				if ip, ok := body["ip"].(string); ok && net.ParseIP(strings.TrimSpace(ip)) != nil {
					response["ip"] = ip
				}
			}
		}
	}
	// Never return arbitrary response headers/bodies: a proxy test must not copy
	// credentials or unrelated remote content into the diagnostic panel.
	writeJSON(w, 200, response)
}
