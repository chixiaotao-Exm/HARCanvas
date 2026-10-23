package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const maxStepResponse = 2 << 20
const maxFlowResponses = 8 << 20

var identifier = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,128}$`)
var variableName = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_-]{0,127}$`)
var templateReference = regexp.MustCompile(`\{\{\s*([^{}]+?)\s*\}\}`)

type Runner struct {
	Client        *http.Client
	Guard         *NetworkGuard
	Browser       BrowserExecutor
	savedOnce     sync.Once
	savedSessions *savedSessionStore
}

func NewRunner() *Runner {
	guard := NewNetworkGuard(false)
	return &Runner{Client: guard.NewClient(25 * time.Second), Guard: guard}
}

type graph struct {
	nodes     map[string]FlowNode
	incoming  map[string][]FlowEdge
	outgoing  map[string][]FlowEdge
	order     []string
	entry     string
	reachable map[string]bool
}

func (r *Runner) executeRequest(ctx context.Context, client *http.Client, data BlockData, variables, results map[string]any) (any, int, error) {
	method := strings.ToUpper(strings.TrimSpace(data.Method))
	if method == "" {
		method = "GET"
	}
	switch method {
	case "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS":
	default:
		return nil, 0, errors.New("unsupported HTTP method")
	}
	address, err := renderRequestURL(data.URL, variables, results)
	if err != nil {
		return nil, 0, err
	}
	u, err := url.Parse(address)
	if err != nil {
		return nil, 0, fmt.Errorf("invalid URL: %w", err)
	}
	if err := r.Guard.CheckURL(ctx, u); err != nil {
		return nil, 0, fmt.Errorf("request blocked: %w", err)
	}
	body, err := renderRequestBody(data.Body, variables, results)
	if err != nil {
		return nil, 0, err
	}
	if len(body) > 2<<20 {
		return nil, 0, errors.New("request body exceeds 2 MiB")
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), strings.NewReader(body))
	if err != nil {
		return nil, 0, err
	}
	blocked := map[string]bool{"host": true, "content-length": true, "connection": true, "proxy-connection": true, "proxy-authorization": true, "keep-alive": true, "te": true, "trailer": true, "transfer-encoding": true, "upgrade": true, "accept-encoding": true}
	for _, name := range strings.Split(headerValue(data.Headers, "Connection"), ",") {
		blocked[strings.ToLower(strings.TrimSpace(name))] = true
	}
	keys := make([]string, 0, len(data.Headers))
	for name := range data.Headers {
		keys = append(keys, name)
	}
	sort.Strings(keys)
	for _, name := range keys {
		if strings.HasPrefix(name, ":") || blocked[strings.ToLower(name)] {
			continue
		}
		value, err := renderTemplate(data.Headers[name], variables, results)
		if err != nil {
			return nil, 0, err
		}
		req.Header.Add(name, value)
	}
	// Captured cookies remain usable, while newer session cookies replace stale
	// values by name. http.Client adds current jar cookies itself after this.
	if client.Jar != nil && req.Header.Get("Cookie") != "" {
		current := map[string]bool{}
		for _, cookie := range client.Jar.Cookies(req.URL) {
			current[cookie.Name] = true
		}
		original := req.Cookies()
		req.Header.Del("Cookie")
		for _, cookie := range original {
			seen := false
			if tracking, ok := client.Jar.(*trackingJar); ok {
				seen = tracking.touched(req.URL, cookie.Name)
			}
			if !current[cookie.Name] && !seen {
				req.AddCookie(cookie)
			}
		}
	}
	response, err := client.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("HTTP request failed: %w", err)
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, maxStepResponse+1))
	if err != nil {
		return nil, 0, fmt.Errorf("reading response: %w", err)
	}
	if len(responseBody) > maxStepResponse {
		return nil, len(responseBody), errors.New("response exceeds 2 MiB limit")
	}
	var decoded any
	decoder := json.NewDecoder(bytes.NewReader(responseBody))
	decoder.UseNumber()
	if err := decoder.Decode(&decoded); err != nil {
		decoded = string(responseBody)
	} else {
		var trailing any
		if decoder.Decode(&trailing) != io.EOF {
			decoded = string(responseBody)
		}
	}
	if len(responseBody) == 0 {
		decoded = ""
	}
	headers := map[string]string{}
	for name, values := range response.Header {
		sep := ", "
		if strings.EqualFold(name, "Set-Cookie") {
			sep = "\n"
		}
		headers[name] = strings.Join(values, sep)
	}
	value := map[string]any{"status": response.StatusCode, "headers": headers, "body": decoded}
	if !acceptsStatus(data.AcceptStatus, response.StatusCode) {
		return value, len(responseBody), &executionError{Code: "http_status", Message: fmt.Sprintf("请求返回 HTTP %d，未满足允许的状态码。", response.StatusCode)}
	}
	return value, len(responseBody), nil
}

func renderTemplate(template string, variables, results map[string]any) (string, error) {
	const maxRendered = 2 << 20
	if len(template) > maxRendered {
		return "", errors.New("template exceeds 2 MiB")
	}
	var rendered strings.Builder
	appendPart := func(part string) error {
		if len(part) > maxRendered-rendered.Len() {
			return errors.New("rendered template exceeds 2 MiB")
		}
		rendered.WriteString(part)
		return nil
	}
	plain := func(part string) error {
		if strings.Contains(part, "{{") {
			return errors.New("malformed template; use {{name}} or {{nodeId.body.field}}")
		}
		return appendPart(part)
	}
	remaining := template
	for {
		match := templateReference.FindStringSubmatchIndex(remaining)
		if match == nil {
			if err := plain(remaining); err != nil {
				return "", err
			}
			break
		}
		if err := plain(remaining[:match[0]]); err != nil {
			return "", err
		}
		name := strings.TrimSpace(remaining[match[2]:match[3]])
		value, found := resolveReference(name, variables, results)
		if !found {
			return "", fmt.Errorf("unknown template reference %q", name)
		}
		if err := appendPart(stringValue(value)); err != nil {
			return "", err
		}
		remaining = remaining[match[1]:]
	}
	return rendered.String(), nil
}
func resolveReference(reference string, variables, results map[string]any) (any, bool) {
	reference = strings.TrimSpace(reference)
	if value, ok := variables[reference]; ok {
		return value, true
	}
	name, path, hasPath := strings.Cut(reference, ".")
	if value, ok := variables[name]; ok {
		if !hasPath {
			return value, true
		}
		return lookupPath(value, path)
	}
	if value, ok := results[name]; ok {
		if !hasPath {
			return value, true
		}
		return lookupPath(value, path)
	}
	return nil, false
}
func lookupPath(value any, path string) (any, bool) {
	if path == "" {
		return value, true
	}
	for _, part := range strings.Split(path, ".") {
		switch current := value.(type) {
		case map[string]any:
			var ok bool
			value, ok = current[part]
			if !ok {
				return nil, false
			}
		case map[string]string:
			var ok bool
			value, ok = current[part]
			if !ok {
				return nil, false
			}
		case []any:
			index, err := strconv.Atoi(part)
			if err != nil || index < 0 || index >= len(current) {
				return nil, false
			}
			value = current[index]
		default:
			return nil, false
		}
	}
	return value, true
}
func stringValue(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprint(value)
	}
	return string(encoded)
}
