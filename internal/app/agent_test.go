package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAgentUsesConfiguredCompatibleProviderAndValidatesDependencies(t *testing.T) {
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
		content := `{"summary":"两个相关请求","suggestions":[{"requestId":"req-2","label":"读取结果","description":"依赖先前响应中的 id","category":"api","dependencies":["req-1"],"confidence":"high","variables":[{"name":"id","source":"req-1.body.id","description":"结果编号"}]}],"warnings":[]}`
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": content}}}})
	}))
	defer provider.Close()
	result, err := NewAnalyzer().Analyze(context.Background(), AgentConfig{BaseURL: provider.URL + "/v1/", APIKey: "visible-key", Model: "my-model"}, []Request{{ID: "req-1"}, {ID: "req-2"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Suggestions) != 1 || result.Suggestions[0].Dependencies[0] != "req-1" || len(result.Warnings) != 1 {
		t.Fatalf("wrong analysis: %+v", result)
	}
}

func TestAgentRejectsInvalidUntrustedOutput(t *testing.T) {
	cases := []string{
		`not-json`,
		`{"summary":"x","suggestions":[{"requestId":"invented","label":"x"}]}`,
		`{"summary":"x","suggestions":[{"requestId":"req-1","label":"x","dependencies":["invented"]}]}`,
		`{"summary":"x","suggestions":[{"requestId":"req-1","label":"x","dependencies":["req-1"]}]}`,
		`{"summary":"x","suggestions":[{"requestId":"req-1","label":"x"},{"requestId":"req-1","label":"y"}]}`,
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
