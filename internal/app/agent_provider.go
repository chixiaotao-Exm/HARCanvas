package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"strings"
	"time"
)

// Detail and overview use the same guarded, non-streaming provider transport.
// Neither path adds model-specific generation parameters or follows redirects.
func (a *Analyzer) providerEndpoint(ctx context.Context, config AgentConfig, timeout time.Duration) (*url.URL, error) {
	base := strings.TrimRight(strings.TrimSpace(config.BaseURL), "/")
	if base == "" || strings.TrimSpace(config.APIKey) == "" || strings.TrimSpace(config.Model) == "" {
		return nil, newAnalysisError("invalid_config", "baseUrl, apiKey, and model are required")
	}
	if len(base) > 4096 || len(config.APIKey) > 16384 || len(config.Model) > 256 {
		return nil, newAnalysisError("invalid_config", "agent URL, key, or model field exceeds its size limit")
	}
	endpoint, err := url.Parse(base)
	if err != nil || endpoint == nil || !strings.HasSuffix(endpoint.Path, "/v1") || endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return nil, newAnalysisError("invalid_config", "agent baseUrl must be an HTTP(S) URL ending in /v1, without query or fragment")
	}
	endpoint.Path += "/chat/completions"
	if err := a.Guard.CheckURL(ctx, endpoint); err != nil {
		if sanitized := analysisContextError(ctx, err, timeout); sanitized != nil {
			return nil, sanitized
		}
		return nil, newAnalysisError("endpoint_unavailable", "模型服务地址不可用，请检查地址和网络访问权限。")
	}
	return endpoint, nil
}

func (a *Analyzer) providerCompletion(ctx context.Context, config AgentConfig, endpoint *url.URL, timeout time.Duration, reporter *analysisReporter, system, user string, contextBytes, responseLimit int) (string, error) {
	payload := map[string]any{"model": config.Model, "messages": []map[string]string{{"role": "system", "content": system}, {"role": "user", "content": user}}, "response_format": map[string]string{"type": "json_object"}}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return "", newAnalysisError("internal_error", "无法创建模型分析请求，请重试。")
	}
	reporter.report("preparing", func(progress *AnalysisProgress) {
		progress.PayloadBytes = len(encoded)
		progress.ContextBytes = contextBytes
	})
	ctx = httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{
		WroteRequest: func(info httptrace.WroteRequestInfo) {
			if info.Err == nil {
				reporter.report("waiting_model", nil)
			}
		},
		GotFirstResponseByte: func() { reporter.log("first_byte", "none") },
	})
	req, err := http.NewRequestWithContext(ctx, "POST", endpoint.String(), bytes.NewReader(encoded))
	if err != nil {
		return "", newAnalysisError("invalid_config", "无法创建模型服务请求，请检查模型配置。")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+config.APIKey)
	client := *a.Client
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return errors.New("provider redirects are not followed; configure the final /v1 base URL")
	}
	response, err := client.Do(req)
	if err != nil {
		if sanitized := analysisContextError(ctx, err, timeout); sanitized != nil {
			return "", sanitized
		}
		return "", newAnalysisError("provider_unavailable", "连接模型服务失败，请检查模型配置和网络状态。")
	}
	defer response.Body.Close()
	reporter.report("reading_response", nil)
	body, err := io.ReadAll(io.LimitReader(response.Body, int64(responseLimit)+1))
	if len(body) > 0 {
		reporter.report("reading_response", func(progress *AnalysisProgress) { progress.ResponseBytes = len(body) })
	}
	if err != nil {
		if sanitized := analysisContextError(ctx, err, timeout); sanitized != nil {
			return "", sanitized
		}
		return "", newAnalysisError("provider_response_failed", "读取模型服务响应失败，请稍后重试。")
	}
	if len(body) > responseLimit {
		return "", newAnalysisError("analysis_limit", "模型服务响应超过当前分析大小限制，请缩小分析范围。")
	}
	reporter.report("validating", func(progress *AnalysisProgress) { progress.ResponseBytes = len(body) })
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		// Provider errors can echo HAR values. Only expose the status code.
		return "", newAnalysisError("provider_http_error", fmt.Sprintf("模型服务返回 HTTP %d，请检查模型配置、额度或服务状态。", response.StatusCode))
	}
	var completion struct {
		Choices []struct {
			Message struct {
				Content json.RawMessage `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(body, &completion); err != nil || len(completion.Choices) == 0 {
		return "", newAnalysisError("provider_response_invalid", "provider did not return a chat completion with choices")
	}
	var content string
	if err := json.Unmarshal(completion.Choices[0].Message.Content, &content); err != nil {
		var parts []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if err := json.Unmarshal(completion.Choices[0].Message.Content, &parts); err != nil {
			return "", newAnalysisError("provider_response_invalid", "provider completion content must be text")
		}
		for _, part := range parts {
			if part.Type == "text" {
				content += part.Text
			}
		}
	}
	content = strings.TrimSpace(content)
	if strings.HasPrefix(content, "```") {
		lines := strings.Split(content, "\n")
		if len(lines) > 2 && strings.TrimSpace(lines[len(lines)-1]) == "```" {
			content = strings.Join(lines[1:len(lines)-1], "\n")
		}
	}
	return content, nil
}
