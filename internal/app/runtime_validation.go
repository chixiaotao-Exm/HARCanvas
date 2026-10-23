package app

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const maxLoopDepth = 4
const maxLoopCount = 1000
const maxExecutionSteps = 10000

func resourceKind(kind string) bool {
	return kind == "proxy" || kind == "profile" || kind == "browserSession"
}

func executableFlow(flow Flow) Flow {
	filtered := flow
	filtered.Nodes = nil
	for _, n := range flow.Nodes {
		if !resourceKind(n.Data.Kind) {
			filtered.Nodes = append(filtered.Nodes, n)
		}
	}
	return filtered
}

func inspectFlow(flow Flow) (*graph, FlowValidation) {
	resources := map[string]FlowNode{}
	all := map[string]FlowNode{}
	insideLoop := map[string]bool{}
	var issues []FlowIssue
	var collect func([]FlowNode, int, bool)
	collect = func(nodes []FlowNode, depth int, inLoop bool) {
		if depth > maxLoopDepth {
			return
		}
		for _, n := range nodes {
			if resourceKind(n.Data.Kind) && (!identifier.MatchString(n.ID) || n.Type != "block") {
				issues = append(issues, FlowIssue{"invalid_resource_node", n.ID, "id", "资源方块编号或类型无效。", "重新创建资源方块。"})
			}
			if _, exists := all[n.ID]; exists {
				issues = append(issues, FlowIssue{"duplicate_node_id", n.ID, "id", "子流程和主流程的方块编号必须唯一。", "重新创建重复方块。"})
			}
			all[n.ID] = n
			insideLoop[n.ID] = inLoop
			if resourceKind(n.Data.Kind) {
				resources[n.ID] = n
			}
			if n.Data.Loop != nil {
				collect(n.Data.Loop.Nodes, depth+1, inLoop || n.Data.Kind == "loop")
			}
		}
	}
	collect(flow.Nodes, 0, false)
	selected := map[string]bool{}
	var selectNodes func(Flow)
	selectNodes = func(part Flow) {
		g, _ := inspectExecutableFlow(executableFlow(part))
		for _, node := range part.Nodes {
			if resourceKind(node.Data.Kind) {
				continue
			}
			if g.entry != "" && !g.reachable[node.ID] {
				continue
			}
			selected[node.ID] = true
			if node.Data.Loop != nil {
				selectNodes(Flow{Nodes: node.Data.Loop.Nodes, Edges: node.Data.Loop.Edges, EntryID: node.Data.Loop.EntryID, Inputs: part.Inputs})
			}
		}
	}
	selectNodes(flow)
	used := map[string]bool{}
	mark := func(id string) {
		if id != "" {
			used[id] = true
		}
	}
	mark(flow.Defaults.SessionID)
	mark(flow.Defaults.ProxyID)
	mark(flow.Defaults.ProfileID)
	for id := range selected {
		d := all[id].Data
		mark(d.SessionID)
		mark(d.ProxyID)
		mark(d.ProfileID)
	}
	for changed := true; changed; {
		before := len(used)
		for _, binding := range flow.ResourceBindings {
			if selected[binding.TargetID] || used[binding.TargetID] {
				mark(binding.ResourceID)
			}
		}
		for id := range used {
			if session := resources[id].Data.Session; session != nil {
				mark(session.ProxyID)
				mark(session.ProfileID)
			}
		}
		changed = len(used) != before
	}
	if len(all) > 3000 {
		issues = append(issues, FlowIssue{"node_count", "", "nodes", "包含子流程的画布最多支持 3000 个方块。", "拆分项目或减少方块。"})
	}
	var inspect func(Flow, int, string, ResourceDefaults) (*graph, FlowValidation)
	inspect = func(part Flow, depth int, owner string, inherited ResourceDefaults) (*graph, FlowValidation) {
		if part.Defaults.SessionID == "" {
			part.Defaults.SessionID = inherited.SessionID
		}
		if part.Defaults.ProxyID == "" {
			part.Defaults.ProxyID = inherited.ProxyID
		}
		if part.Defaults.ProfileID == "" {
			part.Defaults.ProfileID = inherited.ProfileID
		}
		executable := executableFlow(part)
		g, v := inspectExecutableFlow(executable)
		add := func(code, node, field, message, action string) {
			v.Issues = append(v.Issues, FlowIssue{code, node, field, message, action})
		}
		checkRef := func(node, field, id, kind string) {
			if id == "" {
				return
			}
			resource, ok := resources[id]
			if !ok || resource.Data.Kind != kind {
				add("resource_missing", node, field, "引用的代理、画像或会话资源不存在。", "重新选择对应的资源方块。")
			}
		}
		checkDefaults := func(node string, d ResourceDefaults) {
			checkRef(node, "sessionId", d.SessionID, "browserSession")
			checkRef(node, "proxyId", d.ProxyID, "proxy")
			checkRef(node, "profileId", d.ProfileID, "profile")
		}
		checkDefaults(owner, part.Defaults)
		bound := map[string]bool{}
		for _, binding := range part.ResourceBindings {
			resource, ok := resources[binding.ResourceID]
			key := binding.TargetID + ":" + resource.Data.Kind
			if bound[key] {
				add("resource_binding_ambiguous", binding.TargetID, "resourceBindings", "同一步骤连接了多个相同类型的配置资源。", "每类资源只保留一个配置连接。")
			}
			bound[key] = true
			if !ok || all[binding.TargetID].ID == "" || resourceKind(all[binding.TargetID].Data.Kind) && all[binding.TargetID].Data.Kind != "browserSession" {
				add("resource_binding_invalid", binding.TargetID, "resourceBindings", "配置连接的来源或目标不存在，或类型不匹配。", "重新连接资源与步骤。")
			}
			if ok && resource.Data.Kind == "browserSession" && all[binding.TargetID].Data.Kind == "browserSession" {
				add("resource_binding_invalid", binding.TargetID, "resourceBindings", "会话不能作为另一个会话的配置资源。", "为会话连接代理或画像。")
			}
		}
		for _, node := range part.Nodes {
			d := node.Data
			if resourceKind(d.Kind) && len(selected) > 0 && !used[node.ID] {
				continue
			}
			if !resourceKind(d.Kind) && g.entry != "" && !g.reachable[node.ID] {
				continue
			}
			checkDefaults(node.ID, ResourceDefaults{d.SessionID, d.ProxyID, d.ProfileID})
			switch d.Kind {
			case "proxy":
				if d.Proxy == nil {
					add("proxy_required", node.ID, "proxy", "请粘贴代理地址。", "填写 socks5:// 或 http:// 代理链接。")
				} else if err := validateProxyConfig(*d.Proxy); err != nil {
					add("invalid_proxy", node.ID, "proxy", err.Error(), "检查代理地址和轮换设置。")
				}
			case "profile":
				if d.Profile == nil {
					add("profile_required", node.ID, "profile", "请配置环境画像。", "填写语言、时区与窗口尺寸。")
				} else if err := validateProfile(*d.Profile); err != nil {
					add("invalid_profile", node.ID, "profile", err.Error(), "修正环境画像。")
				}
			case "browserSession":
				if d.Session == nil {
					add("session_required", node.ID, "session", "请配置这个会话。", "选择代理和画像，或保留独立默认环境。")
				} else {
					checkRef(node.ID, "session.proxyId", d.Session.ProxyID, "proxy")
					checkRef(node.ID, "session.profileId", d.Session.ProfileID, "profile")
					if d.Session.Persist {
						if !identifier.MatchString(flow.ProjectID) {
							add("persistent_project_required", node.ID, "session.persist", "保存会话需要稳定的项目标识。", "导出并重新导入新版项目，或关闭保存会话。")
						}
					}
					proxy := resources[d.Session.ProxyID].Data.Proxy
					if proxy != nil && proxy.Rotation == "request" {
						add("session_proxy_conflict", node.ID, "session.proxyId", "固定会话不能使用每请求轮换代理。", "选择固定、每次运行或按分钟轮换代理。")
					}
				}
			case "loop", "subflow":
				if d.Loop == nil {
					add("loop_required", node.ID, "loop", "请先选择要重复的步骤。", "把步骤放入重复区域。")
					continue
				}
				if depth >= maxLoopDepth {
					add("loop_depth", node.ID, "loop", "重复区域最多嵌套 4 层。", "减少嵌套层数。")
					continue
				}
				loop := d.Loop
				if d.Kind == "loop" && loop.Mode != "" && loop.Mode != "count" && loop.Mode != "each" {
					add("loop_mode", node.ID, "loop.mode", "请选择重复次数或逐项处理。", "重新选择重复方式。")
				}
				if loop.Mode != "each" && (loop.Count < 0 || loop.Count > maxLoopCount) {
					add("loop_count", node.ID, "loop.count", "重复次数需要是 0 到 1000。", "填写允许范围内的次数。")
				}
				if loop.Mode == "each" && strings.TrimSpace(loop.Items) == "" {
					add("loop_items", node.ID, "loop.items", "请选择需要逐项处理的列表。", "选择上一步输出的列表。")
				}
				if loop.ItemVariable != "" && !variableName.MatchString(loop.ItemVariable) || loop.IndexVariable != "" && !variableName.MatchString(loop.IndexVariable) {
					add("invalid_variable", node.ID, "loop", "循环参数名称格式无效。", "使用字母或下划线开头的名称。")
				}
				inputs := map[string]string{}
				for k, v := range part.Inputs {
					inputs[k] = v
				}
				item, index := loopVariables(loop)
				if item == index {
					add("loop_variable_conflict", node.ID, "loop", "当前项和序号不能使用相同参数名。", "为当前项和序号使用不同名称。")
				}
				if loop.Mode == "each" {
					inputs[item] = ""
				}
				inputs[index] = ""
				// A nested scope can read only values produced before its enclosing node.
				var ancestors func(string, map[string]bool)
				ancestors = func(id string, seen map[string]bool) {
					if seen[id] {
						return
					}
					seen[id] = true
					for _, e := range g.incoming[id] {
						n := g.nodes[e.Source]
						inputs[n.ID] = ""
						if n.Data.Variable != "" {
							inputs[n.Data.Variable] = ""
						}
						ancestors(e.Source, seen)
					}
				}
				ancestors(node.ID, map[string]bool{})
				nestedDefaults := part.Defaults
				if d.SessionID != "" {
					nestedDefaults.SessionID = d.SessionID
				}
				if d.ProxyID != "" {
					nestedDefaults.ProxyID = d.ProxyID
				}
				if d.ProfileID != "" {
					nestedDefaults.ProfileID = d.ProfileID
				}
				_, child := inspect(Flow{Nodes: loop.Nodes, Edges: loop.Edges, EntryID: loop.EntryID, Inputs: inputs}, depth+1, node.ID, nestedDefaults)
				for _, issue := range child.Issues {
					issue.Message = fmt.Sprintf("「%s」内部：%s", d.Label, issue.Message)
					v.Issues = append(v.Issues, issue)
				}
			case "break":
				if !insideLoop[node.ID] {
					add("break_outside_loop", node.ID, "kind", "提前结束方块需要放在重复区域内。", "把这个方块移入重复区域。")
				}
			}
		}
		v.Valid = len(v.Issues) == 0
		return g, v
	}
	g, v := inspect(flow, 0, "", ResourceDefaults{})
	v.Issues = append(v.Issues, issues...)
	if len(v.Issues) == 0 {
		v.Issues = append(v.Issues, inspectEffectiveResources(flow)...)
	}
	v.Valid = len(v.Issues) == 0
	return g, v
}

func loopVariables(loop *LoopConfig) (string, string) {
	item, index := loop.ItemVariable, loop.IndexVariable
	if item == "" {
		item = "item"
	}
	if index == "" {
		index = "index"
	}
	return item, index
}

func validateProfile(p BrowserProfileConfig) error {
	if p.Browser != "" && p.Browser != "chromium" && p.Browser != "firefox" && p.Browser != "webkit" {
		return fmt.Errorf("浏览器类型无效。")
	}
	if len(p.Locale) > 64 || strings.ContainsAny(p.Locale, "\r\n") || len(p.UserAgent) > 2048 || strings.ContainsAny(p.UserAgent, "\r\n") {
		return fmt.Errorf("语言或 User-Agent 格式无效。")
	}
	if p.Timezone != "" {
		if _, err := time.LoadLocation(p.Timezone); err != nil {
			return fmt.Errorf("时区名称无效，例如 Asia/Shanghai。")
		}
	}
	if p.Viewport.Width != 0 && (p.Viewport.Width < 320 || p.Viewport.Width > 7680) || p.Viewport.Height != 0 && (p.Viewport.Height < 240 || p.Viewport.Height > 4320) {
		return fmt.Errorf("窗口尺寸超出支持范围。")
	}
	return nil
}

func validateProxyConfig(p ProxyConfig) error {
	if p.CredentialsMissing {
		return fmt.Errorf("这个项目没有包含代理凭据，请重新填写代理链接。")
	}
	if len(p.URL) > 4096 {
		return fmt.Errorf("代理地址过长。")
	}
	u, err := url.Parse(p.URL)
	if err != nil || u.Hostname() == "" || u.Port() == "" || u.Path != "" && u.Path != "/" || u.RawQuery != "" || u.Fragment != "" {
		return fmt.Errorf("代理地址需要包含协议、主机和端口。")
	}
	if u.Scheme != "socks5" && u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("目前支持 SOCKS5、HTTP 和 HTTPS CONNECT 代理。")
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port < 1 || port > 65535 {
		return fmt.Errorf("代理端口需要是 1 到 65535。")
	}
	switch p.Rotation {
	case "", "fixed", "run", "request", "minutes":
	default:
		return fmt.Errorf("代理轮换方式无效。")
	}
	if p.Rotation == "minutes" && (p.RotationMinutes < 1 || p.RotationMinutes > 1440) {
		return fmt.Errorf("轮换间隔需要是 1 到 1440 分钟。")
	}
	if p.Rotation != "" && p.Rotation != "fixed" {
		if p.SessionToken == "" || u.User == nil || strings.Count(u.User.Username(), p.SessionToken) != 1 {
			return fmt.Errorf("请在用户名中选择唯一的会话标识片段后启用轮换。")
		}
	}
	if u.User != nil {
		password, _ := u.User.Password()
		if len(u.User.Username()) > 255 || len(password) > 255 {
			return fmt.Errorf("代理用户名或密码超过 255 字节。")
		}
	}
	return nil
}

func parseLoopItems(text string, vars, results map[string]any) ([]any, error) {
	text = strings.TrimSpace(text)
	var value any
	if strings.HasPrefix(text, "[") {
		if err := json.Unmarshal([]byte(text), &value); err != nil {
			return nil, &executionError{"loop_items", "逐项处理的内容不是有效列表。"}
		}
	} else {
		ref := strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(text, "{{"), "}}"))
		var found bool
		value, found = resolveReference(ref, vars, results)
		if !found {
			return nil, &executionError{"loop_items", "上一步尚未产生所选列表。"}
		}
		if s, ok := value.(string); ok {
			if err := json.Unmarshal([]byte(s), &value); err != nil {
				return nil, &executionError{"loop_items", "参数内容不是有效列表。"}
			}
		}
	}
	items, ok := value.([]any)
	if !ok {
		return nil, &executionError{"loop_items", "所选字段不是列表，请选择数组字段。"}
	}
	if len(items) > maxLoopCount {
		return nil, &executionError{"loop_limit", "列表超过 1000 项，请分批处理。"}
	}
	return items, nil
}
