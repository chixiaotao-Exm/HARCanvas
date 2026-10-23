package app

import (
	"bufio"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type testTunnelProxy struct {
	listener     net.Listener
	target       string
	kind         string
	reject       bool
	mu           sync.Mutex
	destinations []string
	users        []string
}

func newTestTunnelProxy(t *testing.T, kind, target string, reject bool) *testTunnelProxy {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	proxy := &testTunnelProxy{listener: listener, target: target, kind: kind, reject: reject}
	t.Cleanup(func() { listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go proxy.handle(conn)
		}
	}()
	return proxy
}
func (p *testTunnelProxy) handle(conn net.Conn) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	target, user := "", ""
	if p.kind == "http" {
		req, err := http.ReadRequest(bufio.NewReader(conn))
		if err != nil || req.Method != "CONNECT" {
			return
		}
		target = req.Host
		auth, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(req.Header.Get("Proxy-Authorization"), "Basic "))
		if err != nil {
			return
		}
		user, _, _ = strings.Cut(string(auth), ":")
		if p.reject {
			io.WriteString(conn, "HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n")
			return
		}
		io.WriteString(conn, "HTTP/1.1 200 Connection Established\r\n\r\n")
	} else {
		var greeting [3]byte
		if _, err := io.ReadFull(conn, greeting[:]); err != nil || greeting != [3]byte{5, 1, 2} {
			return
		}
		conn.Write([]byte{5, 2})
		var authHeader [2]byte
		if _, err := io.ReadFull(conn, authHeader[:]); err != nil || authHeader[0] != 1 {
			return
		}
		name := make([]byte, int(authHeader[1]))
		if _, err := io.ReadFull(conn, name); err != nil {
			return
		}
		user = string(name)
		var plen [1]byte
		if _, err := io.ReadFull(conn, plen[:]); err != nil {
			return
		}
		password := make([]byte, int(plen[0]))
		if _, err := io.ReadFull(conn, password); err != nil {
			return
		}
		if p.reject {
			conn.Write([]byte{1, 1})
			return
		}
		conn.Write([]byte{1, 0})
		var header [4]byte
		if _, err := io.ReadFull(conn, header[:]); err != nil || header[3] != 1 {
			return
		}
		var addr [6]byte
		if _, err := io.ReadFull(conn, addr[:]); err != nil {
			return
		}
		target = fmt.Sprintf("%d.%d.%d.%d:%d", addr[0], addr[1], addr[2], addr[3], int(addr[4])<<8|int(addr[5]))
		conn.Write([]byte{5, 0, 0, 1, 127, 0, 0, 1, 0, 0})
	}
	p.mu.Lock()
	p.destinations = append(p.destinations, target)
	p.users = append(p.users, user)
	p.mu.Unlock()
	upstream, err := net.Dial("tcp", p.target)
	if err != nil {
		return
	}
	defer upstream.Close()
	go func() {
		io.Copy(upstream, conn)
		if tcp, ok := upstream.(*net.TCPConn); ok {
			tcp.CloseWrite()
		}
	}()
	io.Copy(conn, upstream)
}
func proxyTestRunner(proxy *testTunnelProxy) *Runner {
	guard := NewNetworkGuard(false)
	guard.Lookup = func(_ context.Context, _, host string) ([]netip.Addr, error) {
		if host == "proxy.invalid" {
			return []netip.Addr{netip.MustParseAddr("9.9.9.9")}, nil
		}
		if host == "target.invalid" {
			return []netip.Addr{netip.MustParseAddr("8.8.8.8")}, nil
		}
		return nil, fmt.Errorf("unexpected DNS lookup")
	}
	guard.Dial = func(ctx context.Context, network, address string) (net.Conn, error) {
		if address != "9.9.9.9:1080" {
			return nil, fmt.Errorf("unexpected direct dial %s", address)
		}
		return (&net.Dialer{}).DialContext(ctx, network, proxy.listener.Addr().String())
	}
	return &Runner{Guard: guard, Client: guard.NewClient(5 * time.Second)}
}

func TestRuntimeHTTPAndSOCKSProxyActuallyTunnelPinnedTargets(t *testing.T) {
	for _, kind := range []string{"http", "socks5"} {
		t.Run(kind, func(t *testing.T) {
			var calls atomic.Int32
			target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.Header.Get("Proxy-Authorization") != "" {
					t.Error("proxy auth leaked to destination")
				}
				if r.URL.Path == "/start" {
					http.Redirect(w, r, "/done", 302)
					return
				}
				w.Write([]byte(`{"ok":true}`))
			}))
			defer target.Close()
			proxy := newTestTunnelProxy(t, kind, strings.TrimPrefix(target.URL, "http://"), false)
			runner := proxyTestRunner(proxy)
			p := &ProxyConfig{URL: kind + "://account-sid-original:secret@proxy.invalid:1080", Rotation: "request", SessionToken: "original"}
			flow := Flow{Nodes: []FlowNode{block("p", BlockData{Kind: "proxy", Proxy: p}), block("a", BlockData{Kind: "request", URL: "http://target.invalid/start", ProxyID: "p"}), block("b", BlockData{Kind: "request", URL: "http://target.invalid/done", ProxyID: "p"})}, Edges: []FlowEdge{connect("a", "b")}}
			result, err := runner.Run(context.Background(), flow)
			if err != nil || result.Status != "success" || calls.Load() != 3 {
				t.Fatalf("tunnel failed %+v %v calls=%d", result, err, calls.Load())
			}
			proxy.mu.Lock()
			defer proxy.mu.Unlock()
			if len(proxy.destinations) != 3 {
				t.Fatalf("bad destinations %v", proxy.destinations)
			}
			for _, destination := range proxy.destinations {
				if destination != "8.8.8.8:80" {
					t.Fatalf("proxy received unpinned destination %s", destination)
				}
			}
			if proxy.users[0] != proxy.users[1] || proxy.users[1] == proxy.users[2] || strings.Contains(proxy.users[0], "original") {
				t.Fatalf("rotation/redirect identity invalid %v", proxy.users)
			}
		})
	}
}
func TestRuntimeProxyFailureNeverFallsBackDirect(t *testing.T) {
	for _, kind := range []string{"http", "socks5"} {
		t.Run(kind, func(t *testing.T) {
			var calls atomic.Int32
			target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.Write([]byte(`{}`)) }))
			defer target.Close()
			proxy := newTestTunnelProxy(t, kind, strings.TrimPrefix(target.URL, "http://"), true)
			runner := proxyTestRunner(proxy)
			flow := Flow{Nodes: []FlowNode{block("p", BlockData{Kind: "proxy", Proxy: &ProxyConfig{URL: kind + "://name:secret@proxy.invalid:1080"}}), block("req", BlockData{Kind: "request", URL: "http://target.invalid", ProxyID: "p"})}}
			result, err := runner.Run(context.Background(), flow)
			if err != nil || result.Status != "error" || calls.Load() != 0 || result.Steps[0].ErrorCode != "proxy_request_failed" {
				t.Fatalf("bad auth failure %+v %v calls=%d", result, err, calls.Load())
			}
			if strings.Contains(result.Steps[0].Error, "secret") {
				t.Fatal("credential in error")
			}
		})
	}
}
func TestRuntimeProxyCannotReachPrivateDestination(t *testing.T) {
	proxy := newTestTunnelProxy(t, "http", "127.0.0.1:1", false)
	runner := proxyTestRunner(proxy)
	result, err := runner.Run(context.Background(), Flow{Nodes: []FlowNode{block("p", BlockData{Kind: "proxy", Proxy: &ProxyConfig{URL: "http://name:secret@proxy.invalid:1080"}}), block("req", BlockData{Kind: "request", URL: "http://127.0.0.1:80", ProxyID: "p"})}})
	if err != nil || result.Status != "error" {
		t.Fatalf("private request allowed %+v %v", result, err)
	}
	proxy.mu.Lock()
	defer proxy.mu.Unlock()
	if len(proxy.destinations) != 0 {
		t.Fatal("private target reached proxy")
	}
}
