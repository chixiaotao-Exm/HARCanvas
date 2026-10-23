import type { Edge, Node } from '@xyflow/react';
export type Kind = 'input' | 'request' | 'extract' | 'condition' | 'output';
export type BlockData = {
  kind: Kind; label: string; description?: string; requestId?: string; method?: string; url?: string;
  headers?: Record<string, string>; body?: string; variable?: string; value?: string; source?: string;
  path?: string; operator?: string; expected?: string; template?: string;
};
export type FlowNode = Node<BlockData, 'block'>;
export type FlowEdge = Edge;
export type HarRequest = { id: string; method: string; url: string; domain: string; path: string; category: string; mimeType: string; status: number; duration: number; headers: Record<string,string>; body: string; responseBody: string; responseHeaders: Record<string,string>; query: Record<string,string>; responseBodyTruncated?: boolean; responseBodyBytes?: number };
export type Suggestion = {requestId:string; label:string; description:string; category:string; dependencies:string[]; confidence:string; variables:{name:string;source:string;description:string}[]};
export type Analysis = {summary:string; suggestions:Suggestion[]; warnings:string[]};
export type AgentConfig = {baseUrl:string;apiKey:string;model:string};
export type RunResult = { status: 'success'|'error'; steps:{nodeId:string;label:string;kind:Kind;status:'success'|'error'|'skipped';durationMs:number;result:unknown;error?:string}[];variables:Record<string,unknown>;output:unknown };
export type HarSummary = {total:number;api:number;static:number;domains:string[]};
