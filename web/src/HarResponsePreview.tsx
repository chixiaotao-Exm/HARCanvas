import { useState } from 'react';
import type { HarRequest } from './types';
import './HarResponsePreview.css';

export default function HarResponsePreview({ request, defaultExample }: { request: HarRequest; defaultExample: boolean }) {
  const [fullBody, setFullBody] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  async function readFullResponse() {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`/api/har/example/requests/${encodeURIComponent(request.id)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : '无法读取完整响应。');
      const original = data.request;
      if (!original || original.id !== request.id || original.url !== request.url || typeof original.responseBody !== 'string') throw new Error('默认测试包已变化，请重新载入后查看。');
      setFullBody(original.responseBody);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setLoading(false);
    }
  }
  return <details className="har-response-preview">
    <summary>HAR 参考响应{request.responseBodyTruncated && fullBody === null ? ' · 预览' : ''}</summary>
    <p>录制时的响应，仅供分析参考。</p>
    {request.responseBodyTruncated && fullBody === null && <>
      <p className="har-preview-limit">当前显示前 64 KiB，完整响应约 {Math.ceil((request.responseBodyBytes ?? 0) / 1024).toLocaleString()} KiB。原始 HAR 保持完整。</p>
      {defaultExample && <button type="button" onClick={() => void readFullResponse()} disabled={loading}>{loading ? '正在读取…' : '读取完整响应'}</button>}
    </>}
    {error && <p role="alert">{error}</p>}
    <pre>{(fullBody ?? request.responseBody) || '（HAR 未包含响应正文）'}</pre>
  </details>;
}
