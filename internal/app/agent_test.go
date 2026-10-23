package app

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestAgentUsesConfiguredCompatibleProviderAndValidatesDependencies(t *testing.T) {
	purpose := "根据前一步响应中的 id 查询处理结果，返回当前处理状态供后续条件判断使用；HAR 未提供字段文档，无法确认所有状态值的业务含义。"
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" || r.Method != "POST" || r.Header.Get("Authorization") != "Bearer visible-key" {
			t.Errorf("wrong provider request: %s %s", r.Method, r.URL.Path)
		}
		var input struct {
			Model    string                           `json:"model"`
			Messages []struct{ Role, Content string } `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			t.Error(err)
		}
		if input.Model != "my-model" || len(input.Messages) != 2 || !strings.Contains(input.Messages[1].Content, "req-2") {
			t.Error("wrong model or request payload")
		}
		content := `{"summary":"两个相关请求","suggestions":[{"requestId":"req-2","label":"查询处理结果","description":"` + purpose + `","category":"api","dependencies":["req-1"],"confidence":"high","variables":[{"name":"id","source":"req-1.body.id","description":"结果编号"}]}],"warnings":[]}`
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": content}}}})
	}))
	defer provider.Close()
	result, err := NewAnalyzer().Analyze(context.Background(), AgentConfig{BaseURL: provider.URL + "/v1/", APIKey: "visible-key", Model: "my-model"}, []Request{{ID: "req-1"}, {ID: "req-2"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Suggestions) != 1 || result.Suggestions[0].Dependencies[0] != "req-1" || result.Suggestions[0].Label != "查询处理结果" || result.Suggestions[0].Description != purpose || len(result.Warnings) != 1 {
		t.Fatalf("wrong analysis: %+v", result)
	}
}

func TestAgentRejectsInvalidUntrustedOutput(t *testing.T) {
	cases := []string{
		`not-json`,
		`{"summary":"x","suggestions":[{"requestId":"invented","label":"x","description":"查询记录用途"}]}`,
		`{"summary":"x","suggestions":[{"requestId":"req-1","label":"x","description":"查询记录用途","dependencies":["invented"]}]}`,
		`{"summary":"x","suggestions":[{"requestId":"req-1","label":"x","description":"查询记录用途","dependencies":["req-1"]}]}`,
		`{"summary":"x","suggestions":[{"requestId":"req-1","label":"x","description":"查询记录用途"},{"requestId":"req-1","label":"y","description":"查询另一记录用途"}]}`,
		`{"suggestions":[]}`,
	}
	for i, content := range cases {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": content}}}})
			}))
			defer provider.Close()
			_, err := NewAnalyzer().Analyze(context.Background(), AgentConfig{BaseURL: provider.URL + "/v1", APIKey: "key", Model: "model"}, []Request{{ID: "req-1"}})
			if err == nil {
				t.Fatal("untrusted invalid analysis accepted")
			}
		})
	}
}

func TestAgentRejectsMissingOrBlankPurposeDescription(t *testing.T) {
	for _, description := range []string{"", `,"description":""`, `,"description":"  \n\t  "`, `,"description":null`} {
		t.Run(fmt.Sprintf("description_%q", description), func(t *testing.T) {
			content := `{"summary":"用途分析","suggestions":[{"requestId":"req-1","label":"查询处理状态"` + description + `}]}`
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": content}}}})
			}))
			defer provider.Close()
			result, err := NewAnalyzer().Analyze(context.Background(), AgentConfig{BaseURL: provider.URL + "/v1", APIKey: "key", Model: "model"}, []Request{{ID: "req-1"}})
			if err == nil || !strings.Contains(err.Error(), "empty description") || len(result.Suggestions) != 0 {
				t.Fatalf("missing purpose was accepted or replaced by a fallback: suggestions=%d error=%v", len(result.Suggestions), err)
			}
		})
	}
}

func TestAgentFailureIsExplicitAndNeverFallsBack(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"visible-secret not accepted"}`, 401)
	}))
	defer provider.Close()
	result, err := NewAnalyzer().Analyze(context.Background(), AgentConfig{BaseURL: provider.URL + "/v1", APIKey: "visible-secret", Model: "m"}, []Request{{ID: "req-1"}})
	if err == nil || !strings.Contains(err.Error(), "401") || strings.Contains(err.Error(), "visible-secret") || len(result.Suggestions) != 0 {
		t.Fatalf("provider failure obscured or secret echoed: %+v %v", result, err)
	}
	for _, config := range []AgentConfig{{}, {BaseURL: provider.URL + "/v10", APIKey: "k", Model: "m"}} {
		if _, err := NewAnalyzer().Analyze(context.Background(), config, []Request{{ID: "r"}}); err == nil {
			t.Fatal("invalid config accepted")
		}
	}
}

func TestAgentDoesNotFollowRedirect(t *testing.T) {
	targetCalls := 0
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { targetCalls++; w.WriteHeader(200) }))
	defer target.Close()
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+"/v1/chat/completions", 307)
	}))
	defer provider.Close()
	_, err := NewAnalyzer().Analyze(context.Background(), AgentConfig{BaseURL: provider.URL + "/v1", APIKey: "key", Model: "m"}, []Request{{ID: "req-1"}})
	if err == nil || targetCalls != 0 {
		t.Fatal("provider redirect was followed")
	}
}

func TestAnalyzerProviderTimeoutDoesNotChangeRunnerLimits(t *testing.T) {
	for _, timeout := range []time.Duration{0, 180 * time.Second, 250 * time.Millisecond} {
		analyzer := NewAnalyzerWithTimeout(timeout)
		expected := timeout
		if expected <= 0 {
			expected = 180 * time.Second
		}
		transport, ok := analyzer.Client.Transport.(*http.Transport)
		if !ok || transport.ResponseHeaderTimeout != expected || analyzer.Client.Timeout != expected || analyzer.Timeout != expected {
			t.Fatal("provider header and total timeouts do not match configured window")
		}
	}
	runner := NewRunner()
	transport := runner.Client.Transport.(*http.Transport)
	if runner.Client.Timeout != 25*time.Second || transport.ResponseHeaderTimeout != 20*time.Second {
		t.Fatal("model timeout change affected replay limits")
	}
}

func TestAgentSlowProviderTimeoutIsUsefulAndSanitized(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		select {
		case <-r.Context().Done():
		case <-time.After(time.Second):
		}
	}))
	defer provider.Close()
	analyzer := NewAnalyzerWithTimeout(40 * time.Millisecond)
	_, err := analyzer.Analyze(context.Background(), AgentConfig{BaseURL: provider.URL + "/secret-endpoint/v1", APIKey: "private-api-key", Model: "m"}, []Request{{ID: "req-1"}})
	if err == nil || !strings.Contains(err.Error(), "模型服务响应超时") || !strings.Contains(err.Error(), "40ms") {
		t.Fatalf("timeout was not explained: %v", err)
	}
	for _, secret := range []string{provider.URL, "secret-endpoint", "private-api-key"} {
		if strings.Contains(err.Error(), secret) {
			t.Fatal("timeout message leaked provider configuration")
		}
	}
}

func TestAgentCancellationIsExplicit(t *testing.T) {
	analyzer := NewAnalyzerWithTimeout(time.Second)
	analyzer.Client.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) { return nil, context.Canceled })
	_, err := analyzer.Analyze(context.Background(), AgentConfig{BaseURL: "https://8.8.8.8/v1", APIKey: "key", Model: "m"}, []Request{{ID: "req-1"}})
	if err == nil || err.Error() != "模型分析已取消。" {
		t.Fatalf("cancellation was not explicit: %v", err)
	}
}
