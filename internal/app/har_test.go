package app

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestParseHARPreservesDataAndClassifies(t *testing.T) {
	raw := json.RawMessage(`{"log":{"entries":[{"time":25.4,"_resourceType":"xhr","request":{"method":"POST","url":"https://api.example.com/items?tag=a&tag=b","headers":[{"name":"Cookie","value":"sid=visible"},{"name":"cookie","value":"other=keep"},{"name":"Authorization","value":"Bearer secret"}],"postData":{"mimeType":"application/json","text":"{\"hello\":\"world\"}"}},"response":{"status":201,"headers":[{"name":"Set-Cookie","value":"a=1"},{"name":"set-cookie","value":"b=2"}],"content":{"mimeType":"application/json","text":"eyJpZCI6NDJ9","encoding":"base64"}}},{"request":{"method":"GET","url":"https://cdn.example.com/logo.png","cookies":[{"name":"captured","value":"unchanged"}]},"response":{"status":200,"content":{"mimeType":"image/png"}}}]}}`)
	result, err := ParseHAR(raw)
	if err != nil {
		t.Fatal(err)
	}
	if result.Summary.Total != 2 || result.Summary.API != 1 || result.Summary.Static != 1 {
		t.Fatalf("wrong summary: %+v", result.Summary)
	}
	r := result.Requests[0]
	if r.ID != "req-1" || r.Method != "POST" || r.Duration != 25.4 || r.ResponseBody != `{"id":42}` {
		t.Fatalf("wrong request: %+v", r)
	}
	if headerValue(r.Headers, "Cookie") != "sid=visible; other=keep" || headerValue(r.Headers, "Authorization") != "Bearer secret" {
		t.Fatal("capture credentials were changed")
	}
	if headerValue(r.ResponseHeaders, "Set-Cookie") != "a=1\nb=2" || r.Query["tag"] != "a, b" {
		t.Fatal("repeated values were lost")
	}
	if headerValue(result.Requests[1].Headers, "Cookie") != "captured=unchanged" {
		t.Fatal("HAR cookies were not preserved")
	}
}

func TestParseHARValidationAndStableIDs(t *testing.T) {
	for _, raw := range []string{`{}`, `{"log":{}}`, `{"log":{"entries":{}}}`, `not-json`} {
		if _, err := ParseHAR(json.RawMessage(raw)); err == nil {
			t.Errorf("expected error for %s", raw)
		}
	}
	result, err := ParseHAR(json.RawMessage(`{"log":{"entries":[{"request":{"url":"data:image/png,abc"}},{"request":{"method":"GET","url":"https://example.com"},"response":{"content":{"encoding":"base64","text":"!!"}}}]}}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Requests) != 1 || result.Requests[0].ID != "req-2" || len(result.Warnings) != 2 {
		t.Fatalf("stable IDs or warning mismatch: %+v", result)
	}
}

func TestHARQueryNamesRemainCaseSensitive(t *testing.T) {
	result, err := ParseHAR(json.RawMessage(`{"log":{"entries":[{"request":{"method":"GET","url":"https://example.com?name=a&Name=b","queryString":[{"name":"name","value":"a"},{"name":"Name","value":"b"}]},"response":{}}]}}`))
	if err != nil || result.Requests[0].Query["name"] != "a" || result.Requests[0].Query["Name"] != "b" {
		t.Fatalf("query names corrupted: %+v %v", result, err)
	}
}

func TestParseHARAcceptsLargeCaptureAndWarnsMultipart(t *testing.T) {
	entry := `{"request":{"method":"POST","url":"https://example.com/upload","postData":{"mimeType":"multipart/form-data","params":[{"name":"file","value":"missing binary"}]}},"response":{}}`
	entries := make([]string, 1001)
	for i := range entries {
		entries[i] = entry
	}
	result, err := ParseHAR(json.RawMessage(`{"log":{"entries":[` + strings.Join(entries, ",") + `]}}`))
	if err != nil {
		t.Fatal(err)
	}
	if result.Summary.Total != 1001 || len(result.Warnings) != 1001 || result.Requests[0].Body != "" {
		t.Fatal("large captures or unreconstructable multipart handling failed")
	}
}
