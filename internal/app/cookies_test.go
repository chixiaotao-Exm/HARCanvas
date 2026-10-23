package app

import (
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"testing"

	"golang.org/x/net/publicsuffix"
)

func TestSessionJarRejectsPublicSuffixAndTracksDomainDeletion(t *testing.T) {
	standard, _ := cookiejar.New(&cookiejar.Options{PublicSuffixList: publicsuffix.List})
	jar := &trackingJar{CookieJar: standard}
	a, _ := url.Parse("https://a.example.com/auth/login")
	b, _ := url.Parse("https://b.example.com/auth/check")
	other, _ := url.Parse("https://b.unrelated.com/auth/check")
	jar.SetCookies(a, []*http.Cookie{{Name: "super", Value: "bad", Domain: "com", Path: "/"}, {Name: "sid", Value: "fresh", Domain: "example.com", Path: "/auth"}})
	if len(jar.Cookies(b)) != 1 || jar.Cookies(b)[0].Name != "sid" || len(jar.Cookies(other)) != 0 {
		t.Fatal("cookie domain isolation failed")
	}
	jar.SetCookies(a, []*http.Cookie{{Name: "sid", Value: "", Domain: "example.com", Path: "/auth", MaxAge: -1}})
	if len(jar.Cookies(b)) != 0 || !jar.touched(b, "sid") || jar.touched(other, "sid") || jar.touched(b, "super") {
		t.Fatal("cross-subdomain cookie deletion tracking failed")
	}
}
