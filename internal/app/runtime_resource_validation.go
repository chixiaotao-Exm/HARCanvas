package app

import "encoding/json"

func inspectEffectiveResources(flow Flow) []FlowIssue {
	rr := newRunResources(nil, flow)
	issues := []FlowIssue{}
	browserContexts := map[string]string{}
	add := func(code, node, field, message, action string) {
		issues = append(issues, FlowIssue{code, node, field, message, action})
	}
	var visit func(Flow, ResourceDefaults, string)
	visit = func(part Flow, defaults ResourceDefaults, scope string) {
		g, _ := inspectExecutableFlow(executableFlow(part))
		for _, node := range part.Nodes {
			if !g.reachable[node.ID] {
				continue
			}
			if node.Data.Kind == "loop" || node.Data.Kind == "subflow" {
				inherited := defaults
				if node.Data.SessionID != "" {
					inherited.SessionID = node.Data.SessionID
				}
				if node.Data.ProxyID != "" {
					inherited.ProxyID = node.Data.ProxyID
				}
				if node.Data.ProfileID != "" {
					inherited.ProfileID = node.Data.ProfileID
				}
				for _, b := range rr.bindings {
					if b.TargetID != node.ID {
						continue
					}
					switch rr.nodes[b.ResourceID].Data.Kind {
					case "proxy":
						if node.Data.ProxyID == "" {
							inherited.ProxyID = b.ResourceID
						}
					case "profile":
						if node.Data.ProfileID == "" {
							inherited.ProfileID = b.ResourceID
						}
					case "browserSession":
						if node.Data.SessionID == "" {
							inherited.SessionID = b.ResourceID
						}
					}
				}
				loop := node.Data.Loop
				nextScope := scope
				if loop.FreshSession {
					nextScope += "/" + node.ID
				}
				visit(Flow{Nodes: loop.Nodes, Edges: loop.Edges, EntryID: loop.EntryID, Inputs: part.Inputs}, inherited, nextScope)
				continue
			}
			if node.Data.Kind != "request" && node.Data.Kind != "browser" && node.Data.Kind != "browserVerification" {
				continue
			}
			e, err := rr.config(node, defaults, scope)
			if err != nil {
				add("resource_missing", node.ID, "sessionId", err.Error(), "重新选择有效资源。")
				continue
			}
			if e.SessionPersistent && e.Proxy != nil && e.Proxy.Rotation != "" && e.Proxy.Rotation != "fixed" {
				add("persistent_proxy_rotation", node.ID, "proxyId", "跨次保存的会话需要固定代理身份。", "选择固定代理，或关闭保存会话。")
			}
			if e.Proxy != nil && e.Proxy.Rotation == "request" && rr.nodes[e.SessionID].Data.Kind == "browserSession" {
				add("session_proxy_conflict", node.ID, "proxyId", "固定会话不能使用每请求轮换代理。", "改用每次运行轮换，或为该步骤建立独立会话。")
			}
			if node.Data.Kind == "request" {
				continue
			}
			if e.Proxy != nil && (e.Proxy.Rotation == "request" || e.Proxy.Rotation == "minutes") {
				add("browser_proxy_rotation", node.ID, "proxyId", "同一浏览器会话的代理需要保持固定。", "选择固定或每次运行轮换；需要新出口时创建新会话。")
			}
			config, _ := json.Marshal(struct {
				Proxy   *ProxyConfig
				Profile *BrowserProfileConfig
			}{e.Proxy, e.Profile})
			key := e.ExecutionSessionID
			if previous, ok := browserContexts[key]; ok && previous != string(config) {
				add("browser_session_conflict", node.ID, "sessionId", "同一个浏览器会话使用了不同代理或画像。", "统一设置，或为不同环境选择独立会话。")
			}
			browserContexts[key] = string(config)
		}
	}
	visit(flow, ResourceDefaults{}, "")
	return issues
}
