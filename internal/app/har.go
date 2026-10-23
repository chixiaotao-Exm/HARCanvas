package app

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"net/url"
	"path"
	"sort"
	"strings"
)

type harPair struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}
type harEntry struct {
	PageID          string  `json:"pageref"`
	StartedDateTime string  `json:"startedDateTime"`
	Time            float64 `json:"time"`
	ResourceType    string  `json:"_resourceType"`
	Request         struct {
		Method   string    `json:"method"`
		URL      string    `json:"url"`
		Headers  []harPair `json:"headers"`
		Cookies  []harPair `json:"cookies"`
		Query    []harPair `json:"queryString"`
		PostData struct {
			MimeType string    `json:"mimeType"`
			Text     string    `json:"text"`
			Params   []harPair `json:"params"`
		} `json:"postData"`
	} `json:"request"`
	Response struct {
		Status  int       `json:"status"`
		Headers []harPair `json:"headers"`
		Cookies []struct {
			Name     string `json:"name"`
			Value    string `json:"value"`
			Path     string `json:"path"`
			Domain   string `json:"domain"`
			HTTPOnly bool   `json:"httpOnly"`
			Secure   bool   `json:"secure"`
		} `json:"cookies"`
		Content struct {
			MimeType string `json:"mimeType"`
			Text     string `json:"text"`
			Encoding string `json:"encoding"`
		} `json:"content"`
	} `json:"response"`
}

func ParseHAR(raw json.RawMessage) (ParseResult, error) {
	result := ParseResult{Requests: []Request{}, Warnings: []string{}, Summary: HARSummary{Domains: []string{}}}
	var root struct {
		Log *struct {
			Pages   []HARPage  `json:"pages"`
			Entries []harEntry `json:"entries"`
		} `json:"log"`
	}
	if err := json.Unmarshal(raw, &root); err != nil {
		return result, fmt.Errorf("invalid HAR JSON: %w", err)
	}
	if root.Log == nil || root.Log.Entries == nil {
		return result, errors.New("HAR must contain log.entries array")
	}
	if len(root.Log.Entries) > 10000 {
		return result, errors.New("HAR contains over 10000 entries; split the capture before importing")
	}
	result.Pages = root.Log.Pages
	if result.Pages == nil {
		result.Pages = []HARPage{}
	}
	domains := map[string]bool{}
	for i, entry := range root.Log.Entries {
		if strings.TrimSpace(entry.Request.Method) == "" {
			result.Warnings = append(result.Warnings, fmt.Sprintf("req-%d: skipped record without HTTP method", i+1))
			continue
		}
		u, err := url.Parse(entry.Request.URL)
		if err != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") {
			result.Warnings = append(result.Warnings, fmt.Sprintf("req-%d: skipped invalid or non-HTTP URL", i+1))
			continue
		}
		headers, responseHeaders := pairsToMap(entry.Request.Headers), pairsToMap(entry.Response.Headers)
		if headerValue(headers, "Cookie") == "" && len(entry.Request.Cookies) > 0 {
			cookies := []string{}
			for _, cookie := range entry.Request.Cookies {
				cookies = append(cookies, cookie.Name+"="+cookie.Value)
			}
			headers["Cookie"] = strings.Join(cookies, "; ")
		}
		if headerValue(responseHeaders, "Set-Cookie") == "" && len(entry.Response.Cookies) > 0 {
			cookies := []string{}
			for _, cookie := range entry.Response.Cookies {
				c := &http.Cookie{Name: cookie.Name, Value: cookie.Value, Path: cookie.Path, Domain: cookie.Domain, HttpOnly: cookie.HTTPOnly, Secure: cookie.Secure}
				if value := c.String(); value != "" {
					cookies = append(cookies, value)
				}
			}
			responseHeaders["Set-Cookie"] = strings.Join(cookies, "\n")
		}
		body := entry.Request.PostData.Text
		if body == "" && len(entry.Request.PostData.Params) > 0 {
			if strings.HasPrefix(entry.Request.PostData.MimeType, "multipart/") {
				result.Warnings = append(result.Warnings, fmt.Sprintf("req-%d: multipart body has no original text; uploaded file bytes cannot be reconstructed from HAR parameters", i+1))
			} else {
				values := url.Values{}
				for _, param := range entry.Request.PostData.Params {
					values.Add(param.Name, param.Value)
				}
				body = values.Encode()
			}
		}
		if headerValue(headers, "Content-Type") == "" && entry.Request.PostData.MimeType != "" {
			headers["Content-Type"] = entry.Request.PostData.MimeType
		}
		responseBody := entry.Response.Content.Text
		if strings.EqualFold(entry.Response.Content.Encoding, "base64") {
			decoded, decodeErr := base64.StdEncoding.DecodeString(responseBody)
			if decodeErr != nil {
				result.Warnings = append(result.Warnings, fmt.Sprintf("req-%d: invalid base64 response content; original text retained", i+1))
			} else {
				responseBody = string(decoded)
			}
		}
		query := map[string]string{}
		for key, values := range u.Query() {
			query[key] = strings.Join(values, ", ")
		}
		harQuery := map[string][]string{}
		for _, pair := range entry.Request.Query {
			harQuery[pair.Name] = append(harQuery[pair.Name], pair.Value)
		}
		for key, values := range harQuery {
			query[key] = strings.Join(values, ", ")
		}
		category := classify(entry.ResourceType, entry.Response.Content.MimeType, u.Path, entry.Request.Method)
		r := Request{ID: fmt.Sprintf("req-%d", i+1), Method: strings.ToUpper(entry.Request.Method), URL: entry.Request.URL, Domain: u.Host, Path: u.Path, Category: category, MimeType: entry.Response.Content.MimeType, Status: entry.Response.Status, Duration: entry.Time, Headers: headers, Body: body, ResponseBody: responseBody, ResponseHeaders: responseHeaders, Query: query}
		r.PageID = entry.PageID
		r.StartedDateTime = entry.StartedDateTime
		r.StartedAt = entry.StartedDateTime
		result.Requests = append(result.Requests, r)
		domains[u.Host] = true
		if category == "api" {
			result.Summary.API++
		}
		if category == "static" {
			result.Summary.Static++
		}
	}
	result.Summary.Total = len(result.Requests)
	for domain := range domains {
		result.Summary.Domains = append(result.Summary.Domains, domain)
	}
	sort.Strings(result.Summary.Domains)
	if len(result.Requests) == 0 {
		result.Warnings = append(result.Warnings, "No HTTP requests were found in this HAR")
	}
	return result, nil
}

func pairsToMap(pairs []harPair) map[string]string {
	result := map[string]string{}
	for _, p := range pairs {
		key := p.Name
		for existing := range result {
			if strings.EqualFold(existing, key) {
				key = existing
				break
			}
		}
		if old, exists := result[key]; exists {
			sep := ", "
			if strings.EqualFold(key, "Set-Cookie") {
				sep = "\n"
			}
			if strings.EqualFold(key, "Cookie") {
				sep = "; "
			}
			result[key] = old + sep + p.Value
		} else {
			result[key] = p.Value
		}
	}
	return result
}
func headerValue(headers map[string]string, name string) string {
	for key, value := range headers {
		if strings.EqualFold(key, name) {
			return value
		}
	}
	return ""
}
func classify(resource, mimeType, urlPath, method string) string {
	resource, mimeType = strings.ToLower(resource), strings.ToLower(mimeType)
	if resource == "xhr" || resource == "fetch" || strings.Contains(mimeType, "json") || strings.Contains(mimeType, "graphql") {
		return "api"
	}
	if resource == "document" || strings.Contains(mimeType, "text/html") {
		return "document"
	}
	if resource == "stylesheet" || resource == "script" || resource == "image" || resource == "font" || resource == "media" || strings.HasPrefix(mimeType, "image/") || strings.HasPrefix(mimeType, "font/") || strings.HasPrefix(mimeType, "audio/") || strings.HasPrefix(mimeType, "video/") || strings.Contains(mimeType, "javascript") || strings.Contains(mimeType, "text/css") {
		return "static"
	}
	ext := strings.ToLower(path.Ext(urlPath))
	extType := mime.TypeByExtension(ext)
	if strings.HasPrefix(extType, "image/") || strings.Contains(extType, "javascript") || ext == ".css" || ext == ".woff" || ext == ".woff2" || ext == ".ttf" || ext == ".map" {
		return "static"
	}
	if method != "GET" && method != "HEAD" {
		return "api"
	}
	return "other"
}
