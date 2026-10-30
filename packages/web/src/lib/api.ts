import { useEffect, useRef, useState } from 'react';
import type {
  AuthProfileItem,
  CrawlDetail,
  CrawlEvent,
  CrawlSummary,
  LoginSessionInfo,
  PageItem,
  SiteSettingsInfo,
  StartCrawlRequest,
  StreamMessage,
} from '@site-capture/shared';

// サーバー API（設計書 8章）の呼び出し

export class ApiError extends Error {}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    // 本文がないのに JSON の content-type を付けるとサーバーが 400 を返すので、本文があるときだけ付ける
    headers: init.body ? { 'content-type': 'application/json' } : undefined,
  });
  const body = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new ApiError((body as { error?: string } | null)?.error ?? `エラーが起きました（${res.status}）`);
  return body as T;
}

export const api = {
  listCrawls: () => request<CrawlSummary[]>('/api/crawls'),
  getCrawl: (id: number) => request<CrawlDetail>(`/api/crawls/${id}`),
  listPages: (id: number) => request<PageItem[]>(`/api/crawls/${id}/pages`),
  startCrawl: (req: StartCrawlRequest) => request<CrawlDetail>('/api/crawls', { method: 'POST', body: JSON.stringify(req) }),
  stopCrawl: (id: number) => request<{ ok: true }>(`/api/crawls/${id}/stop`, { method: 'POST' }),
  deleteCrawl: (id: number) => request<{ ok: true }>(`/api/crawls/${id}`, { method: 'DELETE' }),
  matchSiteSettings: (url: string) => request<SiteSettingsInfo>(`/api/site-settings/match?url=${encodeURIComponent(url)}`),
  listAuthProfiles: () => request<AuthProfileItem[]>('/api/auth-profiles'),
  deleteAuthProfile: (id: string) => request<{ ok: true }>(`/api/auth-profiles/${id}`, { method: 'DELETE' }),
  openLoginSession: (name: string, url: string) =>
    request<LoginSessionInfo>('/api/auth-profiles/sessions', { method: 'POST', body: JSON.stringify({ name, url }) }),
  getLoginSession: (id: string) => request<LoginSessionInfo>(`/api/auth-profiles/sessions/${id}`),
  saveLoginSession: (id: string) => request<AuthProfileItem>(`/api/auth-profiles/sessions/${id}/save`, { method: 'POST' }),
  cancelLoginSession: (id: string) => request<{ ok: true }>(`/api/auth-profiles/sessions/${id}`, { method: 'DELETE' }),
};

// 撮影セッションの詳細とページ一覧を読み込み、進捗の通知（SSE）を受けて最新に保つ
export function useCrawl(id: number) {
  const [crawl, setCrawl] = useState<CrawlDetail | null>(null);
  const [pages, setPages] = useState<PageItem[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const refreshTimer = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      Promise.all([api.getCrawl(id), api.listPages(id)])
        .then(([c, p]) => {
          if (cancelled) return;
          setCrawl(c);
          setPages(p);
        })
        .catch((e: Error) => !cancelled && setError(e.message));
    };
    // イベントが続けて届くので、まとめて 0.5 秒後に読み直す
    const scheduleRefresh = () => {
      if (refreshTimer.current != null) return;
      refreshTimer.current = window.setTimeout(() => {
        refreshTimer.current = null;
        refresh();
      }, 500);
    };

    refresh();
    const source = new EventSource(`/api/crawls/${id}/events`);
    source.onmessage = (ev) => {
      const message = JSON.parse(ev.data) as StreamMessage;
      if (message.type === 'snapshot') {
        setCrawl(message.crawl);
        if (!['queued', 'running'].includes(message.crawl.status)) refresh();
        return;
      }
      if (message.type === 'warning') {
        setWarnings((w) => [...w.slice(-4), message.message]);
        return;
      }
      if (isPageEvent(message)) scheduleRefresh();
    };
    return () => {
      cancelled = true;
      source.close();
      if (refreshTimer.current != null) window.clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
    };
  }, [id]);

  return { crawl, pages, warnings, error, setCrawl };
}

function isPageEvent(e: CrawlEvent): boolean {
  return e.type !== 'warning';
}
