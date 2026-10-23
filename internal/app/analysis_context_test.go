package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAnalysisContextSupportsKnownCrossBatchDependencies(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload struct {
			Messages []struct {
				Content string `json:"content"`
			} `json:"messages"`
		}
		_ = json.NewDecoder(r.Body).Decode(&payload)
		if len(payload.Messages) != 2 || !strings.Contains(payload.Messages[1].Content, "global context") || !strings.Contains(payload.Messages[1].Content, "查询订单") {
			t.Error("global context not forwarded")
		}
		content := `{"summary":"查询结果","suggestions":[{"requestId":"req-2","label":"查询订单状态","description":"使用上一步提供的订单编号读取状态；来源字段在抓包中相同，未验证重放。","dependencies":["req-1"],"group":"查询订单","inputs":["订单编号"],"outputs":["状态"],"evidence":["body.orderId"],"readiness":"missing-input"}],"warnings":[]}`
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": content}}}})
	}))
	defer provider.Close()
	ctx := AnalysisContext{Goal: "查询订单", Catalog: []RequestCatalog{{ID: "req-1"}, {ID: "req-2"}}, Previous: []PreviousSuggestion{{RequestID: "req-1", Label: "提交订单"}}}
	result, err := NewAnalyzer().AnalyzeWithContext(context.Background(), AgentConfig{BaseURL: provider.URL + "/v1", APIKey: "test", Model: "test"}, []Request{{ID: "req-2"}}, ctx)
	if err != nil || len(result.Suggestions) != 1 || result.Suggestions[0].Dependencies[0] != "req-1" || result.Suggestions[0].Group != "查询订单" {
		t.Fatalf("cross-batch context failure: %v", err)
	}
}
func TestAnalysisContextCannotAuthorizeSuggestionsOutsideCurrentBatch(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": `{"summary":"x","suggestions":[{"requestId":"req-1","label":"x","description":"x"}]}`}}}})
	}))
	defer provider.Close()
	_, err := NewAnalyzer().AnalyzeWithContext(context.Background(), AgentConfig{BaseURL: provider.URL + "/v1", APIKey: "test", Model: "test"}, []Request{{ID: "req-2"}}, AnalysisContext{Catalog: []RequestCatalog{{ID: "req-1"}}})
	if err == nil {
		t.Fatal("context was allowed to invent current batch results")
	}
}
