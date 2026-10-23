package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAnalysisReturnsVerifiedInlineInputsWithoutCapturedDisplayValues(t *testing.T) {
	const recorded = "recorded-private@example.test"
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload struct {
			Messages []struct{ Role, Content string } `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
		}
		if len(payload.Messages) != 2 || !strings.Contains(payload.Messages[0].Content, "inputFields") || !strings.Contains(payload.Messages[0].Content, "不得因为步骤名") {
			t.Error("provider did not receive the evidence-based inline input contract")
		}
		content := `{"summary":"测试资料提交","suggestions":[{"requestId":"req-1","label":"填写资料","description":"请求正文包含邮箱字符串，需用户填写新值。","readiness":"missing-input","inputFields":[{"name":"` + recorded + `","target":"body","path":"user.email","placeholder":"` + recorded + `","required":false},{"name":"验证码","target":"body","path":"user.otp"}]}],"warnings":[]}`
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": content}}}})
	}))
	defer provider.Close()
	result, err := NewAnalyzer().Analyze(context.Background(), AgentConfig{BaseURL: provider.URL + "/v1", APIKey: "synthetic-key", Model: "synthetic-model"}, []Request{{ID: "req-1", Body: `{"user":{"email":"` + recorded + `","otp":"synthetic-code"}}`, Headers: map[string]string{"Content-Type": "application/json"}}})
	if err != nil || len(result.Suggestions) != 1 {
		t.Fatalf("inline field analysis failed: %v", err)
	}
	suggestion := result.Suggestions[0]
	if len(suggestion.InputFields) != 1 || suggestion.InputFields[0].Name != "邮箱" || suggestion.InputFields[0].Placeholder != "请输入邮箱" || suggestion.InputFields[0].Required == nil || *suggestion.InputFields[0].Required || suggestion.Readiness != "missing-input" {
		t.Fatal("analysis did not retain the verified field, optional flag and readiness")
	}
	display, _ := json.Marshal(suggestion.InputFields)
	if strings.Contains(string(display), recorded) || len(result.Warnings) != 1 {
		t.Fatal("input display repeated a recorded value or invalid field was not explained")
	}
}

func TestVerifiedSuggestionInputsRequireActualWritableUserData(t *testing.T) {
	request := Request{URL: "https://synthetic.invalid/profile?login_hint=synthetic%40example.test&state=oauth-state&email=first&email=second", Query: map[string]string{"login_hint": "synthetic@example.test", "state": "oauth-state", "email": "first"}, Headers: map[string]string{"content-type": "application/problem+json; charset=utf-8"}, Body: `{"name":"","state":"oauth-state","address":{"state":""},"billing_address":{"state":""},"event":{"name":""},"eventdata":{"name":""},"user":{"email":"","password":"","name":"","phone":123,"address":null,"active":true,"profile":{"email":""},"action":{"name":""}},"users":[{"email":""}],"csrf":{"email":""},"token":{"name":""},"verification":{"email":""},"signature":"","captcha":""}`}
	cases := []struct {
		name   string
		target string
		path   string
		valid  bool
	}{
		{"nested email", "body", "user.email", true},
		{"password", "body", "user.password", true},
		{"name", "body", "user.name", true},
		{"explicit top-level name", "body", "name", true},
		{"address state", "body", "address.state", true},
		{"billing address state", "body", "billing_address.state", true},
		{"bare body OAuth state", "body", "state", false},
		{"event name", "body", "event.name", false},
		{"eventdata name", "body", "eventdata.name", false},
		{"user event name", "body", "user.action.name", false},
		{"array leaf", "body", "users.0.email", true},
		{"query login hint", "query", "login_hint", true},
		{"missing field", "body", "user.username", false},
		{"invented email query", "query", "new_email", false},
		{"duplicate query", "query", "email", false},
		{"oauth state", "query", "state", false},
		{"number", "body", "user.phone", false},
		{"null", "body", "user.address", false},
		{"boolean", "body", "user.active", false},
		{"object", "body", "user.profile", false},
		{"csrf parent", "body", "csrf.email", false},
		{"token parent", "body", "token.name", false},
		{"verification parent", "body", "verification.email", false},
		{"signature", "body", "signature", false},
		{"captcha", "body", "captcha", false},
		{"header", "header", "email", false},
		{"url", "url", "email", false},
		{"whole body", "body", "", false},
		{"prototype", "body", "__proto__.email", false},
		{"constructor", "body", "constructor.name", false},
		{"empty segment", "body", "user..email", false},
		{"bracket path", "body", "users[0].email", false},
		{"out of range", "body", "users.1.email", false},
		{"noncanonical array index", "body", "users.00.email", false},
		{"template path", "body", "{{user}}.email", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fields, invalid := verifiedSuggestionInputs([]SuggestionInputField{{Name: "arbitrary provider name", Target: tc.target, Path: tc.path}}, request)
			if (len(fields) == 1) != tc.valid || invalid == tc.valid {
				t.Fatalf("unexpected field decision: count=%d invalid=%t", len(fields), invalid)
			}
		})
	}
}

func TestVerifiedSuggestionInputsRejectFormBodiesAndMalformedQueries(t *testing.T) {
	cases := []Request{
		{Body: `email=synthetic%40example.test`, Headers: map[string]string{"Content-Type": "application/x-www-form-urlencoded"}},
		{Body: `{"email":""}`, Headers: map[string]string{"Content-Type": "multipart/form-data; boundary=test"}},
		{Body: `{"email":""}`, Headers: map[string]string{"Content-Type": "text/plain"}},
		{Body: `{"email":""}`, Headers: map[string]string{"Content-Type": "text/json"}},
		{Body: `{"email":""}`, Headers: map[string]string{"Content-Type": "application/json", "content-type": "application/json"}},
		{Body: `{"email":"","sequence":9007199254740993}`},
		{Body: `{"email":"","sequence":1e100}`},
		{Body: `{"email":`},
		{URL: "https://synthetic.invalid/?email=%zz", Query: map[string]string{"email": ""}},
		{URL: "https://synthetic.invalid/", Query: map[string]string{"email": ""}},
	}
	for i, request := range cases {
		target := "body"
		if request.Query != nil {
			target = "query"
		}
		fields, invalid := verifiedSuggestionInputs([]SuggestionInputField{{Target: target, Path: "email"}}, request)
		if len(fields) != 0 || !invalid {
			t.Fatalf("invalid location %d was accepted", i)
		}
	}
}

func TestVerifiedSuggestionInputsBoundDeduplicateAndKeepOldSchemaOptional(t *testing.T) {
	request := Request{Body: `{"email":"","password":""}`}
	fields, invalid := verifiedSuggestionInputs([]SuggestionInputField{{Target: "body", Path: "email"}, {Target: "body", Path: "email"}, {Target: "body", Path: "password"}}, request)
	if len(fields) != 2 || !invalid {
		t.Fatal("duplicate fields were not discarded")
	}
	fields, invalid = verifiedSuggestionInputs(make([]SuggestionInputField, 17), request)
	if len(fields) != 0 || !invalid {
		t.Fatal("input field count was not bounded")
	}
	fields, invalid = verifiedSuggestionInputs(nil, request)
	if fields != nil || invalid {
		t.Fatal("old analysis without inputFields changed")
	}
	encoded, err := json.Marshal(Suggestion{RequestID: "req-1"})
	if err != nil || strings.Contains(string(encoded), "inputFields") {
		t.Fatal("optional inputFields changed the legacy response shape")
	}
	fields, invalid = verifiedSuggestionInputs([]SuggestionInputField{}, request)
	encoded, err = json.Marshal(Suggestion{RequestID: "req-1", InputFields: fields})
	if err != nil || invalid || !strings.Contains(string(encoded), `"inputFields":[]`) {
		t.Fatal("explicit empty fields were omitted, potentially re-enabling legacy inference")
	}
	fields, invalid = verifiedSuggestionInputs([]SuggestionInputField{{Target: "body", Path: "csrf"}}, request)
	encoded, err = json.Marshal(Suggestion{RequestID: "req-1", InputFields: fields})
	if err != nil || !invalid || !strings.Contains(string(encoded), `"inputFields":[]`) {
		t.Fatal("rejected fields became absent, potentially re-enabling legacy inference")
	}
}
