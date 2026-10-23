package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"golang.org/x/net/publicsuffix"
)

const maxStepResponse = 2 << 20
const maxFlowResponses = 8 << 20

var identifier = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,128}$`)
var variableName = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_-]{0,127}$`)
var templateReference = regexp.MustCompile(`\{\{\s*([^{}]+?)\s*\}\}`)

type Runner struct {
	Client *http.Client
	Guard  *NetworkGuard
}

func NewRunner() *Runner {
	guard := NewNetworkGuard(false)
	return &Runner{Client: guard.NewClient(25 * time.Second), Guard: guard}
}

type graph struct {
	nodes    map[string]FlowNode
	incoming map[string][]FlowEdge
	outgoing map[string][]FlowEdge
	order    []string
}

func validateFlow(flow Flow) (*graph, error) {
	if len(flow.Nodes) == 0 || len(flow.Nodes) > 100 {
		return nil, errors.New("flow requires between 1 and 100 nodes")
	}
	if len(flow.Edges) > 300 {
		return nil, errors.New("flow exceeds 300 edges")
	}
	g := &graph{nodes: map[string]FlowNode{}, incoming: map[string][]FlowEdge{}, outgoing: map[string][]FlowEdge{}, order: []string{}}
	for _, node := range flow.Nodes {
		if !identifier.MatchString(node.ID) || g.nodes[node.ID].ID != "" {
			return nil, fmt.Errorf("invalid or duplicate node ID %q", node.ID)
		}
		if node.Type != "block" {
			return nil, fmt.Errorf("node %s has unsupported type %q", node.ID, node.Type)
		}
		switch node.Data.Kind {
		case "input", "extract":
			if !variableName.MatchString(node.Data.Variable) {
				return nil, fmt.Errorf("node %s requires a valid variable name", node.ID)
			}
		case "request":
			if strings.TrimSpace(node.Data.URL) == "" {
				return nil, fmt.Errorf("request %s requires a URL", node.ID)
			}
		case "condition":
			if strings.TrimSpace(node.Data.Variable) == "" {
				return nil, fmt.Errorf("condition %s requires a variable reference", node.ID)
			}
			switch node.Data.Operator {
			case "eq", "neq", "contains", "exists":
			default:
				return nil, fmt.Errorf("condition %s has unsupported operator", node.ID)
			}
		case "output":
		default:
			return nil, fmt.Errorf("node %s has unsupported kind %q", node.ID, node.Data.Kind)
		}
		g.nodes[node.ID] = node
	}
	seenEdges := map[string]bool{}
	for _, edge := range flow.Edges {
		if g.nodes[edge.Source].ID == "" || g.nodes[edge.Target].ID == "" || edge.Source == edge.Target {
			return nil, errors.New("edges require two distinct existing nodes")
		}
		key := edge.Source + "\x00" + edge.Target + "\x00" + edge.SourceHandle
		if seenEdges[key] {
			return nil, errors.New("duplicate connection")
		}
		seenEdges[key] = true
		if g.nodes[edge.Source].Data.Kind == "condition" {
			if edge.SourceHandle != "true" && edge.SourceHandle != "false" {
				return nil, errors.New("condition connections require a true or false sourceHandle")
			}
		} else if edge.SourceHandle == "true" || edge.SourceHandle == "false" {
			return nil, errors.New("true/false connections must start at a condition")
		}
		g.incoming[edge.Target] = append(g.incoming[edge.Target], edge)
		g.outgoing[edge.Source] = append(g.outgoing[edge.Source], edge)
	}
	degrees := map[string]int{}
	ready := []string{}
	for _, node := range flow.Nodes {
		degrees[node.ID] = len(g.incoming[node.ID])
		if degrees[node.ID] == 0 {
			ready = append(ready, node.ID)
		}
	}
	// Use original canvas node order for independent roots, and deterministic
	// connection order thereafter. A flow's execution does not depend on map order.
	for len(ready) > 0 {
		id := ready[0]
		ready = ready[1:]
		g.order = append(g.order, id)
		for _, edge := range g.outgoing[id] {
			degrees[edge.Target]--
			if degrees[edge.Target] == 0 {
				ready = append(ready, edge.Target)
			}
		}
	}
	if len(g.order) != len(flow.Nodes) {
		return nil, errors.New("flow contains a cycle; only directed acyclic flows are supported")
	}
	for _, node := range flow.Nodes {
		if node.Data.Kind != "extract" {
			continue
		}
		if g.nodes[node.Data.Source].ID == "" {
			return nil, fmt.Errorf("extract %s references a missing source node", node.ID)
		}
		visited := map[string]bool{}
		var ancestor func(string) bool
		ancestor = func(id string) bool {
			if visited[id] {
				return false
			}
			visited[id] = true
			for _, edge := range g.incoming[id] {
				if edge.Source == node.Data.Source || ancestor(edge.Source) {
					return true
				}
			}
			return false
		}
		if !ancestor(node.ID) {
			return nil, fmt.Errorf("extract %s source must be connected upstream", node.ID)
		}
		if strings.TrimSpace(node.Data.Path) == "" {
			return nil, fmt.Errorf("extract %s requires a JSON path", node.ID)
		}
	}
	for name := range flow.Inputs {
		if !variableName.MatchString(name) {
			return nil, fmt.Errorf("invalid input name %q", name)
		}
		if len(flow.Inputs[name]) > 2<<20 {
			return nil, fmt.Errorf("input %s exceeds 2 MiB", name)
		}
	}
	return g, nil
}

func (r *Runner) Run(ctx context.Context, flow Flow) (RunResult, error) {
	result := RunResult{Status: "success", Steps: []Step{}, Variables: map[string]any{}}
	g, err := validateFlow(flow)
	if err != nil {
		return result, err
	}
	ctx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	client := *r.Client
	jar, _ := cookiejar.New(&cookiejar.Options{PublicSuffixList: publicsuffix.List})
	sessionJar := &trackingJar{CookieJar: jar}
	client.Jar = sessionJar
	previousRedirect := client.CheckRedirect
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) >= 8 {
			return errors.New("too many redirects")
		}
		if err := r.Guard.CheckURL(req.Context(), req.URL); err != nil {
			return err
		}
		if previousRedirect != nil {
			return previousRedirect(req, via)
		}
		return nil
	}
	results := map[string]any{}
	active := map[string]bool{}
	branches := map[string]bool{}
	for name, value := range flow.Inputs {
		result.Variables[name] = value
	}
	usedResponseBytes := 0
	failed := false
	for _, id := range g.order {
		node := g.nodes[id]
		step := Step{NodeID: id, Label: node.Data.Label, Kind: node.Data.Kind, Status: "success"}
		shouldRun := len(g.incoming[id]) == 0
		for _, edge := range g.incoming[id] {
			if !active[edge.Source] {
				continue
			}
			if g.nodes[edge.Source].Data.Kind == "condition" && ((edge.SourceHandle == "true") != branches[edge.Source]) {
				continue
			}
			shouldRun = true
		}
		if failed || !shouldRun {
			step.Status = "skipped"
			if failed {
				step.Error = "Stopped after a previous step failed"
			}
			result.Steps = append(result.Steps, step)
			continue
		}
		start := time.Now()
		var value any
		var stepErr error
		switch node.Data.Kind {
		case "input":
			input, exists := flow.Inputs[node.Data.Variable]
			if !exists {
				input, stepErr = renderTemplate(node.Data.Value, result.Variables, results)
			}
			if stepErr == nil {
				result.Variables[node.Data.Variable] = input
				value = input
			}
		case "request":
			var size int
			value, size, stepErr = r.executeRequest(ctx, &client, node.Data, result.Variables, results)
			usedResponseBytes += size
			if stepErr == nil && usedResponseBytes > maxFlowResponses {
				stepErr = errors.New("flow responses exceed 8 MiB total limit")
			}
		case "extract":
			source, ok := results[node.Data.Source]
			if !ok {
				stepErr = fmt.Errorf("source node %s did not run", node.Data.Source)
			} else {
				var found bool
				value, found = lookupPath(source, node.Data.Path)
				if !found {
					stepErr = fmt.Errorf("path %q does not exist in %s", node.Data.Path, node.Data.Source)
				} else {
					result.Variables[node.Data.Variable] = value
				}
			}
		case "condition":
			actual, found := resolveReference(node.Data.Variable, result.Variables, results)
			var expected string
			expected, stepErr = renderTemplate(node.Data.Expected, result.Variables, results)
			if stepErr == nil {
				matched := false
				if node.Data.Operator == "exists" {
					matched = found && actual != nil
				} else if !found {
					stepErr = fmt.Errorf("unknown variable %q", node.Data.Variable)
				} else {
					switch node.Data.Operator {
					case "eq":
						matched = stringValue(actual) == expected
					case "neq":
						matched = stringValue(actual) != expected
					case "contains":
						matched = strings.Contains(stringValue(actual), expected)
					}
				}
				branches[id] = matched
				value = map[string]any{"matched": matched}
			}
		case "output":
			value, stepErr = renderTemplate(node.Data.Template, result.Variables, results)
			if stepErr == nil {
				result.Output = value
			}
		}
		step.DurationMS = time.Since(start).Milliseconds()
		if stepErr != nil {
			step.Status = "error"
			step.Error = stepErr.Error()
			result.Status = "error"
			failed = true
		} else {
			active[id] = true
			results[id] = value
			step.Result = value
		}
		result.Steps = append(result.Steps, step)
	}
	return result, nil
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
	address, err := renderTemplate(data.URL, variables, results)
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
	body, err := renderTemplate(data.Body, variables, results)
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
	return map[string]any{"status": response.StatusCode, "headers": headers, "body": decoded}, len(responseBody), nil
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
