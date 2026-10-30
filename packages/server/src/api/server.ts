import { createReadStream, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { SiteSettingsInfo, StreamMessage } from '@site-capture/shared';
import type { Store } from '../db/store.js';
import type { JobManager } from '../jobs/job-manager.js';
import { dataRoot } from '../paths.js';
import { BUILTIN_PRESETS, findSiteSettings } from '../presets/index.js';
import type { SiteSettings } from '../capture/types.js';
import { crawlDetail, crawlSummary, pageItems } from './dto.js';
import { parseCrawlSettings, ValidationError } from './validate.js';

// 設計書 8章「API」。画面（packages/web）のビルド結果があれば、それも配信する

export type ServerOptions = {
  store: Store;
  jobs: JobManager;
  port: number;
  webDistDir?: string;
  sseHeartbeatMs?: number;
};

export async function buildServer(opts: ServerOptions): Promise<FastifyInstance> {
  const { store, jobs } = opts;
  const app = Fastify({ logger: false });

  // 自分のPCのブラウザから 127.0.0.1 / localhost として来た要求だけを受け付ける。
  // 悪意のあるサイトが DNS を書き換えてこの API を呼ぶ攻撃（DNS リバインディング）を防ぐため
  const allowedHosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`]);
  app.addHook('onRequest', async (req, reply) => {
    if (!allowedHosts.has(req.headers.host ?? '')) return reply.code(403).send({ error: 'このアドレスからは利用できません' });
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ValidationError) return reply.code(400).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    const message = err instanceof Error ? err.message : String(err);
    return reply.code(status).send({ error: status === 500 ? 'サーバーでエラーが起きました' : message });
  });

  const crawlOr404 = (id: number) => store.getCrawl(id);

  app.get('/api/crawls', async () => store.listCrawls().map((row) => crawlSummary(row, store)));

  app.post('/api/crawls', async (req, reply) => {
    const settings = parseCrawlSettings(req.body);
    const { crawlId } = await jobs.start(settings);
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

  app.get('/api/site-settings', async () => BUILTIN_PRESETS.map(siteInfo));

  // 撮影開始画面で、入力されたURLに合うサイト設定（プリセット）を示すため
  app.get<{ Querystring: { url?: string } }>('/api/site-settings/match', async (req, reply) => {
    try {
      return siteInfo(findSiteSettings(new URL(req.query.url ?? '').href));
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

function siteInfo(s: SiteSettings): SiteSettingsInfo {
  return {
    name: s.name,
    hostPatterns: s.hostPatterns,
    reloadPerViewport: s.reloadPerViewport,
    concurrency: s.concurrency ?? null,
    intervalMs: s.intervalMs ?? null,
  };
}
