import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { chromium } from 'playwright';
import type { AuthProfileItem, CompareResult, SiteSettingsItem, CrawlDetail, CrawlEvent, CrawlSummary, LoginSessionInfo, PageItem, StreamMessage } from '@site-capture/shared';
import { LoginSessionManager } from '../src/auth/login-sessions.js';
import { buildServer } from '../src/api/server.js';
import { Store } from '../src/db/store.js';
import { JobManager } from '../src/jobs/job-manager.js';
import { startSiteServer } from './helpers/site-server.js';

// API の結合テスト。テスト用サイトに対して実際に撮影を走らせる

let home: string;
let store: Store;
let jobs: JobManager;
let logins: LoginSessionManager;
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
  // テストではログイン用ブラウザも画面なしで起動する
  logins = new LoginSessionManager(store, () => chromium.launch());
  port = await freePort();
  app = await buildServer({ store, jobs, logins, port, sseHeartbeatMs: 200 });
  await app.listen({ host: '127.0.0.1', port });
  base = `http://127.0.0.1:${port}`;
  site = await startSiteServer();
});

after(async () => {
  await logins.closeAll();
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

// ---- ログイン（M4） ----

async function crawlAndWait(body: Record<string, unknown>) {
  const created = await api<CrawlDetail & { error?: string }>('/api/crawls', { method: 'POST', body: JSON.stringify(body) });
  assert.equal(created.status, 201, created.body.error ?? "");
  const events: CrawlEvent[] = [];
  jobs.subscribe(created.body.id, (e) => events.push(e));
  const detail = await waitUntilFinished(created.body.id);
  const pages = (await api<PageItem[]>(`/api/crawls/${created.body.id}/pages`)).body;
  return { detail, pages, events };
}

test('ログイン用ブラウザでログインした状態を保存し、その状態で会員ページを撮れる', async () => {
  const opened = await api<LoginSessionInfo>('/api/auth-profiles/sessions', {
    method: 'POST',
    body: JSON.stringify({ name: 'テスト会員', url: `${site.origin}/login` }),
  });
  assert.equal(opened.status, 201);
  assert.equal(opened.body.status, 'open');
  // 利用者が手でログインした結果を、Cookie を入れて再現する
  await logins.contextOf(opened.body.id)!.addCookies([{ name: 'session', value: 'ok', url: site.origin }]);

  const saved = await api<AuthProfileItem>(`/api/auth-profiles/sessions/${opened.body.id}/save`, { method: 'POST' });
  assert.equal(saved.status, 201);
  assert.equal(saved.body.name, 'テスト会員');
  assert.equal(saved.body.origin, site.origin);
  assert.equal((await api(`/api/auth-profiles/sessions/${opened.body.id}`)).status, 404);

  // ファイルは本人だけが読み書きでき、フォルダは本人だけが開ける。中身にパスワードはなく Cookie だけ
  const row = store.getAuthProfile(saved.body.id)!;
  assert.equal((await stat(row.storage_state_path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(home, 'auth'))).mode & 0o777, 0o700);
  assert.match(await readFile(row.storage_state_path, 'utf8'), /"name":\s*"session"/);
  const list = await api<AuthProfileItem[]>('/api/auth-profiles');
  assert.ok(list.body.some((p) => p.id === saved.body.id));

  const r = await crawlAndWait(fastSettings({ startUrl: `${site.origin}/members`, authProfileId: saved.body.id, maxPages: 3 }));
  const done = r.pages.filter((p) => p.status === 'done').map((p) => p.title).sort();
  assert.deepEqual(done, ['会員ページ', '会員情報']);
  assert.equal(r.detail.authProfileName, 'テスト会員');
  assert.ok(!r.events.some((e) => e.type === 'warning'));
  assert.ok(store.getAuthProfile(saved.body.id)!.last_used_at);

  // 削除するとファイルも消える
  assert.equal((await api(`/api/auth-profiles/${saved.body.id}`, { method: 'DELETE' })).status, 200);
  assert.ok(!existsSync(row.storage_state_path));
  assert.equal((await api(`/api/auth-profiles/${saved.body.id}`, { method: 'DELETE' })).status, 404);
});

test('ログインせずに会員ページを撮ると、ログイン画面に転送されたことを警告する', async () => {
  const r = await crawlAndWait(fastSettings({ startUrl: `${site.origin}/members`, maxPages: 1 }));
  const warning = r.events.find((e) => e.type === 'warning');
  assert.ok(warning && warning.type === 'warning' && warning.message.includes('ログイン画面'));
  // 警告はデータベースにも残り、撮影が終わった後も見られる
  assert.ok(r.detail.warnings.some((w) => w.includes('ログイン画面')));
  assert.equal(r.pages[0]!.title, 'ログイン');
});

test('ブラウザを閉じた後は保存できず、分かるメッセージを返す', async () => {
  const opened = await api<LoginSessionInfo>('/api/auth-profiles/sessions', {
    method: 'POST',
    body: JSON.stringify({ name: '閉じる', url: `${site.origin}/login` }),
  });
  await logins.contextOf(opened.body.id)!.browser()!.close();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await api<LoginSessionInfo>(`/api/auth-profiles/sessions/${opened.body.id}`)).body.status, 'closed');
  const saved = await api<{ error: string }>(`/api/auth-profiles/sessions/${opened.body.id}/save`, { method: 'POST' });
  assert.equal(saved.status, 400);
  assert.match(saved.body.error, /閉じられた/);
});

test('ログイン用ブラウザの入力の誤りと、存在しないログイン状態の指定は 400 にする', async () => {
  const noName = await api<{ error: string }>('/api/auth-profiles/sessions', { method: 'POST', body: JSON.stringify({ name: ' ', url: site.origin }) });
  assert.equal(noName.status, 400);
  const badUrl = await api<{ error: string }>('/api/auth-profiles/sessions', { method: 'POST', body: JSON.stringify({ name: 'x', url: 'ftp://x' }) });
  assert.equal(badUrl.status, 400);
  const missing = await api<{ error: string }>('/api/crawls', { method: 'POST', body: JSON.stringify(fastSettings({ authProfileId: 'nope' })) });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /ログイン状態が見つかりません/);
});

test('Basic 認証の ID とパスワードは撮影に使うが、保存しない', async () => {
  const withAuth = await crawlAndWait(
    fastSettings({ startUrl: `${site.origin}/basic`, maxPages: 1, basicAuth: { username: 'user', password: 'pass' } }),
  );
  assert.equal(withAuth.pages[0]!.httpStatus, 200);
  assert.equal(withAuth.pages[0]!.title, 'Basic認証のページ');
  const row = store.getCrawl(withAuth.detail.id)!;
  assert.ok(!row.settings_json.includes('basicAuth'));
  assert.equal(withAuth.detail.settings.usesBasicAuth, true);
  assert.ok(!row.settings_json.includes('pass"'));

  const without = await crawlAndWait(fastSettings({ startUrl: `${site.origin}/basic`, maxPages: 1 }));
  assert.equal(without.pages[0]!.httpStatus, 401);
});

// ---- 比較（M5） ----

test('2つの撮影結果をパスで組み合わせ、両方にある・追加・削除に分ける', async () => {
  // A はトップだけ、B はトップから1階層まで撮る。B は画面幅を2つにする
  const a = await crawlAndWait(fastSettings({ maxDepth: 0 }));
  const b = await crawlAndWait(fastSettings({ maxDepth: 1, viewports: [800, 400] }));

  const r = await api<CompareResult>(`/api/compare?a=${a.detail.id}&b=${b.detail.id}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.commonWidths, [800]);
  const both = r.body.pairs.filter((p) => p.status === 'both').map((p) => p.key);
  const added = r.body.pairs.filter((p) => p.status === 'added').map((p) => p.key);
  assert.deepEqual(both, ['/']);
  assert.ok(added.includes('/about') && added.includes('/blog'));
  assert.ok(r.body.pairs.every((p) => p.status !== 'removed'));
  const top = r.body.pairs.find((p) => p.key === '/')!;
  assert.equal(top.a!.shots.length, 1);
  assert.equal(top.b!.shots.length, 2);

  // A と B を入れ替えると、追加が削除になる
  const swapped = await api<CompareResult>(`/api/compare?a=${b.detail.id}&b=${a.detail.id}`);
  assert.deepEqual(
    swapped.body.pairs.filter((p) => p.status === 'removed').map((p) => p.key),
    added,
  );
});

test('比較の指定が正しくなければ 404 か 400 を返す', async () => {
  assert.equal((await api('/api/compare?a=999999&b=1')).status, 404);
  const one = (await api<CrawlSummary[]>('/api/crawls')).body[0]!;
  const same = await api<{ error: string }>(`/api/compare?a=${one.id}&b=${one.id}`);
  assert.equal(same.status, 400);
  assert.match(same.body.error, /別々の撮影/);
});

// ---- 仕上げ（M6） ----

test('失敗したページだけを撮り直せる', async () => {
  const r = await crawlAndWait(
    fastSettings({ startUrl: `${site.origin}/flaky`, maxPages: 1, capture: { quietWindowMs: 200, maxWaitMs: 3000, extraWaitMs: 0, pageTimeoutMs: 2000 } }),
  );
  assert.equal(r.pages[0]!.status, 'failed');
  assert.match(r.pages[0]!.errorMessage!, /タイムアウト/);
  assert.equal(r.detail.retryableCount, 1);

  const retried = await api<CrawlDetail>(`/api/crawls/${r.detail.id}/retry`, { method: 'POST' });
  assert.equal(retried.status, 200);
  assert.equal(retried.body.id, r.detail.id);
  const after = await waitUntilFinished(r.detail.id);
  assert.equal(after.status, 'done');
  assert.equal(after.retryableCount, 0);
  assert.deepEqual([after.counts.done, after.counts.failed], [1, 0]);

  // 撮り直すものがなければ 400
  const nothing = await api<{ error: string }>(`/api/crawls/${r.detail.id}/retry`, { method: 'POST' });
  assert.equal(nothing.status, 400);
  assert.match(nothing.body.error, /撮り直すページがありません/);
});

test('止めた撮影は、残ったページを撮り直しで続きから撮れる', async () => {
  const created = await api<CrawlDetail>('/api/crawls', { method: 'POST', body: JSON.stringify(fastSettings({ maxPages: 6 })) });
  const id = created.body.id;
  await new Promise((r) => setTimeout(r, 300));
  await api(`/api/crawls/${id}/stop`, { method: 'POST' });
  const stopped = await waitUntilFinished(id);
  assert.equal(stopped.status, 'stopped');
  assert.ok(stopped.retryableCount > 0);

  await api(`/api/crawls/${id}/retry`, { method: 'POST' });
  const resumed = await waitUntilFinished(id);
  assert.equal(resumed.status, 'done');
  // 最大ページ数は撮り直しでも守られる
  assert.equal(resumed.counts.done, 6);
});

test('ページ一覧を CSV で、画像を ZIP で書き出せる', async () => {
  const r = await crawlAndWait(fastSettings({ maxPages: 3 }));
  const csvRes = await fetch(`${base}/api/crawls/${r.detail.id}/export.csv`);
  assert.match(csvRes.headers.get('content-type') ?? '', /text\/csv/);
  assert.match(csvRes.headers.get('content-disposition') ?? '', /attachment; filename="127\.0\.0\.1-\d+_\d{8}-\d{4}\.csv"/);
  // Excel 向けに先頭へ BOM（EF BB BF）を付ける。text() は BOM を取り除くので、バイト列で確かめる
  const bytes = Buffer.from(await csvRes.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const lines = bytes.subarray(3).toString('utf8').trim().split('\r\n');
  assert.match(lines[0]!, /^URL,パス,タイトル,ステータスコード,状態/);
  assert.equal(lines.length, 1 + r.pages.length);
  assert.ok(lines.some((l) => l.includes('index__800.png')));

  const zipRes = await fetch(`${base}/api/crawls/${r.detail.id}/export.zip`);
  assert.equal(zipRes.headers.get('content-type'), 'application/zip');
  const zipPath = join(home, 'export.zip');
  await writeFile(zipPath, Buffer.from(await zipRes.arrayBuffer()));
  const listing = execFileSync('unzip', ['-l', zipPath], { encoding: 'utf8' });
  assert.equal((listing.match(/\.png/g) ?? []).length, 3);
  assert.match(listing, /pages\.csv/);
});

test('サイト設定を作って編集・削除でき、組み込みより優先して選ばれる', async () => {
  const bad = await api<{ error: string }>('/api/site-settings', { method: 'POST', body: JSON.stringify({ name: 'x', hostPatterns: ['https://a.com/'] }) });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /形式が正しくありません/);
  assert.equal((await api('/api/site-settings', { method: 'POST', body: JSON.stringify({ name: 'x', hostPatterns: [] }) })).status, 400);

  const created = await api<SiteSettingsItem>('/api/site-settings', {
    method: 'POST',
    body: JSON.stringify({ name: 'テストサイト', hostPatterns: ['127.0.0.1'], hideSelectors: ['#banner', ' '], hideByText: ['閉じる'], intervalMs: 100 }),
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.hideSelectors, ['#banner']);
  assert.equal(created.body.builtin, false);

  const all = await api<SiteSettingsItem[]>('/api/site-settings');
  assert.equal(all.body[0]!.id, created.body.id);
  assert.ok(all.body.some((s) => s.id === 'builtin:notion'));

  const match = await api<SiteSettingsItem>(`/api/site-settings/match?url=${encodeURIComponent(`${site.origin}/`)}`);
  assert.equal(match.body.id, created.body.id);
  const r = await crawlAndWait(fastSettings({ maxPages: 1 }));
  assert.equal(r.detail.siteSettingsName, 'テストサイト');

  const updated = await api<SiteSettingsItem>(`/api/site-settings/${created.body.id}`, {
    method: 'PUT',
    body: JSON.stringify({ ...created.body, name: 'テストサイト2' }),
  });
  assert.equal(updated.body.name, 'テストサイト2');
  // 撮影結果には、撮ったときのサイト設定の名前が残る
  assert.equal((await api<CrawlDetail>(`/api/crawls/${r.detail.id}`)).body.siteSettingsName, 'テストサイト');

  assert.equal((await api('/api/site-settings/builtin:notion', { method: 'PUT', body: JSON.stringify(created.body) })).status, 400);
  assert.equal((await api('/api/site-settings/builtin:notion', { method: 'DELETE' })).status, 400);
  assert.equal((await api(`/api/site-settings/${created.body.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await api(`/api/site-settings/${created.body.id}`, { method: 'DELETE' })).status, 404);
});
