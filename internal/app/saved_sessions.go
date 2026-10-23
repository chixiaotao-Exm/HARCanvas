package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http/cookiejar"
	"sync"
	"time"

	"golang.org/x/net/publicsuffix"
)

type savedSession struct {
	jar     *trackingJar
	owner   string
	touched time.Time
}
type savedSessionStore struct {
	mu    sync.Mutex
	items map[string]*savedSession
	now   func() time.Time
	ttl   time.Duration
	limit int
}

func (r *Runner) sessionStore() *savedSessionStore {
	r.savedOnce.Do(func() {
		r.savedSessions = &savedSessionStore{items: map[string]*savedSession{}, now: time.Now, ttl: 30 * time.Minute, limit: 64}
	})
	return r.savedSessions
}
func stableSessionKey(projectID, sessionID string, e EffectiveResources) string {
	data, _ := json.Marshal(struct {
		Project, Session string
		Proxy            *ProxyConfig
		Profile          *BrowserProfileConfig
	}{projectID, sessionID, e.Proxy, e.Profile})
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}
func (s *savedSessionStore) reserve(key, owner string) (*savedSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	for id, entry := range s.items {
		if entry.owner == "" && !now.Before(entry.touched.Add(s.ttl)) {
			delete(s.items, id)
		}
	}
	if saved := s.items[key]; saved != nil {
		if saved.owner != "" && saved.owner != owner {
			return nil, &executionError{"saved_session_busy", "这个已保存会话正在另一个流程中使用，请等待结束或创建新会话。"}
		}
		saved.owner = owner
		saved.touched = now
		return saved, nil
	}
	if len(s.items) >= s.limit {
		oldest := ""
		for id, entry := range s.items {
			if entry.owner == "" && (oldest == "" || entry.touched.Before(s.items[oldest].touched)) {
				oldest = id
			}
		}
		if oldest == "" {
			return nil, &executionError{"saved_session_limit", "已保存会话都在使用中，请稍后重试。"}
		}
		delete(s.items, oldest)
	}
	jar, _ := cookiejar.New(&cookiejar.Options{PublicSuffixList: publicsuffix.List})
	entry := &savedSession{jar: &trackingJar{CookieJar: jar}, owner: owner, touched: now}
	s.items[key] = entry
	return entry, nil
}
func (s *savedSessionStore) release(key, owner string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if entry := s.items[key]; entry != nil && entry.owner == owner {
		entry.owner = ""
		entry.touched = s.now()
	}
}
