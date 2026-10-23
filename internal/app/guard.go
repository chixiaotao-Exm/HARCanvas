package app

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
)

// NetworkGuard checks the URL, every DNS answer, and the concrete dial target.
// The HTTP transport deliberately ignores environment proxy variables: a proxy
// would resolve names outside this guard and invalidate the destination check.
type NetworkGuard struct {
	AllowLocalProvider bool
	Lookup             func(context.Context, string, string) ([]netip.Addr, error)
	Dial               func(context.Context, string, string) (net.Conn, error)
}

var blockedRanges = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"), netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"), netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("64:ff9b::/96"), netip.MustParsePrefix("64:ff9b:1::/48"),
	netip.MustParsePrefix("100::/64"), netip.MustParsePrefix("2001::/32"),
	netip.MustParsePrefix("2001:db8::/32"), netip.MustParsePrefix("2002::/16"),
}

func NewNetworkGuard(allowLocalProvider bool) *NetworkGuard {
	dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	return &NetworkGuard{AllowLocalProvider: allowLocalProvider, Lookup: net.DefaultResolver.LookupNetIP, Dial: dialer.DialContext}
}

func (g *NetworkGuard) allowed(addr netip.Addr) bool {
	addr = addr.Unmap()
	if !addr.IsValid() || addr.IsUnspecified() || addr.IsMulticast() || addr.IsLinkLocalUnicast() || addr.IsLinkLocalMulticast() {
		return false
	}
	if addr == netip.MustParseAddr("100.100.100.200") || addr == netip.MustParseAddr("fd00:ec2::254") {
		return false
	}
	if g.AllowLocalProvider && (addr.IsLoopback() || addr.IsPrivate()) {
		return true
	}
	if !addr.IsGlobalUnicast() || addr.IsLoopback() || addr.IsPrivate() {
		return false
	}
	for _, prefix := range blockedRanges {
		if prefix.Contains(addr) {
			return false
		}
	}
	return true
}

func (g *NetworkGuard) resolve(ctx context.Context, hostname string) ([]netip.Addr, error) {
	name := strings.ToLower(strings.TrimSuffix(hostname, "."))
	if strings.Contains(name, "%") {
		return nil, errors.New("IPv6 zone identifiers are not allowed")
	}
	if name == "metadata" || name == "metadata.google.internal" || name == "instance-data" || strings.HasSuffix(name, ".metadata.google.internal") {
		return nil, errors.New("cloud metadata endpoints are not allowed")
	}
	var addresses []netip.Addr
	if ip, err := netip.ParseAddr(name); err == nil {
		addresses = []netip.Addr{ip}
	} else {
		var err error
		addresses, err = g.Lookup(ctx, "ip", name)
		if err != nil {
			return nil, fmt.Errorf("DNS lookup failed: %w", err)
		}
	}
	if len(addresses) == 0 {
		return nil, errors.New("host has no IP addresses")
	}
	for _, ip := range addresses {
		if !g.allowed(ip) {
			return nil, errors.New("destination resolves to a private, reserved, or metadata address")
		}
	}
	return addresses, nil
}

func (g *NetworkGuard) CheckURL(ctx context.Context, u *url.URL) error {
	if u == nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
		return errors.New("only absolute HTTP and HTTPS URLs are supported")
	}
	if u.User != nil {
		return errors.New("URL credentials are not supported; use request headers")
	}
	if u.Fragment != "" {
		return errors.New("URL fragments are not sent in HTTP requests")
	}
	if _, err := g.resolve(ctx, u.Hostname()); err != nil {
		return err
	}
	return nil
}

func (g *NetworkGuard) dialContext(ctx context.Context, network, address string) (net.Conn, error) {
	hostname, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	addresses, err := g.resolve(ctx, hostname)
	if err != nil {
		return nil, err
	}
	var lastErr error
	for _, ip := range addresses {
		// Dial a checked literal IP instead of the hostname, preventing a second
		// DNS lookup from resolving the same host to an internal address.
		conn, err := g.Dial(ctx, network, net.JoinHostPort(ip.Unmap().String(), port))
		if err == nil {
			return conn, nil
		}
		lastErr = err
	}
	return nil, lastErr
}

func (g *NetworkGuard) NewClient(timeout time.Duration) *http.Client {
	transport := &http.Transport{
		DialContext:            g.dialContext,
		ForceAttemptHTTP2:      true,
		TLSClientConfig:        &tls.Config{MinVersion: tls.VersionTLS12},
		TLSHandshakeTimeout:    10 * time.Second,
		ResponseHeaderTimeout:  20 * time.Second,
		MaxResponseHeaderBytes: 1 << 20,
		MaxIdleConns:           20,
		MaxIdleConnsPerHost:    4,
		IdleConnTimeout:        30 * time.Second,
	}
	return &http.Client{Transport: transport, Timeout: timeout, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 8 {
			return errors.New("too many redirects")
		}
		if via[0].URL.Scheme == "https" && req.URL.Scheme != "https" {
			return errors.New("HTTPS to HTTP redirect is not allowed")
		}
		return g.CheckURL(req.Context(), req.URL)
	}}
}
