package app

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"testing"
)

func TestGuardBlocksPrivateReservedAndMetadata(t *testing.T) {
	for _, address := range []string{"http://127.0.0.1", "http://10.0.0.1", "http://172.16.0.1", "http://192.168.1.1", "http://169.254.169.254", "http://100.100.100.200", "http://[::1]", "http://[::ffff:127.0.0.1]", "http://[fc00::1]", "http://[fd00:ec2::254]", "http://[fe80::1]", "http://[64:ff9b::a00:1]", "http://192.0.2.1", "http://0.0.0.0", "file:///etc/passwd", "http://metadata.google.internal"} {
		u, err := url.Parse(address)
		if err != nil {
			t.Fatal(err)
		}
		if err := NewNetworkGuard(false).CheckURL(context.Background(), u); err == nil {
			t.Errorf("replay accepted %s", address)
		}
	}
	local := NewNetworkGuard(true)
	for _, address := range []string{"http://127.0.0.1/v1", "http://[::1]/v1", "http://10.0.0.1/v1"} {
		u, _ := url.Parse(address)
		if err := local.CheckURL(context.Background(), u); err != nil {
			t.Errorf("local provider rejected %s: %v", address, err)
		}
	}
	for _, address := range []string{"http://169.254.169.254/v1", "http://100.100.100.200/v1", "http://[fd00:ec2::254]/v1"} {
		u, _ := url.Parse(address)
		if err := local.CheckURL(context.Background(), u); err == nil {
			t.Errorf("provider accepted metadata %s", address)
		}
	}
}

func TestGuardRejectsMixedDNSAndRebinding(t *testing.T) {
	g := NewNetworkGuard(false)
	g.Lookup = func(context.Context, string, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("8.8.8.8"), netip.MustParseAddr("127.0.0.1")}, nil
	}
	u, _ := url.Parse("https://untrusted.example")
	if err := g.CheckURL(context.Background(), u); err == nil {
		t.Fatal("mixed public/private DNS was accepted")
	}
	lookups := 0
	dialed := false
	g.Lookup = func(context.Context, string, string) ([]netip.Addr, error) {
		lookups++
		if lookups == 1 {
			return []netip.Addr{netip.MustParseAddr("8.8.8.8")}, nil
		}
		return []netip.Addr{netip.MustParseAddr("127.0.0.1")}, nil
	}
	g.Dial = func(context.Context, string, string) (net.Conn, error) {
		dialed = true
		return nil, errors.New("should not dial")
	}
	if err := g.CheckURL(context.Background(), u); err != nil {
		t.Fatal(err)
	}
	if _, err := g.dialContext(context.Background(), "tcp", "untrusted.example:443"); err == nil || dialed {
		t.Fatal("rebound destination reached dial")
	}
}

func TestGuardDialsCheckedLiteralIP(t *testing.T) {
	g := NewNetworkGuard(false)
	g.Lookup = func(context.Context, string, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("8.8.8.8")}, nil
	}
	sentinel := errors.New("dial intercepted")
	g.Dial = func(_ context.Context, network, address string) (net.Conn, error) {
		if network != "tcp" || address != "8.8.8.8:443" {
			t.Fatalf("dial was not pinned: %s %s", network, address)
		}
		return nil, sentinel
	}
	if _, err := g.dialContext(context.Background(), "tcp", "untrusted.example:443"); !errors.Is(err, sentinel) {
		t.Fatal(err)
	}
}

func TestGuardBlocksRedirectToPrivateHost(t *testing.T) {
	runner := NewRunner()
	calls := 0
	runner.Client.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		calls++
		return jsonResponse(302, ``, http.Header{"Location": []string{"http://127.0.0.1/secret"}}), nil
	})
	flow := Flow{Nodes: []FlowNode{block("fetch", BlockData{Kind: "request", URL: "https://8.8.8.8/start"})}}
	result, err := runner.Run(context.Background(), flow)
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "error" || calls != 1 {
		t.Fatalf("private redirect reached transport: %+v, calls=%d", result, calls)
	}
}
