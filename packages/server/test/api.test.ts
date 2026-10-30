import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { chromium } from 'playwright';
import type { CrawlDetail, CrawlSummary, PageItem, StreamMessage } from '@site-capture/shared';
import { buildServer } from '../src/api/server.js';
import { Store } from '../src/db/store.js';
import { JobManager } from '../src/jobs/job-manager.js';
import { startSiteServer } from './helpers/site-server.js';

// API の結合テスト。テスト用サイトに対して実際に撮影を走らせる

let home: string;
let store: Store;
let jobs: JobManager;
let app: FastifyInstance;
let port: number;
let site: Awaited<ReturnType<typeof startSiteServer>>;
let base: string;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'site-capture-api-'));
  process.env.SITE_CAPTURE_HOME = home;
  store = new Store(join(home, 'test.db'));
  jobs = new JobManager(store, () => chromium.launch());
  port = await freePort();
  app = await buildServer({ store, jobs, port, sseHeartbeatMs: 200 });
  await app.listen({ host: '127.0.0.1', port });
  base = `http://127.0.0.1:${port}`;
  site = await startSiteServer();
});

after(async () => {
  await jobs.shutdown();
  await app.close();
  store.close();
  await site.close();
  await rm(home, { recursive: true, force: true });
  delete process.env.SITE_CAPTURE_HOME;
});

// テストを速く終えるための撮影設定
function fastSettings(extra: Record<string, unknown> = {}) {
  return {
    startUrl: `${site.origin}/`,
    viewports: [800],
    intervalMs: 0,
    useSitemap: false,
    capture: { quietWindowMs: 200, maxWaitMs: 3000, extraWaitMs: 0 },
    ...extra,
  };
}

async function api<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    // 本文がないのに JSON の content-type を付けると Fastify が 400 を返すので、本文があるときだけ付ける
    headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...(init?.headers ?? {}) },
  });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, body: (type.includes('json') ? await res.json() : await res.arrayBuffer()) as T };
}

async function waitUntilFinished(id: number): Promise<CrawlDetail> {
  for (let i = 0; i < 300; i++) {
    const { body } = await api<CrawlDetail>(`/api/crawls/${id}`);
    if (!['queued', 'running'].includes(body.status) && !jobs.isRunning(id)) return body;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('撮影が終わりませんでした');
}

test('外部のホスト名で来た要求は断る', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/crawls', headers: { host: 'evil.example:4310' } });
  assert.equal(res.statusCode, 403);
});

test('撮影設定の誤りは 400 と日本語のメッセージで返す', async () => {
  const cases: Array<[unknown, RegExp]> = [
    [{}, /URLを入力/],
    [{ startUrl: 'ftp://example.com/' }, /http または https/],
    [{ startUrl: 'not a url' }, /形式/],
    [{ startUrl: 'https://example.com/', viewports: [] }, /画面幅を1つ以上/],
    [{ startUrl: 'https://example.com/', viewports: [100] }, /200〜3840/],
    [{ startUrl: 'https://example.com/', maxPages: 0 }, /最大ページ数/],
  ];
  for (const [body, message] of cases) {
    const r = await api<{ error: string }>('/api/crawls', { method: 'POST', body: JSON.stringify(body) });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error, message);
  }
});

test('撮影を始め、進捗を SSE で受け取り、結果のページと画像を取得できる', async () => {
  const created = await api<CrawlDetail>('/api/crawls', {
    method: 'POST',
    body: JSON.stringify(fastSettings({ maxPages: 4 })),
  });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal(created.body.siteSettingsName, '標準');

  // SSE: 最初に snapshot、その後に撮影のイベントが届き、crawl-finished で終わる
  const messages: StreamMessage[] = [];
  const controller = new AbortController();
  const res = await fetch(`${base}/api/crawls/${id}/events`, { signal: controller.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (!messages.some((m) => m.type === 'crawl-finished')) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (const chunk of buffer.split('\n\n').slice(0, -1)) {
      const line = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (line) messages.push(JSON.parse(line.slice(6)) as StreamMessage);
    }
    buffer = buffer.slice(buffer.lastIndexOf('\n\n') + 2);
  }
  controller.abort();
  assert.equal(messages[0]!.type, 'snapshot');
  assert.ok(messages.some((m) => m.type === 'page-done'));

  const finished = await waitUntilFinished(id);
  assert.equal(finished.status, 'done');
  assert.equal(finished.counts.done, 4);
  assert.ok(finished.thumbUrl);

  const pages = await api<PageItem[]>(`/api/crawls/${id}/pages`);
  const done = pages.body.filter((p) => p.status === 'done');
  assert.equal(done.length, 4);
  assert.equal(done[0]!.path, '/');
  const shot = done[0]!.shots[0]!;
  assert.equal(shot.viewportWidth, 800);

  const image = await fetch(`${base}${shot.imageUrl}`);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.ok((await image.arrayBuffer()).byteLength > 1000);
  const thumb = await fetch(`${base}${shot.thumbUrl}`);
  assert.equal(thumb.headers.get('content-type'), 'image/webp');

  const list = await api<CrawlSummary[]>('/api/crawls');
  assert.ok(list.body.some((c) => c.id === id && c.counts.done === 4));
});

test('撮影中は止められ、削除は止めてからでないとできない。削除すると画像のフォルダも消える', async () => {
  const created = await api<CrawlDetail>('/api/crawls', { method: 'POST', body: JSON.stringify(fastSettings()) });
  const id = created.body.id;
  assert.equal((await api(`/api/crawls/${id}`, { method: 'DELETE' })).status, 409);
  assert.equal((await api(`/api/crawls/${id}/stop`, { method: 'POST' })).status, 200);
  const stopped = await waitUntilFinished(id);
  assert.equal(stopped.status, 'stopped');
  assert.equal((await api(`/api/crawls/${id}/stop`, { method: 'POST' })).status, 409);

  assert.ok(stopped.outputDir.startsWith(home));
  assert.equal((await api(`/api/crawls/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await api(`/api/crawls/${id}`)).status, 404);
  assert.ok(!existsSync(stopped.outputDir));
});

test('URL に合うサイト設定を返す', async () => {
  const notion = await api<{ name: string; intervalMs: number }>(
    `/api/site-settings/match?url=${encodeURIComponent('https://acme.notion.site/page')}`,
  );
  assert.equal(notion.body.name, 'Notion（公開ページ）');
  assert.equal(notion.body.intervalMs, 30000);
  const other = await api<{ name: string }>(`/api/site-settings/match?url=${encodeURIComponent('https://example.com/')}`);
  assert.equal(other.body.name, '標準');
});
