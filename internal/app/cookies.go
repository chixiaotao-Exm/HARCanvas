package app

import (
	"net/http"
	"net/url"
	"strings"

	"golang.org/x/net/publicsuffix"
)

type cookieScope struct {
	name, domain, path string
	hostOnly           bool
}

// trackingJar remembers Set-Cookie operations, including deletions. A deleted
// cookie must not be resurrected by a later request's captured Cookie header.
type trackingJar struct {
	http.CookieJar
	changed []cookieScope
}

func (j *trackingJar) SetCookies(u *url.URL, cookies []*http.Cookie) {
	j.CookieJar.SetCookies(u, cookies)
	host := strings.ToLower(u.Hostname())
	for _, cookie := range cookies {
		domain := strings.ToLower(strings.TrimPrefix(cookie.Domain, "."))
		hostOnly := domain == ""
		if hostOnly {
			domain = host
		} else {
			if strings.HasSuffix(domain, ".") || !(host == domain || strings.HasSuffix(host, "."+domain)) {
				continue
			}
			suffix, _ := publicsuffix.PublicSuffix(domain)
			if suffix == domain && host != domain {
				continue
			}
		}
		cookiePath := cookie.Path
		if cookiePath == "" || !strings.HasPrefix(cookiePath, "/") {
			cookiePath = "/"
			if slash := strings.LastIndex(u.Path, "/"); slash > 0 {
				cookiePath = u.Path[:slash]
			}
		}
		scope := cookieScope{name: cookie.Name, domain: domain, path: cookiePath, hostOnly: hostOnly}
		found := false
		for _, previous := range j.changed {
			if previous == scope {
				found = true
				break
			}
		}
		if !found {
			j.changed = append(j.changed, scope)
		}
	}
}

func (j *trackingJar) touched(u *url.URL, name string) bool {
	host := strings.ToLower(u.Hostname())
	requestPath := u.Path
	if requestPath == "" {
		requestPath = "/"
	}
	for _, scope := range j.changed {
		if scope.name != name {
			continue
		}
		if host != scope.domain && (scope.hostOnly || !strings.HasSuffix(host, "."+scope.domain)) {
			continue
		}
		if requestPath == scope.path || (strings.HasPrefix(requestPath, scope.path) && (strings.HasSuffix(scope.path, "/") || strings.HasPrefix(requestPath[len(scope.path):], "/"))) {
			return true
		}
	}
	return false
}
