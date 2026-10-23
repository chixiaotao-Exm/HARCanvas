# HAR Canvas API contract

Go backend with React/TypeScript and React Flow. The interface is Chinese. Opening or refreshing the application starts with an empty workspace: no implicit HAR loading, model call, or request replay. Import and analysis are separate actions. Successful analysis incrementally creates editable draft nodes, Agent-proposed flow connections and recorded-field connections; execution requires an explicit Run action and successful preflight.

Provider URL, API key, and model use visible text inputs. Only Save persists provider settings in the browser; project files exclude those settings. Uploaded HAR and retained execution results stay in process memory, never in server-side HAR files. Model output supplies validated metadata and canvas transactions, not executable code. Ordinary Playwright browser actions and scoped human handoff are available when their runtime is installed; arbitrary code execution is not supported.

## Common HTTP behavior

- API responses use JSON and `Cache-Control: no-store`. JSON request bodies require `Content-Type: application/json`, contain one JSON value, and have a 32 MiB maximum. HAR file import uses the chunked endpoints below; the multipart endpoint remains available for compatibility.
- Ordinary errors are `{error:string}`. Flow preflight failures instead return the structured `FlowValidation` object. Unsupported methods return 405 with `Allow`; missing or expired resources return 404; a full concurrency limit returns 429 without queueing or retrying.
- When the application is wrapped in `RequestLogging`, responses include a request correlation ID. Server logs contain method, route template, status, timing, job/request IDs and counts; they exclude API keys, HAR/request/response bodies, cookies, URL query values and raw provider errors.
- Agent and flow task IDs are opaque 24-character identifiers. Task creation returns promptly with 202. Tasks survive the creation request closing; reconnect by polling the same ID, never by automatically repeating POST.
- Optional Basic Auth protects the whole application when both `HAR_CANVAS_USER` and `HAR_CANVAS_PASSWORD` are configured. A partial credential pair is a startup error. `-require-auth` also rejects startup when both are absent. Local default without credentials remains anonymous.

`GET /api/health` → `{status:"ok"}`.

## HAR import and original evidence

The workbench imports files using short, sequential requests instead of sending an entire large file through one connection. File transfer and parsing are separate stages. No import endpoint calls a model or replays captured requests.

```ts
type ImportView = {
  id: string;
  status: 'uploading' | 'parsing' | 'completed' | 'failed' | 'cancelled';
  size: number;
  receivedBytes: number;
  chunkSize: number;
  encoding?: 'identity' | 'gzip';
  originalSize?: number;
  error?: string;
  errorCode?: string;
  requestId?: string;
};
```

- `POST /api/har/imports` accepts `{size:number,encoding?:'identity'|'gzip',originalSize?:number}` and returns 201 `ImportView`. `size` is the number of bytes to transfer; `originalSize` is the restored HAR size. Both must be between 1 byte and 256 MiB. Missing encoding defaults to `identity`, whose original size defaults to and must equal `size`; gzip requires an explicit original size. Views return the normalized encoding and original size. At most two imports are active across the chunked and compatibility upload APIs.
- `PUT /api/har/imports/{id}/chunks?offset=N` sends `application/octet-stream`. Offsets are multiples of `chunkSize` (1 MiB); each chunk must contain exactly that many bytes, except the final chunk which contains the remaining declared bytes. A chunk is committed only after its complete body has been read and validated. Already committed, byte-identical retransmissions are idempotent; changed or out-of-order data returns 409. Success returns the current `ImportView`.
- `GET /api/har/imports/{id}` returns a small `ImportView` for recovery and polling. `receivedBytes` counts server-confirmed bytes, rather than an estimated completion percentage.
- `POST /api/har/imports/{id}/complete` requires all declared bytes, starts asynchronous parsing, and promptly returns 202/current `ImportView`. Repeating completion does not create another parser worker. Parsing continues if this HTTP connection closes.
- `GET /api/har/imports/{id}/result` returns `ParseResult` after completion; an unfinished import returns 409. The result uses the same evidence-preserving preview and full-response retention rules as multipart upload.
- `DELETE /api/har/imports/{id}` cancels an import and returns its view. Cancelled work cannot later publish success. A parser already running retains its concurrency slot until its worker exits.

Gzip is lossless transport compression. Chunks remain raw `application/octet-stream` and do not use an HTTP `Content-Encoding` header. After upload, the worker restores the file with a hard read limit, checks the declared restored size, validates the gzip stream, and rejects truncated, corrupt or trailing compressed data before parsing. It never strips captured records or response bodies to reduce transfer size.

Import buffers and results stay in bounded process memory. Transfers expire after 15 minutes without activity; terminal records expire after 30 minutes. At most 32 import records and 64 MiB of encoded results are retained, with older terminal records evicted first. Two workers can temporarily hold both their compressed inputs and restored HAR bytes, each individually capped at 256 MiB, plus parsing allocations. These are content limits rather than a hard process RSS limit. The existing complete-response store has its own limits below. All imports are lost on service restart. A missing/expired import requires reimport. Server stage logs include correlation/import IDs, confirmed or received byte counts, timing, and fixed error classifications, without recording file names or capture contents.

For files at least 2 MiB, the workbench attempts local streaming gzip when the browser supports it, and uses compression only if it reduces size. The compression phase shows elapsed time. Server-confirmed transfer progress uses the actual payload size and displays the original and transferred sizes; retries reuse the same prepared bytes and encoding. Parsing then has a distinct indeterminate indicator. Transfer errors remain visible with their diagnostic request ID and a retry action. Import callbacks carry capture identity and project generation: cancelling/removing a capture or resetting the project invalidates that work; another capture's completion cannot replace existing nodes or answers.

The client can append multiple captures to one project. Each capture has a stable project-local ID; normalized request and page IDs include that capture ID, while `originalRequestId` preserves the HAR-local ID. Capture metadata includes name, creation time, requests, summary, pages, warnings and import status. Existing node positions, edits and deleted-step suppression remain scoped to their source. Generated requests carry `captureId`; absent an explicit shared session, runtime isolates HTTP cookies by capture. Cross-capture edges do not implicitly share cookies or infer data bindings. Reimporting a file creates a separate capture unless the user explicitly replaces/restores a project.

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

The synchronous endpoint and default/detail asynchronous mode accept:

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
  inputFields?:{name:string;target:'body'|'query';path:string;
    placeholder?:string;required?:boolean}[];
  uncertainty?:string;readiness?:string;
};
```

- `POST /api/agent/analyze` → synchronous `Analysis`; analysis failure returns 502 `{error,errorCode}`.
- `POST /api/agent/jobs` accepts detail input above (optional `mode:'detail'`), or the overview/repair envelopes below, and returns 202 `{id,status:"running",mode?,progress?}`.
- `GET /api/agent/jobs/{id}` returns the matching result type:

  ```ts
  type AgentJobView = {
    id:string;status:'running'|'completed'|'failed'|'cancelled';
    mode?:'detail'|'overview'|'repair'; // absent/empty mode remains legacy detail
    analysis?:Analysis;overview?:OverviewResult;repair?:RepairPlan;
    error?:string;errorCode?:string;
    progress?:{stage:'preparing'|'waiting_model'|'reading_response'|'validating'|'completed';
      elapsedMs:number;payloadBytes?:number;contextBytes?:number;responseBytes?:number};
  };
  ```

  Completed detail jobs contain `analysis`, overview jobs contain `overview`, and repair jobs contain `repair`; the other result fields are absent. Overview/repair creation and polling require their exact mode. Unknown modes return 400.
- `DELETE /api/agent/jobs/{id}` → the current terminal state or `cancelled`; cancellation wins over late provider results.

The configured base URL must end with `/v1`; the backend appends `/chat/completions`. Model/key/URL are required; failures are explicit and never replaced by fake analysis. Each detail task permits 1–300 requests, a 4 MiB selected-request payload, and a 4 MiB provider response. Analysis context is bounded to 512 KiB, goal to 16,000 bytes, catalog to 1,000 entries, previous suggestions to 300 and relations to 300. The provider call has a 180-second total and response-header timeout by default (`NewAnalyzerWithTimeout` configures it for embedding/tests).

Analysis failure `errorCode` is application-defined: `invalid_config`, `invalid_requests`, `invalid_context`, `invalid_overview`, `invalid_repair`, `analysis_limit`, `endpoint_unavailable`, `provider_unavailable`, `provider_response_failed`, `provider_http_error`, `provider_response_invalid`, `provider_analysis_invalid`, `timeout`, `cancelled`, or `internal_error`. Sync errors and async job errors contain controlled diagnostic text; provider bodies, provider-controlled IDs/dependencies, JSON parser details, and raw transport errors are never copied into errors. HTTP status and the configured timeout may be included.

Two shared analysis slots cover synchronous calls and all detail, overview and repair jobs. A cancelled task retains its slot until its worker actually exits. Terminal analysis records last 15 minutes, at most 128 records; eviction prefers terminal records. Active task state is process-local and is lost on restart. The job store retains bounded results and progress, not provider configuration or submitted request/catalog data.

Job `progress` contains `{stage,elapsedMs,payloadBytes?,contextBytes?,responseBytes?}`. Its fixed stages are `preparing`, `waiting_model`, `reading_response`, `validating`, and `completed`; they advance only with actual model-call activity. Polling reports live elapsed time, and failures retain the last observed stage. No incomplete model JSON becomes an analyzed request or canvas node. Stage logs record correlation/job IDs, byte counts, elapsed time and controlled error codes without model settings, endpoints or HAR values.

The frontend sends a first batch of at most 4 requests, then sequential batches of at most 12 requests and 96 KiB of request JSON, with UTF-8-safe 4,096-byte body previews. The source capture and canvas requests remain unchanged. Each batch receives at most 32 KiB of related context, including the goal, current request catalog, supported field relations with their source records, relevant history and limited nearby metadata. This replaces repeatedly sending the entire global catalog. Omitted auxiliary context and shortened previews are disclosed as analysis limitations; identifiers and field paths are never shortened into different evidence. No request is discarded or deduplicated by URL. A failed or cancelled batch stops later batches and preserves completed suggestions. Imports discard stale results. There is no automatic provider retry.

`label` is a short Chinese business name. Required, nonblank Chinese `description` explains the request's purpose, input provenance, output and uncertainty; missing descriptions fail analysis rather than receiving a generic fallback. The prompt requests descriptions of approximately 60–100 Chinese characters, at most two evidence items and three necessary variables; these are guidance rather than a claim of provider-enforced token limits. Suggestion request IDs must belong to the submitted batch; dependency IDs may refer to the bounded related catalog or history. Credential values must not be repeated in explanations.

Optional `inputFields` identifies at most 16 ordinary business inputs, such as email, username or address. Each location must already exist as a writable JSON string leaf (`body`, using a dot path) or a nonduplicate query parameter (`query`, using its exact name). Dynamic credentials, session fields, signatures, verification codes, headers and form-encoded bodies are excluded. Labels and placeholders are canonical field descriptions, never recorded values. Invalid locations are ignored with a warning. An explicit empty array means the model reviewed the request and found no confirmed inputs; an omitted field permits conservative compatibility inference for a `missing-input` step. Generation preserves this distinction in node metadata so project import cannot turn a reviewed empty result into inferred fields.

`dependencies` names the direct predecessor requests that should complete before this step, based on input provenance or an evidenced business sequence. The prompt excludes self references, duplicates, expanded lists of indirect ancestors and cycles; temporal proximity alone is insufficient. A relation without enough evidence belongs in `uncertainty`, not in `dependencies`. A valid identifier is not proof that the model inferred the business order correctly.

After creating the current nodes, generation resolves known dependency IDs into editable `Agent 流程` draft connections, independently of recorded-value matches marked `字段关联`. Both are deduplicated and checked against existing paths to avoid adding cycles; unknown or unavailable endpoints remain pending. Agent flow edges do not create parameter bindings or change readiness. Only separately verified, supported recorded-field evidence can initialize an upstream binding. Automatic incremental connection creation involves at least one newly generated endpoint, preserving connections that a user deliberately removed between existing nodes. The explicit `补齐连线` action can restore missing suggestions between existing nodes from the current analysis, saved node dependencies or available recorded-field evidence; it never infers order solely from capture timestamps. Newly generated nodes retain dependency IDs in project exports. Older projects without saved dependencies require new analysis to recover Agent-proposed order. None of these actions runs the flow.

### Main-flow overview jobs

The default workbench mode first selects a bounded set of main-flow candidates, then deeply analyses only those original records using the detail API above. At most four pending records skip the extra selection call. A user can choose full per-record analysis or click a pending record for supplemental detail. Valid explanations already completed in the same session are reused; successful previous results survive cancellation and supplementation.

`POST /api/agent/jobs` also accepts an overview task:

```ts
type OverviewInput = {
  mode: 'overview';
  config: {baseUrl:string;apiKey:string;model:string};
  overview: {
    goal:string;
    requests:{id:string;method:string;domain:string;path:string;category:string;
      status:number;mimeType:string;pageId?:string;startedAt?:string}[];
  };
};
type OverviewResult = {
  summary:string;
  selectedRequestIds:string[];
  reasons:{requestId:string;reason:string}[];
  warnings:string[];
};
```

Creation and status responses contain `mode:'overview'`; a completed status contains `overview:OverviewResult` and no `analysis`. Overview tasks share the existing two slots, cancellation, stage progress and retention. Missing mode or `mode:'detail'` retains existing detail behavior; the synchronous endpoint remains unchanged.

The backend reconstructs the metadata whitelist. No request URL, query values, headers or bodies are sent for overview. Inputs are limited to 1–1000 records and 512 KiB for the encoded `{goal,requests}` object; goal is at most 16000 UTF-8 bytes. IDs use the existing 1–128 character identifier syntax. Other field limits in UTF-8 bytes are method 32, domain 512, path 4096, category 100, MIME type 256, page ID 200 and timestamp 100. Oversized inputs fail explicitly before a model call, without truncating IDs or dropping records.

Selection targets approximately 8–16 requests, with a hard maximum of 24. Selected IDs must be known and unique; reasons must cover exactly those IDs once each. Empty selections are valid and do not trigger automatic full analysis. Summary is nonblank and at most 2000 bytes, each reason nonblank and at most 600 bytes, warnings at most 12 with 1000 bytes each. Provider responses are capped at 128 KiB. Invalid inputs use `invalid_overview`; invalid output uses `provider_analysis_invalid`.

Overview is only a metadata-based hypothesis. It never supplies purpose suggestions, creates blocks, propagates an explanation to same-URL records, or proves flow completeness. Unselected records remain pending. Detail preserves original capture order and receives scoped context from the broader capture. Generation checks recorded field evidence against the complete capture, so omitted sources remain pending and cannot silently make a consumer ready. Supplemental analysis preserves existing user edits and does not retrofit bindings into existing nodes; users review those bindings in the parameter inspector.

### Agent repair jobs

Repair is a separate planning action for an existing canvas. It returns questions, binding drafts and per-node explanations; it does not execute requests or change readiness. The frontend constructs an opaque capability catalog from the current graph and original recorded evidence. No field values, answers, full URL, request/response body or header map are part of this DTO.

```ts
type RepairInput = {
  goal:string;
  nodes:{
    id:string;label:string;
    kind:'input'|'request'|'extract'|'condition'|'assertion'|'manual'|'output';
    readiness:'ready'|'missing-input'|'manual'|'unsupported';
    description:string;uncertainty:string;issues:string[];
    fields:{id:string;target:'body'|'header'|'query';path:string;
      valueType:'string';existingBinding:boolean}[];
    sources:{id:string;fieldId:string;sourceNodeId:string;sourcePath:string;evidence:string}[];
  }[];
};
type RepairPlan = {
  summary:string;
  questions:{id:string;title:string;help:string;placeholder:string;required:boolean}[];
  bindings:{nodeId:string;fieldId:string;mode:'user'|'manual'|'upstream';
    questionId?:string;sourceId?:string;reason:string}[];
  notes:{nodeId:string;title:string;message:string;kind:'manual'|'unsupported'|'review'}[];
  warnings:string[];
};
// POST /api/agent/jobs
type RepairJobInput = {
  mode:'repair';config:{baseUrl:string;apiKey:string;model:string};repair:RepairInput;
};
```

Creation and status responses contain `mode:'repair'`. Successful completion contains `repair:RepairPlan` and no detail/overview result. Repair reuses the same guarded compatible provider call, real stage observer, cancellation, two shared slots and terminal retention. Invalid catalog input returns 400 before a slot/provider call, using `invalid_repair`; invalid model output fails the job with `provider_analysis_invalid`. The backend reconstructs the catalog whitelist and strictly rejects unknown model result properties, including free-form patches and readiness changes. Provider JSON is bounded to 256 KiB; it must provide all result arrays and a real boolean `required` for each question.

| Repair input limit | Maximum |
| --- | --- |
| Nodes / encoded `{goal,nodes}` | 100 / 512 KiB |
| Goal | 16000 UTF-8 bytes |
| Fields / sources per node | 80 / 80 |
| Node, field, source and question IDs | `[A-Za-z0-9_-]{1,128}` |
| Field path / source path | 1024 UTF-8 bytes each |
| Label / description / uncertainty | 400 / 4000 / 4000 UTF-8 bytes |
| Issue codes | 30 per node, `[A-Za-z0-9_.:-]{1,100}` each |
| Source evidence | 1000 UTF-8 bytes |

Node IDs are globally unique; field/source IDs are unique within their target node. Fields belong only to request nodes and are existing writable string leaves: safe JSON dot paths, single query values or allowed existing headers. Whole URL/body replacement, object/null/numeric/boolean dynamic replacement, repeated query values and transport/system headers are excluded. Unsafe/prototype paths, duplicate targets and case-insensitive duplicate header names are rejected. Source capabilities must reference a known different request node and a specific local target field, using `body.*` or an addressable `headers.*` path. The frontend admits sources only after checking real graph ancestry and exact recorded string equality; the backend enforces the submitted capability whitelist. The DTO has no graph or recorded values, so it cannot independently establish those two provenance facts. Applying a plan rebuilds the current catalog and checks the unchanged canvas snapshot again.

Output limits are 32 questions, 100 bindings, 100 notes and 12 warnings. Summary is nonblank and at most 2000 UTF-8 bytes; each question/note title is nonblank and at most 200 bytes; question help is at most 1000 and placeholder at most 300; binding reason is nonblank and at most 1000; note message is nonblank and at most 2000; each warning is at most 1000. The question IDs `__proto__`, `prototype` and `constructor` are rejected. Prioritize a few understandable business fields: the question cap is not a target count, and unknown tracking/session/signature requirements remain explanatory notes.

Each binding must target a known `(nodeId,fieldId)` exactly once and cannot replace `existingBinding:true`. `user` requires a known `questionId` and no source; `manual` has neither question nor source; `upstream` requires a known source capability for that exact target field and no question. Questions may be reused across nodes, but every question must be referenced by a user binding. Every nonready node needs a note; an `unsupported` node needs an `unsupported` note and cannot receive any binding draft. No model result may supply a URL, whole body/header replacement, generator, transformation, executable code or readiness patch.

Question answers remain in frontend memory and, on explicit Apply, become the local runtime `values` used by the binding compiler. They are not sent in a repair request, saved to model settings or stored automatically. Explicit project export includes answers belonging to current user-input bindings, so reopening that file can restore them. A subsequent explicitly started execution sends the necessary runtime inputs to the flow server and intended target as usual. Application adds binding configuration without rewriting the original captured values or automatically clearing readiness. A user may explicitly confirm an eligible supported step only after applying/reviewing its bindings; manual steps require manual-input configuration. `unsupported` remains blocked. Recheck is validation only and never starts a flow. Actual execution requires a separate Run action and successful preflight.

### Agent conversation and graph transactions

`POST /api/agent/jobs` also accepts `{mode:'chat',config:AgentConfig,chat:ChatInput}`. It returns the usual asynchronous Agent job, whose successful terminal view includes `chat:ChatPlan`. Poll and cancel through the same job routes; stopping conversation work does not cancel an independently running workflow or replay any business request.

```ts
type ChatInput = {
  baseRevision:number;
  nodes:ChatCatalogNode[]; // sanitized nested node catalog
  edges:FlowEdge[];resourceBindings:ResourceBinding[];
  requests: {id:string;method:string;site:string;path:string;fields:{target:'body'|'query';path:string}[]}[];
  selectedNodeIds:string[];
  messages:{role:'user'|'assistant';content:string}[];
  diagnostics?:{issues:unknown[];events:unknown[]};
};
type ChatPlan = {
  baseRevision:number;message:string;commands:GraphCommand[];
  questions:{id:string;title:string;help:string;placeholder:string;required:boolean;variable:string;nodeId?:string}[];
  runIntent?:boolean;
};
```

The catalog exposes names, writable field locations, resource references, input names and supported settings. It excludes captured headers/bodies, answers, proxy URLs/passwords, cookies and provider credentials; user-typed conversation text is still sent as user content. HAR and catalog text are data, not authorization to issue commands. Requests created from the catalog load the original request locally rather than trusting a model-invented payload.

Supported command operations are `create`, `patch`, `delete`, `duplicate`, `connect`, `disconnect`, `bind`, `unbind`, `move`, `layout`, `group`, `resource` and `wrap`. `wrap` encapsulates an existing connected single-entry/single-exit region as a loop or subflow; arbitrary execution cycles and cross-scope edges remain invalid. `resource` is a configuration relationship, separate from an execution edge. Direct editing, import and Agent changes use shared graph constraints. The entire command list is checked against `baseRevision` and committed atomically; stale or invalid plans apply nothing. Undo restores the entire transaction. A new kind name does not create a new executable primitive.

A chat catalog is limited to 1000 total nodes, 3000 edges/resource bindings, 2000 request summaries, 20 messages and 768 KiB serialized input; field lists are bounded at 80 per node. A plan allows at most 100 commands and 32 questions. Questions are inline forms linked to existing input variables; answers join the current local input state. Collapsing the panel retains the current conversation and draft. Conversation history is restored only by explicitly opening a project file. Chat retry repeats the model operation, never a failed business request. An explicit Run intent still goes through the normal preflight/run path.

### Canvas fullscreen and preparation UI

The canvas toolbar uses the browser Fullscreen API for its canvas surface, with Enter/Exit controls, Esc support and visible unsupported/permission errors. It changes presentation only, with no API call or modification of graph/run data. Opening Run preparation, Repair or inline field settings first exits canvas fullscreen so the relevant panel is visible. Preparation groups user inputs, manual handling, unsupported capabilities and structural problems; a count of `REVIEW_REQUIRED`/`UNSUPPORTED_STEP` issues is not a promise of that many editable text fields. Fullscreen and repair browser acceptance are separate from backend contract tests.

Request cards render `mode:'user'` bindings as inline text fields; input blocks use their declared variable. Cards and Run preparation share the same `values` map and binding compiler. New fields start empty rather than copying captured values, existing user defaults remain supported, and editing a field does not rewrite the source HAR. Inline fields freeze during parsing, analysis, preflight, repair planning or active execution. Filled required fields do not automatically clear readiness: a supported `missing-input` step offers an explicit confirmation action, which checks its bindings before marking it ready. Manual and unsupported steps retain their handling requirements. Confirmation never executes a request.

### Local project files

Explicit project export writes version 4 with `projectId`, graph, `captures[]`, resource references/defaults, nested subflows, dataset metadata, optional chat history and `values:Record<string,string>`. `projectId` scopes explicitly retained sessions and remains stable when reopening that project. Versions 1–3 migrate their single request set into one capture while preserving node IDs, bindings and answers. Import validates nested IDs, edges and references before replacing the project.

Only current input variables and `mode:'user'` binding keys are included; explicit empty strings are preserved and unknown or inherited keys are excluded. Values are limited to 16,384 characters each. Compatible missing-input nodes may receive conservative bindings from actual writable business fields. Default export removes proxy usernames/passwords and sets `proxy.credentialsMissing:true`; users may explicitly include connection credentials. This does not strip captured HAR bodies/headers or user business answers from the evidence. Missing proxy credentials block execution and never cause a direct-connection fallback.

Neither export nor import contacts a model or executes the flow. Answers are not persisted automatically, and page refresh still opens an empty workbench. Model configuration, temporary browser/HTTP sessions and runtime results remain outside the project file. Full-response evidence URLs are temporary; reopening a project after their retention expires requires reimporting the corresponding HAR to recover omitted response bodies.

## Flow model and preflight

```ts
type Flow = {
  projectId?:string;
  entryId?:string; // entryNodeId is an accepted compatibility alias
  nodes:FlowNode[];edges:FlowEdge[];inputs:Record<string,string>;
  defaults?:ResourceDefaults;resourceBindings?:ResourceBinding[];
};
type FlowNode = {id:string;type:"block";position?:{x:number;y:number};data:BlockData};
type FlowEdge = {id?:string;source:string;target:string;sourceHandle?:"true"|"false"};
type BlockData = {
  kind:"input"|"request"|"extract"|"condition"|"assertion"|"manual"|"output"|
       "proxy"|"profile"|"browserSession"|"browser"|"browserVerification"|"loop"|"subflow"|"break";
  label:string;description?:string;requestId?:string;
  method?:string;url?:string;headers?:Record<string,string>;body?:string;
  variable?:string;value?:string;source?:string;path?:string;
  operator?:"eq"|"neq"|"contains"|"exists";expected?:string;
  template?:string;acceptStatus?:string;
  captureId?:string;originalRequestId?:string;
  sessionId?:string;proxyId?:string;profileId?:string;
  proxy?:ProxyConfig;profile?:BrowserProfileConfig;session?:SessionConfig;loop?:LoopConfig;
  browserAction?:'navigate'|'click'|'fill'|'read'|'wait';selector?:string;text?:string;
};
type ResourceDefaults={sessionId?:string;proxyId?:string;profileId?:string};
type ResourceBinding={id:string;resourceId:string;targetId:string};
type ProxyConfig={url:string;rotation:'fixed'|'run'|'request'|'minutes';sessionToken?:string;rotationMinutes?:number;credentialsMissing?:boolean};
type BrowserProfileConfig={id?:string;name?:string;browser:'chromium'|'firefox'|'webkit';locale:string;timezone:string;viewport:{width:number;height:number};userAgent?:string};
type SessionConfig={name:string;proxyId?:string;profileId?:string;persist?:boolean};
type LoopConfig={mode:'count'|'each';count:number;items:string;itemVariable:string;indexVariable:string;nodes:FlowNode[];edges:FlowEdge[];entryId?:string;continueOnError?:boolean;freshSession?:boolean};
type FlowValidation = {
  valid:boolean;entryId?:string;entryNodeIds:string[];reachableNodeIds:string[];
  issues:{code:string;nodeId:string;field:string;message:string;suggestedAction:string}[];
};
```

`POST /api/flow/validate` accepts `Flow` and returns 200 `FlowValidation`, including Chinese, field-specific problems. Missing extraction source, deleted source, unconnected source and missing path have distinct issue codes. Preflight also checks references, template syntax, addresses, supported methods/kinds, status ranges, variable names, graph structure, branches and cycles. It does not contact a target or resolve DNS. Empty required business inputs are checked by the frontend binding compiler; empty strings remain valid values for generic inputs and `exists` checks.

The canvas allows 1–3,000 nodes and up to 5,000 edges, including nested content. Each selected execution scope reaches at most 100 executable nodes and 300 edges. Structured repetition allows at most 1000 iterations, four nested levels and 10000 total execution instances. With one executable root, the backend infers that entry; multiple roots require `entryId`. Resource nodes do not become entries. An entry must exist and have no incoming execution edge. Only nodes reachable from the selected entry execute. Structural issues apply to the whole canvas, while field configuration issues in an unrelated draft do not block the chosen entry. Each scope is topological, acyclic and deterministic; a merge runs after predecessors are processed if any incoming branch is active. After a failed step, later reachable steps are skipped.

- `input` defines `variable` from `Flow.inputs[variable]` or its templated `value`. `Flow.inputs` may also define variables without input nodes.
- `request` uses method/URL/headers/body; default method is GET. Supported methods: GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS. Its result is `{status:number,headers:Record<string,string>,body:any}`. JSON response bodies are decoded; other bodies remain strings.
- `extract` reads `path` from the successful `source` node and publishes `variable`; the source must be connected upstream. Paths use dots and numeric array indices, e.g. `body.data.items.0.id`.
- `condition` checks `variable` (which can be `requestId.body.field`) against templated `expected` using `eq|neq|contains|exists`. Its `true`/`false` source handles choose the active branch.
- `assertion` uses the same comparison fields; a false comparison fails with `assertion_failed` instead of choosing a branch. HTTP success alone does not prove business success.
- `manual` always pauses when reached, asking for `variable` with `label` and `description`. It requires the asynchronous job API. Resume preserves preceding responses and the same cookie jar; it never reruns preceding nodes.
- `output` renders `template` into the final output.
- `loop` executes its nested DAG sequentially for `count` iterations or each item from the `items` list reference / JSON array. The index variable is zero-based; runtime event `iteration` is one-based. Each iteration gets local variables and retains independent results. `continueOnError` records a failed iteration and proceeds; default stops. `freshSession` creates isolated per-iteration sessions. A count of zero executes no child steps. Result is `{count:number,iterations:{iteration:number,status:string,output:any}[]}`.
- `subflow` executes its nested DAG once. `break` is valid only inside a loop region and exits that loop; an enclosing subflow passes the break to its parent loop. Arbitrary backward execution edges are still rejected.
- `proxy`, `profile` and `browserSession` configure execution resources rather than run in execution order. References are checked separately from execution edges; dangling or ambiguous resources fail preflight.
- `browser` uses `browserAction` to navigate, click, fill, read or wait in a real installed browser. `selector` identifies the page element, `text` is rendered for fill, and read publishes `text` into `variable` when provided. Results include `{url,title,applied:{browser,locale,timezone,viewport,userAgent},text?}` with values read from the real context.
- `browserVerification` optionally opens `url`, then pauses for normal human browser interaction. Resume continues the same page/context. It requires the job API and does not solve site challenges or construct verification bypass headers.

Templates `{{name}}` read input/extracted/manual variables; `{{nodeId.body.field}}` reads upstream step results. Variable lookup takes precedence over a same-named node result. Substituted user data is not recursively interpreted as another template. JSON request bodies that contain templates and parse as JSON render string values recursively, then marshal to preserve JSON escaping and original scalar types. Non-JSON text uses ordinary substitution. Query values containing templates are decoded, substituted individually and encoded once, so `&`, `=`, and `+` stay inside their parameter. Encoded query placeholders are supported. URLs and bodies with no templates retain their original bytes. Base/path templates remain ordinary substitutions; the final URL always passes NetworkGuard.

The frontend binding compiler uses bounded deterministic IDs and maps temporary manual nodes back to their visible request. Fixed text is passed through an input variable once so literal `{{text}}` is preserved. Fixed numeric/boolean JSON fields retain their type; dynamic bindings to those fields currently fail explicitly instead of silently becoming strings. JSON field edits containing integers outside JavaScript's safe range are blocked to avoid rounding; full-body advanced editing remains available. Conflicting writes (including whole URL plus query, or whole body plus an individual field) are preflight issues rather than array-order-dependent overwrites.

`request.acceptStatus` optionally lists exact codes or inclusive ranges from 100 to 599, e.g. `200-299,404`. Default is 200–399; final HTTP 4xx/5xx fails with `http_status` and retains the response for inspection. Transport headers such as Host, Content-Length and hop-by-hop headers are rebuilt. Session cookies replace captured stale cookies; deleted cookies are not resurrected from later captured headers.

### Proxy, session and profile resources

Inheritance is explicit request configuration, then enclosing region defaults, then selected session configuration, then project defaults. Missing proxy/profile/session references fail preflight. The UI renders configuration relationships as a separate dashed layer with dedicated noninteractive handles; those lines are not execution edges and do not participate in roots, reachability or DAG ordering. Different capture IDs use separate default HTTP sessions. A shared session reference is the explicit way to reuse a compatible account state.

`ProxyConfig.url` supports SOCKS5, HTTP CONNECT and HTTPS CONNECT with an explicit port and optional URL-encoded credentials. Session rotation replaces exactly one explicitly chosen unique username substring, never an assumed vendor-specific duration or region. `run` chooses one value per run; `request` chooses one per logical HTTP request, retaining it across that request's redirects; `minutes` changes the value on the next request after the run-relative interval expires (1–1440 minutes). Rotation does not itself prove the provider changed exit IP. Browser contexts and explicitly retained sessions require compatible fixed proxy identity; conflicts are preflight errors. A failed proxy never falls back to direct networking.

`POST /api/proxy/test` accepts `{proxy:ProxyConfig,url?:string}`. The default diagnostic target is `https://api.ipify.org?format=json`; a supplied target still passes the same network guard. Returns `{status:'success'|'error',durationMs:number,ip?:string,httpStatus?:number,message?:string}`. Invalid configuration returns 400; a tested connection failure is a normal JSON result with `status:'error'`. Arbitrary target headers/bodies and provider credentials are never copied into the diagnostic response. Only this explicit action sends the diagnostic request.

Profiles contain explicit browser, locale, IANA timezone, viewport and optional User-Agent. Browser results report values actually applied by the installed engine. Plain Go HTTP uses supported language/User-Agent headers; it does not apply viewport, device hardware, WebGL, browser JavaScript state, TLS impersonation or HTTP2 fingerprint overrides. The supplied reference `fingerprint.go` / `herocore_profile.go` generate profile data and headers only; their transport target names and preset hardware strings have not been integrated as verified runtime behavior. Country/locale settings do not establish actual exit location.

HTTP and browser sessions have separate Cookie stores; selecting the same logical session does not currently synchronize a browser login into Go HTTP. Cookie domain rules still apply. `session.persist:true` explicitly retains compatible state within this server process under the stable project/session/configuration identity. Idle saved sessions expire after 30 minutes and service restart loses them; concurrent runs cannot claim the same saved session. HTTP saved-session storage is bounded at 64; browser contexts are separately bounded at 4 by default. Temporary browser contexts close at run completion/cancellation. A loop requesting a fresh session does not reuse an explicitly retained session.

### Scoped real-browser handoff

Browser execution is lazy and requires Node.js 20+, `scripts/package-lock.json` dependencies and the selected Playwright browser. Installing Chromium does not install Firefox/WebKit. Missing dependencies, a closed browser, a timeout or an unsupported operation is an explicit execution error; no placeholder result is treated as success. The existing Go-only Docker image does not install the browser runtime; see `scripts/BROWSER_RUNTIME.md`.

During `browserVerification`, `pendingInput` includes a random 48-character `browserSessionId` and same-origin `viewUrl`. The view ID is valid only for that human handoff and rotates on the next one. There is no endpoint listing available browser sessions. Requests after resume/close return 404. A worker-side handoff token also rejects late remote input after the handoff ends.

- `GET /api/browser/sessions/{id}/view` returns `{image:string,mimeType:'image/jpeg',url:string,title:string,viewport:{width:number;height:number}}`; `image` is base64 of a real viewport screenshot.
- `POST /api/browser/sessions/{id}/action` accepts one of `{action:'click',x,y}`, `{action:'type',text}`, `{action:'press',key}`, `{action:'scroll',deltaY}` or `{action:'navigate',url}`. Returns JSON after the operation; failures retain a specific ordinary error response. Text is limited to 16384 characters, coordinates and scrolling are bounded, and navigate applies the usual destination guard. Cross-site action requests are rejected.
- Workflow resume continues through `/api/flow/jobs/{id}/resume`, not through the browser endpoint. It does not replay preceding steps.

Every browser HTTP(S) connection uses an authenticated loopback proxy that dials only NetworkGuard-checked literal target IPs, optionally through the configured authenticated upstream proxy. The browser context keeps the original engine transport and supported configuration; it does not inject stealth patches or solve verification challenges. Popups and downloads are currently closed/cancelled rather than supported. The UI polls real screenshots, scales mouse coordinates to the actual viewport, and queues normal input actions.

## Flow tasks, events and results

- `POST /api/flow/jobs` accepts `Flow` → 202 `FlowJobView`, initially containing reachable `pending` events. Invalid flow → 400 `FlowValidation`.
- `GET /api/flow/jobs/{id}?after={seq}` → `FlowJobView` with only events newer than `seq`. Omitted `after` means zero; negative/noninteger values return 400. The returned `seq` is the latest sequence, including when no new events exist.
- `DELETE /api/flow/jobs/{id}` cancels the task and pending nodes. It is idempotent for terminal tasks and never restarts execution.
- `POST /api/flow/jobs/{id}/resume` accepts `{inputs:{[pendingInput.variable]:string}}`. The required key must be present; an empty string is allowed. Wrong/missing key → 400; input over 2 MiB → 413; task not waiting → 409. Success returns the updated view, then the same worker continues.
- `GET /api/flow/jobs/{id}/results/{nodeId}?executionId={executionId}` → completed `Step`, including full node result and technical error. Omit `executionId` for the most recently recorded instance of that node; use it to inspect a particular loop iteration. An unfinished/unavailable step returns 404.
- `GET /api/flow/jobs/{id}/result` → complete terminal `RunResult`; 409 until ready.
- `POST /api/flow/run` retains synchronous compatibility: accepts `Flow`, returns complete `RunResult`, or 400 `FlowValidation`. Manual nodes fail with `manual_requires_job` on this synchronous route.

```ts
type FlowJobView = {
  id:string;status:"running"|"waiting_input"|"completed"|"failed"|"cancelled";
  events:FlowEvent[];seq:number;pendingInput?:PendingInput;
  result?:RunResult;error?:string;
};
type PendingInput = {nodeId:string;variable:string;label:string;prompt:string;executionId?:string;scopePath?:string[];iteration?:number;browserSessionId?:string;viewUrl?:string};
type FlowEvent = {
  runId:string;seq:number;nodeId:string;
  executionId?:string;scopePath?:string[];iteration?:number;resourceId?:string;
  status:"pending"|"running"|"waiting_input"|"success"|"error"|"skipped"|"cancelled";
  time:string;durationMs?:number;errorCode?:string;message?:string;
};
type Step = {
  nodeId:string;label:string;kind:string;
  executionId?:string;scopePath?:string[];iteration?:number;resourceId?:string;
  status:"success"|"error"|"skipped"|"cancelled";
  durationMs:number;result:any;error?:string;errorCode?:string;
};
type RunResult = {
  status:"success"|"error"|"cancelled";steps:Step[];
  variables:Record<string,any>|null;output:any;
};
```

Events have strictly increasing sequence numbers and UTC timestamps; running events come from actual execution. Nested/loop events identify their execution instance, region path and one-based iteration instead of overwriting all rounds by node ID. Proxy failures can also identify the resource block. Polling terminal `result` contains only status and step metadata: step `result`, variables and output are null. Fetch `/result` once for full output/variables, or a single execution-instance detail on demand. Runtime event messages and polling summaries use safe error text; complete diagnostic URLs are available only in explicitly requested details. Keep runtime state separate from project design/export data.

Each run takes an immutable copy of nodes, edges, headers and inputs. Canvas edits affect the next run. Asynchronous flow lifetime is at most 10 minutes including manual waits; synchronous lifetime is 120 seconds. Both APIs share two active slots. Cancellation marks the view immediately but retains its slot until the actual worker exits, and a late response cannot overwrite cancellation. Terminal results last 15 minutes, at most 128 tasks. Storage is memory-only and restarts lose task IDs/results.

## Network and resource limits

Replay HTTP total timeout is 25 seconds per request; response-header timeout is 20 seconds; connect/TLS timeout is 10 seconds. At most eight redirects are followed, HTTPS-to-HTTP downgrade is denied, TLS is 1.2 or newer and no environment proxy is used. All DNS answers and the concrete dial address are checked against the guard, including redirects and DNS rebinding. Private, loopback, link-local, metadata and reserved destinations are blocked for replay. An explicitly configured local model provider is allowed by the separate Agent guard, while metadata destinations remain blocked.

Request/rendered fields and manual/input values are limited to 2 MiB. A replay response is limited to 2 MiB and total flow response bodies to 8 MiB; retained execution-result JSON has an additional 8 MiB aggregate budget. These limits include loop iterations. Aggregate JSON/query substitution expansion is bounded. Browser actions have their own bounded timeouts and context capacity, and screenshots are viewport-sized. No external business request occurs during HAR parsing, preflight or ordinary canvas editing; explicit Agent calls contact the configured provider and explicit proxy testing contacts its diagnostic target.

## Serving and delivery

The Go server serves `web/dist` with SPA fallback, default `127.0.0.1:8090`; flags include `-addr`, `-web`, `-sample-har` and `-require-auth`. Public binding must be selected explicitly. The executable sets 10-second read-header timeout, 5-minute read/write timeouts and 60-second HTTP idle timeout. Vite development proxies `/api` to 8090. Deployment, commits and remote changes require the user's corresponding instruction; local implementation and tests do not deploy anything.
