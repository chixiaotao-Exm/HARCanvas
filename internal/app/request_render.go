package app

import (
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"strings"
)

// JSON string substitutions are rendered as values and marshalled afterwards.
// This preserves the original value types and escapes quotes/control characters.
func renderRequestBody(body string, variables, results map[string]any) (string, error) {
	if !strings.Contains(body, "{{") {
		return renderTemplate(body, variables, results)
	}
	decoder := json.NewDecoder(strings.NewReader(body))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return renderTemplate(body, variables, results)
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		return renderTemplate(body, variables, results)
	}
	var render func(any) (any, error)
	used := 0
	render = func(value any) (any, error) {
		switch current := value.(type) {
		case string:
			text, err := renderTemplate(current, variables, results)
			if err != nil {
				return nil, err
			}
			if len(text) > maxStepResponse-used {
				return nil, fmt.Errorf("rendered JSON body exceeds 2 MiB")
			}
			used += len(text)
			return text, nil
		case []any:
			for i, item := range current {
				next, err := render(item)
				if err != nil {
					return nil, err
				}
				current[i] = next
			}
		case map[string]any:
			for key, item := range current {
				next, err := render(item)
				if err != nil {
					return nil, err
				}
				current[key] = next
			}
		}
		return value, nil
	}
	value, err := render(value)
	if err != nil {
		return "", err
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	if len(encoded) > 2<<20 {
		return "", fmt.Errorf("request body exceeds 2 MiB")
	}
	return string(encoded), nil
}

// Query placeholders are decoded first, substituted as individual values, and
// encoded once. A value containing '&', '+', or '=' stays inside its parameter.
// URLs without query placeholders retain their original bytes and ordering.
func renderRequestURL(address string, variables, results map[string]any) (string, error) {
	base, query, hasQuery := strings.Cut(address, "?")
	if !hasQuery {
		return renderTemplate(address, variables, results)
	}
	query, fragment, hasFragment := strings.Cut(query, "#")
	if !strings.Contains(query, "{{") && !strings.Contains(strings.ToLower(query), "%7b%7b") {
		return renderTemplate(address, variables, results)
	}
	values, err := url.ParseQuery(query)
	if err != nil {
		return "", fmt.Errorf("invalid URL query: %w", err)
	}
	used := 0
	for key, items := range values {
		for i, item := range items {
			items[i], err = renderTemplate(item, variables, results)
			if err != nil {
				return "", err
			}
			if len(items[i]) > maxStepResponse-used {
				return "", fmt.Errorf("rendered URL query exceeds 2 MiB")
			}
			used += len(items[i])
		}
		values[key] = items
	}
	base, err = renderTemplate(base, variables, results)
	if err != nil {
		return "", err
	}
	rendered := base + "?" + values.Encode()
	if hasFragment {
		fragment, err = renderTemplate(fragment, variables, results)
		if err != nil {
			return "", err
		}
		rendered += "#" + fragment
	}
	if len(rendered) > 2<<20 {
		return "", fmt.Errorf("rendered URL exceeds 2 MiB")
	}
	return rendered, nil
}
