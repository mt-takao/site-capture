import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// test/fixtures の HTML を配信する。加えて、アクセス制限や HTML 以外の応答を返す特別なパスを持つ
const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

export async function startFixtureServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  let once429Count = 0;
  const server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    // 1回目だけ 429 を返し、2回目以降は成功する（ページ側の再送で回復する場合の確認用）
    if (path === '/api/once-429') {
      if (once429Count++ === 0) {
        res.writeHead(429, { 'retry-after': '1' });
        return void res.end('too many requests');
      }
      return void res.end('{"ok":true}');
    }
    // CSP でインラインのスタイルを禁止しているページ（撮影用の CSS を差し込めない場合の確認用）
    if (path === '/csp-strict.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "style-src 'none'" });
      return void res.end('<!doctype html><title>CSP が厳しいページ</title><h1>インラインのスタイルが禁止されたページ</h1><main style="height:1200px"></main>');
    }
    // ほかのサイト（localhost）から読み込む画像が 429 を返すページ。127.0.0.1 で開くと、localhost は別のサイトになる
    if (path === '/cross-site-429.html') {
      const port = (req.headers.host ?? '').split(':')[1];
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return void res.end(
        `<!doctype html><title>ほかのサイトの429</title><h1>ほかのサイトの画像が 429 を返すページ</h1><img src="http://localhost:${port}/api/limited" alt="">`,
      );
    }
    if (path === '/poll') return void res.end('ok');
    if (path === '/api/limited') {
      res.writeHead(429, { 'retry-after': '1' });
      return void res.end('too many requests');
    }
    if (path === '/limited-page') {
      res.writeHead(429, { 'content-type': 'text/html; charset=utf-8', 'retry-after': '2' });
      return void res.end('<!doctype html><title>429</title><h1>Too Many Requests</h1>');
    }
    if (path === '/file.pdf') {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      return void res.end('%PDF-1.4');
    }
    try {
      const body = await readFile(join(fixturesDir, path.replace(/^\//, '')));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
