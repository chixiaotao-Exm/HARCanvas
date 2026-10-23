package app

import (
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
)

type FlowIssue struct {
	Code            string `json:"code"`
	NodeID          string `json:"nodeId"`
	Field           string `json:"field"`
	Message         string `json:"message"`
	SuggestedAction string `json:"suggestedAction"`
}

type FlowValidation struct {
	Valid            bool        `json:"valid"`
	EntryID          string      `json:"entryId,omitempty"`
	Issues           []FlowIssue `json:"issues"`
	EntryNodeIDs     []string    `json:"entryNodeIds"`
	ReachableNodeIDs []string    `json:"reachableNodeIds"`
}

type FlowValidationError struct{ Validation FlowValidation }

func (e *FlowValidationError) Error() string {
	if len(e.Validation.Issues) > 0 {
		return e.Validation.Issues[0].Message
	}
	return "流程预检未通过。"
}

func ValidateFlow(flow Flow) FlowValidation { _, validation := inspectFlow(flow); return validation }
func validateFlow(flow Flow) (*graph, error) {
	g, validation := inspectFlow(flow)
	if !validation.Valid {
		return nil, &FlowValidationError{Validation: validation}
	}
	return g, nil
}

func inspectFlow(flow Flow) (*graph, FlowValidation) {
	v := FlowValidation{Issues: []FlowIssue{}, EntryNodeIDs: []string{}, ReachableNodeIDs: []string{}}
	add := func(code, node, field, message, action string) {
		v.Issues = append(v.Issues, FlowIssue{code, node, field, message, action})
	}
	g := &graph{nodes: map[string]FlowNode{}, incoming: map[string][]FlowEdge{}, outgoing: map[string][]FlowEdge{}, order: []string{}, reachable: map[string]bool{}}
	if len(flow.Nodes) == 0 || len(flow.Nodes) > 3000 {
		add("node_count", "", "nodes", "画布需要包含 1 到 3000 个方块。", "添加一个入口方块，或将大画布拆分。")
	}
	if len(flow.Edges) > 5000 {
		add("edge_count", "", "edges", "画布连接超过 5000 条。", "删除多余连接，或将大画布拆分。")
	}
	if len(v.Issues) > 0 {
		return g, v
	}
	for _, node := range flow.Nodes {
		if !identifier.MatchString(node.ID) {
			add("invalid_node_id", node.ID, "id", "方块编号格式无效。", "重新添加这个方块。")
			continue
		}
		if _, exists := g.nodes[node.ID]; exists {
			add("duplicate_node_id", node.ID, "id", "两个方块使用了相同编号。", "删除重复方块后重新添加。")
			continue
		}
		g.nodes[node.ID] = node
		if node.Type != "block" {
			add("unsupported_node_type", node.ID, "type", "这个方块类型暂不支持执行。", "使用受支持的流程方块。")
		}
	}
	seen := map[string]bool{}
	for _, edge := range flow.Edges {
		if g.nodes[edge.Source].ID == "" || g.nodes[edge.Target].ID == "" {
			add("missing_edge_node", edge.Target, "edges", "连接引用的方块已删除。", "删除无效连接，重新连接现有方块。")
			continue
		}
		if edge.Source == edge.Target {
			add("cycle", edge.Source, "edges", "方块不能连接到自己。", "删除这条连接。")
			continue
		}
		key := edge.Source + "\x00" + edge.Target + "\x00" + edge.SourceHandle
		if seen[key] {
			add("duplicate_edge", edge.Target, "edges", "这条连接重复了。", "删除重复连接。")
			continue
		}
		seen[key] = true
		if g.nodes[edge.Source].Data.Kind == "condition" {
			if edge.SourceHandle != "true" && edge.SourceHandle != "false" {
				add("invalid_branch", edge.Source, "sourceHandle", "条件方块的连接需要选择“是”或“否”。", "从对应的分支端口重新连接。")
			}
		} else if edge.SourceHandle != "" {
			add("invalid_branch", edge.Source, "sourceHandle", "只有条件方块可以使用分支端口。", "使用普通输出端口重新连接。")
		}
		g.incoming[edge.Target] = append(g.incoming[edge.Target], edge)
		g.outgoing[edge.Source] = append(g.outgoing[edge.Source], edge)
	}
	degrees := map[string]int{}
	ready := []string{}
	for _, node := range flow.Nodes {
		if g.nodes[node.ID].ID == "" {
			continue
		}
		if _, ok := degrees[node.ID]; ok {
			continue
		}
		degrees[node.ID] = len(g.incoming[node.ID])
		if degrees[node.ID] == 0 {
			ready = append(ready, node.ID)
			v.EntryNodeIDs = append(v.EntryNodeIDs, node.ID)
		}
	}
	for len(ready) > 0 {
		id := ready[0]
		ready = ready[1:]
		g.order = append(g.order, id)
		for _, edge := range g.outgoing[id] {
			degrees[edge.Target]--
			if degrees[edge.Target] == 0 {
				ready = append(ready, edge.Target)
			}
		}
	}
	if len(g.order) != len(g.nodes) {
		add("cycle", "", "edges", "流程中存在循环连接。", "删除形成循环的连接，使用有明确先后顺序的流程。")
	}
	entry := strings.TrimSpace(flow.EntryID)
	alias := strings.TrimSpace(flow.EntryNodeID)
	if entry != "" && alias != "" && entry != alias {
		add("conflicting_entry", "", "entryId", "流程选择了两个不同入口。", "只保留一个执行入口。")
	}
	if entry == "" {
		entry = alias
	}
	if entry == "" {
		if len(v.EntryNodeIDs) == 1 {
			entry = v.EntryNodeIDs[0]
		} else if len(v.EntryNodeIDs) > 1 {
			add("entry_required", "", "entryId", "画布有多个独立入口，请选择本次运行的入口。", "在运行设置中选择一个入口方块。")
		}
	}
	if entry != "" {
		if g.nodes[entry].ID == "" {
			add("entry_missing", entry, "entryId", "选择的入口方块已删除。", "重新选择执行入口。")
		} else if len(g.incoming[entry]) > 0 {
			add("entry_not_root", entry, "entryId", "入口方块前面还有连接。", "选择没有前置连接的入口方块。")
		} else {
			g.entry = entry
			var visit func(string)
			visit = func(id string) {
				if g.reachable[id] {
					return
				}
				g.reachable[id] = true
				for _, e := range g.outgoing[id] {
					visit(e.Target)
				}
			}
			visit(entry)
		}
	}
	for _, id := range g.order {
		if g.reachable[id] {
			v.ReachableNodeIDs = append(v.ReachableNodeIDs, id)
		}
	}
	v.EntryID = g.entry
	if len(v.ReachableNodeIDs) > 100 {
		add("run_node_count", g.entry, "entryId", "本次入口可达的方块超过 100 个。", "拆分流程，每次选择不超过 100 个方块的独立入口。")
	}
	reachableEdges := 0
	for _, edge := range flow.Edges {
		if g.reachable[edge.Source] && g.reachable[edge.Target] {
			reachableEdges++
		}
	}
	if reachableEdges > 300 {
		add("run_edge_count", g.entry, "edges", "本次入口可达的连接超过 300 条。", "删除多余连接，或拆分为多个独立入口。")
	}
	// Structural issues apply to the whole canvas. Configuration issues apply only
	// to the chosen flow, so an unrelated draft does not block its execution.
	checkNode := func(id string) bool { return entry == "" || g.reachable[id] }
	producers := map[string][]string{}
	for _, node := range flow.Nodes {
		switch node.Data.Kind {
		case "input", "manual", "extract":
			producers[node.Data.Variable] = append(producers[node.Data.Variable], node.ID)
		}
	}
	ancestors := func(nodeID, sourceID string) bool {
		seen := map[string]bool{}
		var visit func(string) bool
		visit = func(id string) bool {
			if seen[id] {
				return false
			}
			seen[id] = true
			for _, e := range g.incoming[id] {
				if e.Source == sourceID || visit(e.Source) {
					return true
				}
			}
			return false
		}
		return visit(nodeID)
	}
	checkRef := func(nodeID, field, reference string) {
		reference = strings.TrimSpace(reference)
		name, _, _ := strings.Cut(reference, ".")
		if _, ok := flow.Inputs[reference]; ok {
			return
		}
		if _, ok := flow.Inputs[name]; ok {
			return
		}
		if sources := producers[name]; len(sources) > 0 {
			for _, source := range sources {
				if ancestors(nodeID, source) && (!g.reachable[g.entry] || g.reachable[source]) {
					return
				}
			}
		}
		if source, ok := g.nodes[name]; ok {
			if source.ID != nodeID && ancestors(nodeID, name) && (!g.reachable[g.entry] || g.reachable[name]) {
				return
			}
			add("reference_not_upstream", nodeID, field, "引用的步骤没有连接到当前方块之前。", "连接来源步骤，或重新选择参数来源。")
			return
		}
		if len(producers[name]) > 0 {
			add("variable_not_upstream", nodeID, field, "这个参数的来源还没有连接到当前方块之前。", "先连接产生参数的步骤。")
			return
		}
		add("missing_variable", nodeID, field, fmt.Sprintf("参数“%s”尚未提供。", reference), "填写参数，或选择上一步的输出。")
	}
	checkTemplate := func(nodeID, field, template string) {
		if len(template) > 2<<20 {
			add("template_too_large", nodeID, field, "这个字段超过 2 MiB。", "缩小字段内容。")
			return
		}
		remaining := template
		for {
			match := templateReference.FindStringSubmatchIndex(remaining)
			if match == nil {
				if strings.Contains(remaining, "{{") {
					add("invalid_template", nodeID, field, "参数表达式没有完整闭合。", "使用 {{参数名}} 或从参数向导重新选择。")
				}
				break
			}
			if strings.Contains(remaining[:match[0]], "{{") {
				add("invalid_template", nodeID, field, "参数表达式格式无效。", "从参数向导重新选择参数。")
			}
			checkRef(nodeID, field, remaining[match[2]:match[3]])
			remaining = remaining[match[1]:]
		}
	}
	for _, node := range flow.Nodes {
		if !checkNode(node.ID) {
			continue
		}
		d := node.Data
		switch d.Kind {
		case "input", "manual", "extract":
			if !variableName.MatchString(d.Variable) {
				add("invalid_variable", node.ID, "variable", "请为参数填写有效名称。", "使用字母或下划线开头的名称，只包含字母、数字、下划线和短横线。")
			}
			if d.Kind == "input" {
				if _, provided := flow.Inputs[d.Variable]; !provided {
					checkTemplate(node.ID, "value", d.Value)
				}
			}
			if d.Kind == "extract" {
				if d.Source == "" {
					add("source_required", node.ID, "source", "这个提取方块还没有选择数据来源。", "选择一个上游步骤作为数据来源。")
				} else if g.nodes[d.Source].ID == "" {
					add("source_deleted", node.ID, "source", "原来的来源步骤已删除，请重新选择。", "选择现有的上游步骤。")
				} else if !ancestors(node.ID, d.Source) || (entry != "" && !g.reachable[d.Source]) {
					add("source_not_upstream", node.ID, "source", "请把来源步骤连接到这个提取方块之前。", "将来源步骤连接到当前流程中的提取方块之前。")
				}
				if strings.TrimSpace(d.Path) == "" {
					add("path_required", node.ID, "path", "请选择要从响应中读取的字段。", "使用响应字段选择器选择字段。")
				}
			}
		case "request":
			if strings.TrimSpace(d.URL) == "" {
				add("url_required", node.ID, "url", "这个请求还没有填写地址。", "填写 HTTP 或 HTTPS 地址。")
			} else {
				checkTemplate(node.ID, "url", d.URL)
				if strings.Contains(strings.ToLower(d.URL), "%7b%7b") {
					_, rawQuery, found := strings.Cut(d.URL, "?")
					if found {
						rawQuery, _, _ = strings.Cut(rawQuery, "#")
						values, err := url.ParseQuery(rawQuery)
						if err == nil {
							keys := make([]string, 0, len(values))
							for key := range values {
								keys = append(keys, key)
							}
							sort.Strings(keys)
							for _, key := range keys {
								for _, value := range values[key] {
									checkTemplate(node.ID, "url", value)
								}
							}
						}
					}
				}
				address := templateReference.ReplaceAllString(d.URL, "placeholder")
				u, err := url.Parse(address)
				dynamicBase := strings.HasPrefix(strings.TrimSpace(d.URL), "{{")
				if err != nil || (!dynamicBase && (u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil)) {
					add("invalid_url", node.ID, "url", "请求地址格式无效。", "填写完整的 HTTP 或 HTTPS 地址，登录信息放到请求头。")
				}
			}
			method := strings.ToUpper(strings.TrimSpace(d.Method))
			switch method {
			case "", "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS":
			default:
				add("invalid_method", node.ID, "method", "这个 HTTP 方法暂不支持。", "选择支持的 HTTP 方法。")
			}
			if _, err := parseAcceptedStatuses(d.AcceptStatus); err != nil {
				add("invalid_accept_status", node.ID, "acceptStatus", "允许的状态码格式无效。", "填写 100 到 599 的状态码或范围，例如 200-299,404。")
			}
			checkTemplate(node.ID, "body", d.Body)
			names := make([]string, 0, len(d.Headers))
			for name := range d.Headers {
				names = append(names, name)
			}
			sort.Strings(names)
			for _, name := range names {
				checkTemplate(node.ID, "headers."+name, d.Headers[name])
			}
		case "condition", "assertion":
			if strings.TrimSpace(d.Variable) == "" {
				add("reference_required", node.ID, "variable", "请选择要检查的参数或响应字段。", "使用字段选择器选择检查对象。")
			} else if d.Operator != "exists" {
				checkRef(node.ID, "variable", d.Variable)
			}
			switch d.Operator {
			case "eq", "neq", "contains", "exists":
			default:
				add("invalid_operator", node.ID, "operator", "请选择有效的检查方式。", "选择等于、不等于、包含或存在。")
			}
			checkTemplate(node.ID, "expected", d.Expected)
		case "output":
			checkTemplate(node.ID, "template", d.Template)
		default:
			add("unsupported_kind", node.ID, "kind", "这个方块暂不支持执行。", "使用输入、请求、提取、条件、断言、人工输入或输出方块。")
		}
	}
	names := make([]string, 0, len(flow.Inputs))
	for name := range flow.Inputs {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if !variableName.MatchString(name) {
			add("invalid_input", "", "inputs."+name, "输入参数的名称格式无效。", "修改参数名称。")
		} else if len(flow.Inputs[name]) > 2<<20 {
			add("input_too_large", "", "inputs."+name, "输入参数超过 2 MiB。", "缩小参数内容。")
		}
	}
	v.Valid = len(v.Issues) == 0
	return g, v
}

type statusRange struct{ first, last int }

func parseAcceptedStatuses(text string) ([]statusRange, error) {
	if strings.TrimSpace(text) == "" {
		return []statusRange{{200, 399}}, nil
	}
	if len(text) > 2048 {
		return nil, fmt.Errorf("状态码设置过长")
	}
	ranges := []statusRange{}
	for _, part := range strings.Split(text, ",") {
		bounds := strings.Split(strings.TrimSpace(part), "-")
		if len(bounds) < 1 || len(bounds) > 2 {
			return nil, fmt.Errorf("无效状态码范围")
		}
		first, err := strconv.Atoi(strings.TrimSpace(bounds[0]))
		if err != nil || first < 100 || first > 599 {
			return nil, fmt.Errorf("无效状态码")
		}
		last := first
		if len(bounds) == 2 {
			last, err = strconv.Atoi(strings.TrimSpace(bounds[1]))
			if err != nil || last < first || last > 599 {
				return nil, fmt.Errorf("无效状态码范围")
			}
		}
		ranges = append(ranges, statusRange{first, last})
	}
	return ranges, nil
}

func acceptsStatus(text string, status int) bool {
	ranges, err := parseAcceptedStatuses(text)
	if err != nil {
		return false
	}
	for _, r := range ranges {
		if status >= r.first && status <= r.last {
			return true
		}
	}
	return false
}
