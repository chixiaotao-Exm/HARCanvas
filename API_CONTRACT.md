# HAR Canvas API contract

Go backend with React/TypeScript and React Flow. The interface is Chinese. Opening or refreshing the application starts with an empty workspace: no implicit HAR loading, model call, or request replay. Import and analysis are separate actions. Successful analysis incrementally creates editable draft nodes and supported evidence-based connections; execution requires an explicit Run action and successful preflight.

Provider URL, API key, and model use visible text inputs. Only Save persists provider settings in the browser; project files exclude those settings. Uploaded HAR and retained execution results stay in process memory, never in server-side HAR files. Model output supplies validated metadata, not executable code. There is no browser automation or arbitrary code execution.

## Common HTTP behavior

- API responses use JSON and `Cache-Control: no-store`. JSON request bodies require `Content-Type: application/json`, contain one JSON value, and have a 32 MiB maximum. File upload uses the separate multipart endpoint below.
- Ordinary errors are `{error:string}`. Flow preflight failures instead return the structured `FlowValidation` object. Unsupported methods return 405 with `Allow`; missing or expired resources return 404; a full concurrency limit returns 429 without queueing or retrying.
- When the application is wrapped in `RequestLogging`, responses include a request correlation ID. Server logs contain method, route template, status, timing, job/request IDs and counts; they exclude API keys, HAR/request/response bodies, cookies, URL query values and raw provider errors.
- Agent and flow task IDs are opaque 24-character identifiers. Task creation returns promptly with 202. Tasks survive the creation request closing; reconnect by polling the same ID, never by automatically repeating POST.
- Optional Basic Auth protects the whole application when both `HAR_CANVAS_USER` and `HAR_CANVAS_PASSWORD` are configured. A partial credential pair is a startup error. `-require-auth` also rejects startup when both are absent. Local default without credentials remains anonymous.

`GET /api/health` → `{status:"ok"}`.

## HAR import and original evidence

`POST /api/har/parse` accepts `{har:<HAR object>}` and returns `ParseResult`. This JSON endpoint retains its 32 MiB request limit and returns full parsed response bodies. It is useful for small HAR objects and compatibility clients.

`POST /api/har/upload` accepts one `multipart/form-data` part named `file`, maximum 256 MiB. The multipart body allows an additional 1 MiB for framing. At most two imports run concurrently. Returns `ParseResult` with full original request headers/body and response previews up to 16 KiB per request. Initial result JSON cannot exceed 32 MiB: overlarge imports fail explicitly instead of silently deleting request data. The endpoint does not call a model or replay requests.

Each uploaded request has `responseDetailUrl` pointing to `GET /api/har/uploads/{uploadId}/requests/{requestId}` → `{request:Request}` with the complete response. Retention is 30 minutes from import, at most three captures and 512 MiB of combined request/response body text; older captures may be evicted when the next capture is accepted. Missing or expired detail returns 404 and requires reimport. Importing a file does not write it to disk.

`GET /api/har/example` explicitly loads the fixed local `-sample-har` path (default `samples/re.har`) once per process. It returns `ParseResult` plus `name`, `fileName`, `fileBytes`, `responsePreviewLimitBytes`, `previewedResponses`, and `fullResponseAvailable`. Example response previews are 64 KiB; source file maximum is 256 MiB and initial JSON maximum is 32 MiB. Missing sample returns 404. `GET /api/har/example/requests/{id}` → `{request:Request}` reads the complete request from the same immutable snapshot. No arbitrary file paths are accepted. The frontend never requests the example automatically.

```ts
type ParseResult = {
  requests: Request[];
  summary: {total:number;api:number;static:number;domains:string[]};
  warnings: string[];
  pages?: {id:string;title:string;startedDateTime:string}[];
};
type Request = {
  id:string;method:string;url:string;domain:string;path:string;
  category:string;mimeType:string;status:number;duration:number;
  headers:Record<string,string>;body:string;responseBody:string;
  responseHeaders:Record<string,string>;query:Record<string,string>;
  pageId?:string;startedDateTime?:string;startedAt?:string;
  responseBodyTruncated?:boolean;responseBodyBytes?:number;
  responseDetailUrl?:string;
};
```

Request IDs are stable within a parsed capture (`req-1`, etc.), not globally unique across captures. Frontend provenance also includes its capture identity. Categories include `api`, `static`, `document`, and `other`; aggregation does not discard original requests or replay them. `startedDateTime` is the canonical HAR timestamp; `startedAt` is a compatible alias when present.

## Agent analysis

Both analysis creation endpoints accept:

```ts
type AnalyzeInput = {
  config: {baseUrl:string;apiKey:string;model:string};
  requests: Request[];
  context?: {
    goal:string;
    catalog:{id:string;method:string;domain:string;path:string;category:string;pageId?:string}[];
    groups:{id:string;label:string;kind:string;requestIds:string[]}[];
    relations:{sourceRequestId:string;targetRequestId:string;sourcePath:string;targetPath:string;evidence:string}[];
    previous:{requestId:string;label:string;dependencies:string[]}[];
	truncated?:boolean;
  };
};
type Analysis = {summary:string;suggestions:Suggestion[];warnings:string[]};
type Suggestion = {
  requestId:string;label:string;description:string;category:string;
  dependencies:string[];confidence:string;
  variables:{name:string;source:string;description:string}[];
  group?:string;inputs?:string[];outputs?:string[];evidence?:string[];
  uncertainty?:string;readiness?:string;
};
```

- `POST /api/agent/analyze` → synchronous `Analysis`; analysis failure returns 502 `{error,errorCode}`.
- `POST /api/agent/jobs` → 202 `{id,status:"running"}`.
- `GET /api/agent/jobs/{id}` → `{id,status,analysis?,error?,errorCode?}`, status `running|completed|failed|cancelled`.
- `DELETE /api/agent/jobs/{id}` → the current terminal state or `cancelled`; cancellation wins over late provider results.

The configured base URL must end with `/v1`; the backend appends `/chat/completions`. Model/key/URL are required; failures are explicit and never replaced by fake analysis. Each task permits 1–300 requests, a 4 MiB selected-request payload, and a 4 MiB provider response. Analysis context is bounded to 512 KiB, goal to 16,000 bytes, catalog to 1,000 entries, previous suggestions to 300 and relations to 300. The provider call has a 180-second total and response-header timeout by default (`NewAnalyzerWithTimeout` configures it for embedding/tests).

Analysis failure `errorCode` is application-defined: `invalid_config`, `invalid_requests`, `invalid_context`, `analysis_limit`, `endpoint_unavailable`, `provider_unavailable`, `provider_response_failed`, `provider_http_error`, `provider_response_invalid`, `provider_analysis_invalid`, `timeout`, `cancelled`, or `internal_error`. Sync errors and async job errors contain controlled diagnostic text; provider bodies, provider-controlled IDs/dependencies, JSON parser details, and raw transport errors are never copied into errors. HTTP status and the configured timeout may be included.

Two shared analysis slots cover synchronous and asynchronous calls. A cancelled task retains its slot until its worker actually exits. Terminal analysis records last 15 minutes, at most 128 records; eviction prefers terminal records. Active task state is process-local and is lost on restart.

The frontend sends sequential batches of at most 50 requests and approximately 96 KiB of request JSON, with UTF-8-safe 12,000-byte body previews. The source capture is unchanged. Batches share the global catalog, grouping/field evidence, goal, and previous suggestions. A failed or cancelled batch stops later batches and preserves completed suggestions. Imports discard stale results. There is no automatic provider retry.

`label` is a short Chinese business name. Required, nonblank Chinese `description` explains the request's purpose, input provenance, output and uncertainty; missing descriptions fail analysis rather than receiving a generic fallback. Suggestion request IDs must belong to the submitted batch; dependency IDs may refer to the bounded global catalog. Credential values must not be repeated in explanations. Suggested connections remain editable, and uncertain relations do not become executable connections automatically.

## Flow model and preflight

```ts
type Flow = {
  entryId?:string; // entryNodeId is an accepted compatibility alias
  nodes:FlowNode[];edges:FlowEdge[];inputs:Record<string,string>;
};
type FlowNode = {id:string;type:"block";position?:{x:number;y:number};data:BlockData};
type FlowEdge = {id?:string;source:string;target:string;sourceHandle?:"true"|"false"};
type BlockData = {
  kind:"input"|"request"|"extract"|"condition"|"assertion"|"manual"|"output";
  label:string;description?:string;requestId?:string;
  method?:string;url?:string;headers?:Record<string,string>;body?:string;
  variable?:string;value?:string;source?:string;path?:string;
  operator?:"eq"|"neq"|"contains"|"exists";expected?:string;
  template?:string;acceptStatus?:string;
};
type FlowValidation = {
  valid:boolean;entryId?:string;entryNodeIds:string[];reachableNodeIds:string[];
  issues:{code:string;nodeId:string;field:string;message:string;suggestedAction:string}[];
};
```

`POST /api/flow/validate` accepts `Flow` and returns 200 `FlowValidation`, including Chinese, field-specific problems. Missing extraction source, deleted source, unconnected source and missing path have distinct issue codes. Preflight also checks references, template syntax, addresses, supported methods/kinds, status ranges, variable names, graph structure, branches and cycles. It does not contact a target or resolve DNS. Empty required business inputs are checked by the frontend binding compiler; empty strings remain valid values for generic inputs and `exists` checks.

The canvas allows 1–3,000 nodes and up to 5,000 edges. One selected execution can reach at most 100 nodes and 300 edges. With one root, the backend infers that entry; multiple roots require `entryId`. An entry must exist and have no incoming edge. Only nodes reachable from the selected entry execute. Structural issues apply to the whole canvas, while field configuration issues in an unrelated draft do not block the chosen entry. Graph execution is topological, acyclic and deterministic; a merge runs after predecessors are processed if any incoming branch is active. After a failed step, later reachable steps are skipped.

- `input` defines `variable` from `Flow.inputs[variable]` or its templated `value`. `Flow.inputs` may also define variables without input nodes.
- `request` uses method/URL/headers/body; default method is GET. Supported methods: GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS. Its result is `{status:number,headers:Record<string,string>,body:any}`. JSON response bodies are decoded; other bodies remain strings.
- `extract` reads `path` from the successful `source` node and publishes `variable`; the source must be connected upstream. Paths use dots and numeric array indices, e.g. `body.data.items.0.id`.
- `condition` checks `variable` (which can be `requestId.body.field`) against templated `expected` using `eq|neq|contains|exists`. Its `true`/`false` source handles choose the active branch.
- `assertion` uses the same comparison fields; a false comparison fails with `assertion_failed` instead of choosing a branch. HTTP success alone does not prove business success.
- `manual` always pauses when reached, asking for `variable` with `label` and `description`. It requires the asynchronous job API. Resume preserves preceding responses and the same cookie jar; it never reruns preceding nodes.
- `output` renders `template` into the final output.

Templates `{{name}}` read input/extracted/manual variables; `{{nodeId.body.field}}` reads upstream step results. Variable lookup takes precedence over a same-named node result. Substituted user data is not recursively interpreted as another template. JSON request bodies that contain templates and parse as JSON render string values recursively, then marshal to preserve JSON escaping and original scalar types. Non-JSON text uses ordinary substitution. Query values containing templates are decoded, substituted individually and encoded once, so `&`, `=`, and `+` stay inside their parameter. Encoded query placeholders are supported. URLs and bodies with no templates retain their original bytes. Base/path templates remain ordinary substitutions; the final URL always passes NetworkGuard.

The frontend binding compiler uses bounded deterministic IDs and maps temporary manual nodes back to their visible request. Fixed text is passed through an input variable once so literal `{{text}}` is preserved. Fixed numeric/boolean JSON fields retain their type; dynamic bindings to those fields currently fail explicitly instead of silently becoming strings. JSON field edits containing integers outside JavaScript's safe range are blocked to avoid rounding; full-body advanced editing remains available. Conflicting writes (including whole URL plus query, or whole body plus an individual field) are preflight issues rather than array-order-dependent overwrites.

`request.acceptStatus` optionally lists exact codes or inclusive ranges from 100 to 599, e.g. `200-299,404`. Default is 200–399; final HTTP 4xx/5xx fails with `http_status` and retains the response for inspection. Transport headers such as Host, Content-Length and hop-by-hop headers are rebuilt. Session cookies replace captured stale cookies; deleted cookies are not resurrected from later captured headers.

## Flow tasks, events and results

- `POST /api/flow/jobs` accepts `Flow` → 202 `FlowJobView`, initially containing reachable `pending` events. Invalid flow → 400 `FlowValidation`.
- `GET /api/flow/jobs/{id}?after={seq}` → `FlowJobView` with only events newer than `seq`. Omitted `after` means zero; negative/noninteger values return 400. The returned `seq` is the latest sequence, including when no new events exist.
- `DELETE /api/flow/jobs/{id}` cancels the task and pending nodes. It is idempotent for terminal tasks and never restarts execution.
- `POST /api/flow/jobs/{id}/resume` accepts `{inputs:{[pendingInput.variable]:string}}`. The required key must be present; an empty string is allowed. Wrong/missing key → 400; input over 2 MiB → 413; task not waiting → 409. Success returns the updated view, then the same worker continues.
- `GET /api/flow/jobs/{id}/results/{nodeId}` → completed `Step`, including full node result and technical error. An unfinished/unavailable step returns 404.
- `GET /api/flow/jobs/{id}/result` → complete terminal `RunResult`; 409 until ready.
- `POST /api/flow/run` retains synchronous compatibility: accepts `Flow`, returns complete `RunResult`, or 400 `FlowValidation`. Manual nodes fail with `manual_requires_job` on this synchronous route.

```ts
type FlowJobView = {
  id:string;status:"running"|"waiting_input"|"completed"|"failed"|"cancelled";
  events:FlowEvent[];seq:number;pendingInput?:PendingInput;
  result?:RunResult;error?:string;
};
type PendingInput = {nodeId:string;variable:string;label:string;prompt:string};
type FlowEvent = {
  runId:string;seq:number;nodeId:string;
  status:"pending"|"running"|"waiting_input"|"success"|"error"|"skipped"|"cancelled";
  time:string;durationMs?:number;errorCode?:string;message?:string;
};
type Step = {
  nodeId:string;label:string;kind:string;
  status:"success"|"error"|"skipped"|"cancelled";
  durationMs:number;result:any;error?:string;errorCode?:string;
};
type RunResult = {
  status:"success"|"error"|"cancelled";steps:Step[];
  variables:Record<string,any>|null;output:any;
};
```

Events have strictly increasing sequence numbers and UTC timestamps; running events come from actual execution. Polling terminal `result` contains only status and step metadata: step `result`, variables and output are null. Fetch `/result` once for full output/variables, or a single node detail on demand. Runtime event messages and polling summaries use safe error text; complete diagnostic URLs are available only in explicitly requested details. Keep runtime state separate from project design/export data.

Each run takes an immutable copy of nodes, edges, headers and inputs. Canvas edits affect the next run. Asynchronous flow lifetime is at most 10 minutes including manual waits; synchronous lifetime is 120 seconds. Both APIs share two active slots. Cancellation marks the view immediately but retains its slot until the actual worker exits, and a late response cannot overwrite cancellation. Terminal results last 15 minutes, at most 128 tasks. Storage is memory-only and restarts lose task IDs/results.

## Network and resource limits

Replay HTTP total timeout is 25 seconds per request; response-header timeout is 20 seconds; connect/TLS timeout is 10 seconds. At most eight redirects are followed, HTTPS-to-HTTP downgrade is denied, TLS is 1.2 or newer and no environment proxy is used. All DNS answers and the concrete dial address are checked against the guard, including redirects and DNS rebinding. Private, loopback, link-local, metadata and reserved destinations are blocked for replay. An explicitly configured local model provider is allowed by the separate Agent guard, while metadata destinations remain blocked.

Request/rendered fields and manual/input values are limited to 2 MiB. A replay response is limited to 2 MiB and total flow response bodies to 8 MiB. Aggregate JSON/query substitution expansion is bounded. No external request occurs during HAR parsing, preflight or canvas editing.

## Serving and delivery

The Go server serves `web/dist` with SPA fallback, default `127.0.0.1:8090`; flags include `-addr`, `-web`, `-sample-har` and `-require-auth`. Public binding must be selected explicitly. The executable sets 10-second read-header timeout, 5-minute read/write timeouts and 60-second HTTP idle timeout. Vite development proxies `/api` to 8090. Deployment, commits and remote changes require the user's corresponding instruction; local implementation and tests do not deploy anything.
