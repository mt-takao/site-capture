import { createReadStream, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import fastifyStatic from '@fastify/static';
import { ZipArchive } from 'archiver';
import Fastify, { type FastifyInstance } from 'fastify';
import type { CrawlSettings, StreamMessage } from '@site-capture/shared';
import type { Store } from '../db/store.js';
import { authProfileItem, deleteAuthProfile, LoginSessionError, type LoginSessionManager } from '../auth/login-sessions.js';
import { StartCrawlError, type JobManager } from '../jobs/job-manager.js';
import { dataRoot } from '../paths.js';
import { pagesCsv } from '../export/csv.js';
import { allSiteSettings, findSiteSettings } from '../presets/index.js';
import { compareCrawls, crawlDetail, crawlSummary, pageItems } from './dto.js';
import { parseBasicAuth, parseCrawlSettings, parseSiteSettings, ValidationError } from './validate.js';

// 設計書 8章「API」。画面（packages/web）のビルド結果があれば、それも配信する

export type ServerOptions = {
  store: Store;
  jobs: JobManager;
  logins: LoginSessionManager;
  port: number;
  webDistDir?: string;
  sseHeartbeatMs?: number;
};

export async function buildServer(opts: ServerOptions): Promise<FastifyInstance> {
  const { store, jobs, logins } = opts;
  const app = Fastify({ logger: false });

  // 自分のPCのブラウザから 127.0.0.1 / localhost として来た要求だけを受け付ける。
  // 悪意のあるサイトが DNS を書き換えてこの API を呼ぶ攻撃（DNS リバインディング）を防ぐため
  const allowedHosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`]);
  app.addHook('onRequest', async (req, reply) => {
    if (!allowedHosts.has(req.headers.host ?? '')) return reply.code(403).send({ error: 'このアドレスからは利用できません' });
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ValidationError || err instanceof StartCrawlError || err instanceof LoginSessionError) {
      return reply.code(400).send({ error: err.message });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    const message = err instanceof Error ? err.message : String(err);
    return reply.code(status).send({ error: status === 500 ? 'サーバーでエラーが起きました' : message });
  });

  const crawlOr404 = (id: number) => store.getCrawl(id);

  app.get('/api/crawls', async () => store.listCrawls().map((row) => crawlSummary(row, store)));

  app.post('/api/crawls', async (req, reply) => {
    const settings = parseCrawlSettings(req.body);
    const basicAuth = parseBasicAuth(req.body);
    settings.usesBasicAuth = !!basicAuth;
    const { crawlId } = await jobs.start(settings, { basicAuth });
    return reply.code(201).send(crawlDetail(store.getCrawl(crawlId)!, store));
  });

  app.get<{ Params: { id: string } }>('/api/crawls/:id', async (req, reply) => {
    const row = crawlOr404(Number(req.params.id));
    if (!row) return reply.code(404).send({ error: '撮影セッションが見つかりません' });
    return crawlDetail(row, store);
  });

  app.get<{ Params: { id: string } }>('/api/crawls/:id/pages', async (req, reply) => {
    const id = Number(req.params.id);
    if (!crawlOr404(id)) return reply.code(404).send({ error: '撮影セッションが見つかりません' });
    return pageItems(id, store);
  });

  // S-08: 失敗したページと、止めたときに残った撮影待ちのページを撮り直す
  app.post<{ Params: { id: string } }>('/api/crawls/:id/retry', async (req, reply) => {
    const id = Number(req.params.id);
    if (!crawlOr404(id)) return reply.code(404).send({ error: '撮影セッションが見つかりません' });
    if (jobs.isRunning(id)) return reply.code(409).send({ error: 'この撮影は実行中です' });
    await jobs.retry(id, { basicAuth: parseBasicAuth(req.body ?? null) });
    return crawlDetail(store.getCrawl(id)!, store);
  });

  // V-07: ページ一覧の CSV
  app.get<{ Params: { id: string } }>('/api/crawls/:id/export.csv', async (req, reply) => {
    const row = crawlOr404(Number(req.params.id));
    if (!row) return reply.code(404).send({ error: '撮影セッションが見つかりません' });
    const widths = (JSON.parse(row.settings_json) as CrawlSettings).viewports;
    const csv = pagesCsv(pageItems(row.id, store), widths, (shotId) => store.getShot(shotId)?.file_path);
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', attachment(`${exportName(row)}.csv`))
      .send(csv);
  });

  // V-06: 画像をまとめた ZIP。ページ一覧の CSV も入れる
  app.get<{ Params: { id: string } }>('/api/crawls/:id/export.zip', async (req, reply) => {
    const row = crawlOr404(Number(req.params.id));
    if (!row) return reply.code(404).send({ error: '撮影セッションが見つかりません' });
    const name = exportName(row);
    const widths = (JSON.parse(row.settings_json) as CrawlSettings).viewports;
    const shots = store.listShotsForCrawl(row.id).filter((s) => existsSync(s.file_path));
    const zip = new ZipArchive({ zlib: { level: 1 } }); // PNG はもう圧縮されているので、速さを優先する
    for (const s of shots) zip.file(s.file_path, { name: `${name}/${s.file_path.split(sep).at(-1)}` });
    zip.append(pagesCsv(pageItems(row.id, store), widths, (shotId) => store.getShot(shotId)?.file_path), { name: `${name}/pages.csv` });
    void zip.finalize();
    return reply.type('application/zip').header('content-disposition', attachment(`${name}.zip`)).send(zip);
  });

  app.post<{ Params: { id: string } }>('/api/crawls/:id/stop', async (req, reply) => {
    const id = Number(req.params.id);
    if (!crawlOr404(id)) return reply.code(404).send({ error: '撮影セッションが見つかりません' });
    if (!jobs.stop(id)) return reply.code(409).send({ error: 'この撮影は実行中ではありません' });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/crawls/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const row = crawlOr404(id);
    if (!row) return reply.code(404).send({ error: '撮影セッションが見つかりません' });
    if (jobs.isRunning(id)) return reply.code(409).send({ error: '撮影中は削除できません。先に停止してください' });
    store.deleteCrawl(id);
    // 念のため、保存先が ~/SiteCapture/captures の中にある場合だけフォルダを消す
    const capturesRoot = resolve(dataRoot(), 'captures') + sep;
    const dir = resolve(row.output_dir);
    if (dir.startsWith(capturesRoot)) await rm(dir, { recursive: true, force: true });
    return { ok: true };
  });

  // 進捗の通知（SSE）。つないだ直後に現在の状態を送り、その後は撮影のイベントを送る（設計書 8.1）
  app.get<{ Params: { id: string } }>('/api/crawls/:id/events', async (req, reply) => {
    const id = Number(req.params.id);
    const row = crawlOr404(id);
    if (!row) return reply.code(404).send({ error: '撮影セッションが見つかりません' });
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (m: StreamMessage) => res.write(`data: ${JSON.stringify(m)}\n\n`);
    send({ type: 'snapshot', crawl: crawlDetail(row, store) });
    const unsubscribe = jobs.subscribe(id, (e) => {
      send(e);
      if (e.type === 'crawl-finished') {
        const latest = store.getCrawl(id);
        if (latest) send({ type: 'snapshot', crawl: crawlDetail(latest, store) });
      }
    });
    const heartbeat = setInterval(() => res.write(': ping\n\n'), opts.sseHeartbeatMs ?? 15000);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // 画像とサムネイル。ファイルパスではなく画像の ID で指定させる
  for (const kind of ['image', 'thumb'] as const) {
    app.get<{ Params: { id: string } }>(`/api/shots/:id/${kind}`, async (req, reply) => {
      const shot = store.getShot(Number(req.params.id));
      const path = shot ? (kind === 'image' ? shot.file_path : shot.thumb_path) : null;
      if (!path || !existsSync(path)) return reply.code(404).send({ error: '画像が見つかりません' });
      return reply
        .type(kind === 'image' ? 'image/png' : 'image/webp')
        .header('cache-control', 'private, max-age=3600')
        .send(createReadStream(path));
    });
  }

  // V-05b: 2つの撮影結果のページの対応表
  app.get<{ Querystring: { a?: string; b?: string } }>('/api/compare', async (req, reply) => {
    const a = store.getCrawl(Number(req.query.a));
    const b = store.getCrawl(Number(req.query.b));
    if (!a || !b) return reply.code(404).send({ error: '比べる撮影セッションが見つかりません' });
    if (a.id === b.id) return reply.code(400).send({ error: '別々の撮影を2つ選んでください' });
    return compareCrawls(a, b, store);
  });

  // ---- ログイン（設計書 7章） ----

  app.get('/api/auth-profiles', async () => store.listAuthProfiles().map(authProfileItem));

  app.delete<{ Params: { id: string } }>('/api/auth-profiles/:id', async (req, reply) => {
    if (!(await deleteAuthProfile(store, req.params.id))) return reply.code(404).send({ error: 'ログイン状態が見つかりません' });
    return { ok: true };
  });

  // ログイン用ブラウザを開く（画面ありのブラウザが利用者のPCに表示される）
  app.post<{ Body: { name?: string; url?: string } }>('/api/auth-profiles/sessions', async (req, reply) => {
    const session = await logins.open(String(req.body?.name ?? ''), String(req.body?.url ?? ''));
    return reply.code(201).send(session);
  });

  app.get<{ Params: { sid: string } }>('/api/auth-profiles/sessions/:sid', async (req, reply) => {
    const session = logins.get(req.params.sid);
    if (!session) return reply.code(404).send({ error: 'ログイン用ブラウザが見つかりません' });
    return session;
  });

  app.post<{ Params: { sid: string } }>('/api/auth-profiles/sessions/:sid/save', async (req, reply) => {
    return reply.code(201).send(await logins.save(req.params.sid));
  });

  app.delete<{ Params: { sid: string } }>('/api/auth-profiles/sessions/:sid', async (req) => {
    await logins.close(req.params.sid);
    return { ok: true };
  });

  // ---- サイト設定（S-05, J-02, J-03, J-07）。組み込みのプリセットは編集・削除できない ----

  app.get('/api/site-settings', async () => allSiteSettings(store));

  app.post('/api/site-settings', async (req, reply) => reply.code(201).send(store.createSiteSettings(parseSiteSettings(req.body))));

  app.put<{ Params: { id: string } }>('/api/site-settings/:id', async (req, reply) => {
    if (req.params.id.startsWith('builtin:')) return reply.code(400).send({ error: '組み込みのサイト設定は編集できません。複製して編集してください' });
    const updated = store.updateSiteSettings(req.params.id, parseSiteSettings(req.body));
    if (!updated) return reply.code(404).send({ error: 'サイト設定が見つかりません' });
    return updated;
  });

  app.delete<{ Params: { id: string } }>('/api/site-settings/:id', async (req, reply) => {
    if (req.params.id.startsWith('builtin:')) return reply.code(400).send({ error: '組み込みのサイト設定は削除できません' });
    if (!store.deleteSiteSettings(req.params.id)) return reply.code(404).send({ error: 'サイト設定が見つかりません' });
    return { ok: true };
  });

  // 撮影開始画面で、入力されたURLに合うサイト設定を示すため
  app.get<{ Querystring: { url?: string } }>('/api/site-settings/match', async (req, reply) => {
    try {
      const all = allSiteSettings(store);
      return findSiteSettings(new URL(req.query.url ?? '').href, all.slice(0, -1));
    } catch {
      return reply.code(400).send({ error: 'URLの形式が正しくありません' });
    }
  });

  if (opts.webDistDir && existsSync(join(opts.webDistDir, 'index.html'))) {
    // wildcard: true にして、起動後にビルドし直したファイル（名前にハッシュが付く）も配信できるようにする
    await app.register(fastifyStatic, { root: opts.webDistDir, wildcard: true });
    // 画面のURL（/crawls/1 など）を直接開いても index.html を返す
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: '見つかりません' });
    });
  }

  return app;
}

// 書き出すファイルの名前。例: example.com_20261030-1033
function exportName(row: { start_url: string; created_at: string }): string {
  const d = new Date(row.created_at);
  const p = (n: number) => String(n).padStart(2, '0');
  const host = new URL(row.start_url).host.replace(/[^a-z0-9.-]/gi, '-');
  return `${host}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function attachment(filename: string): string {
  return `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
