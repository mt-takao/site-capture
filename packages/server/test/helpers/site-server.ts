import { createServer } from 'node:http';

// 巡回のテスト用サイト。20ページほどの小さなサイトを返す
//   /                  トップ。各ページ・外部サイト・PDF・ログアウト・パラメータ付きURLへのリンク
//   /blog, /blog/post-1..8   同じ型のページが並ぶ階層（間引きの確認）
//   /private/secret    robots.txt で禁止
//   /orphan            サイトマップにだけ載っている
//   /spa               0.15秒後に JavaScript でリンクが追加される
//   /redirect          /about/ へ転送（重複として扱われる）
//   /broken            404 を返す HTML
//   /members           Cookie（session=ok）がないと /login に転送される会員ページ
//   /basic             Basic 認証（user / pass）が必要なページ
// variant 'b' は「リニューアル後」の版。比較画面の確認に使う。
//   トップの見出しと帯が変わり、/contact へのリンクがなくなり、/news が増える

export const BLOG_POSTS = 8;

function page(title: string, links: string[], extra = ''): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui;margin:24px} main{height:600px}</style></head>
<body><h1>${title}</h1><nav>${links.map((h) => `<a href="${h}">${h}</a>`).join(' ')}</nav><main></main>${extra}</body></html>`;
}

export async function startSiteServer(port = 0, variant: 'a' | 'b' = 'a'): Promise<{ origin: string; requests: string[]; close: () => Promise<void> }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    requests.push(url.pathname + url.search);
    const origin = `http://${req.headers.host}`;
    const html = (status: number, body: string) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    };
    const p = url.pathname;

    if (p === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return void res.end(`User-agent: *\nDisallow: /private/\nSitemap: ${origin}/sitemap-index.xml\n`);
    }
    if (p === '/sitemap.xml') return void res.writeHead(404).end();
    if (p === '/sitemap-index.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' });
      return void res.end(
        `<?xml version="1.0"?><sitemapindex><sitemap><loc>${origin}/sitemap-pages.xml</loc></sitemap></sitemapindex>`,
      );
    }
    if (p === '/sitemap-pages.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' });
      return void res.end(`<?xml version="1.0"?><urlset><url><loc>${origin}/orphan</loc></url><url><loc>${origin}/</loc></url></urlset>`);
    }
    if (p === '/files/doc.pdf') {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      return void res.end('%PDF-1.4');
    }
    if (p === '/members') {
      if (!/(^|;\s*)session=ok(;|$)/.test(req.headers.cookie ?? '')) {
        res.writeHead(302, { location: '/login?next=/members' });
        return void res.end();
      }
      return html(200, page('会員ページ', ['/members/profile']));
    }
    if (p === '/members/profile') {
      if (!/(^|;\s*)session=ok(;|$)/.test(req.headers.cookie ?? '')) {
        res.writeHead(302, { location: '/login?next=/members/profile' });
        return void res.end();
      }
      return html(200, page('会員情報', ['/members']));
    }
    if (p === '/login') return html(200, page('ログイン', []));
    if (p === '/basic') {
      const expected = `Basic ${Buffer.from('user:pass').toString('base64')}`;
      if (req.headers.authorization !== expected) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="test"', 'content-type': 'text/html; charset=utf-8' });
        return void res.end(page('認証が必要です', []));
      }
      return html(200, page('Basic認証のページ', []));
    }
    if (p === '/redirect') {
      res.writeHead(302, { location: '/about/' });
      return void res.end();
    }

    switch (p) {
      case '/':
        if (variant === 'b') {
          return html(200, page('トップ（リニューアル）', [
            '/about', '/company/', '/company/history', '/blog', '/news', '/spa', '/redirect', '/broken',
          ], '<div style="height:320px;margin-top:24px;background:linear-gradient(90deg,#2563eb,#7c3aed);color:#fff;font-size:40px;padding:40px">新しいサービスを始めました</div>'));
        }
        return html(200, page('トップ', [
          '/about', '/company/', '/company/history', '/blog', '/blog?page=2', '/contact#form', '/spa', '/redirect', '/broken',
          '/logout', '/files/doc.pdf', 'https://external.example.com/', 'mailto:info@example.com', '/about?utm_source=news',
        ]));
      case '/news':
        if (variant === 'b') return html(200, page('お知らせ', ['/']));
        break;
      case '/about':
      case '/about/':
        return html(200, page('会社概要', ['/', '/private/secret']));
      case '/company':
      case '/company/':
        return html(200, page('会社情報', ['/', '/company/history']));
      case '/company/history':
        return html(200, page('沿革', ['/company/']));
      case '/blog':
        return html(200, page('ブログ', Array.from({ length: BLOG_POSTS }, (_, i) => `/blog/post-${i + 1}`)));
      case '/contact':
        return html(200, page('お問い合わせ', ['/']));
      case '/spa':
        return html(200, page('SPA', ['/'], `<script>setTimeout(() => {
          const a = document.createElement('a'); a.href = '/spa/detail'; a.textContent = '詳細'; document.body.appendChild(a);
        }, 150);</script>`));
      case '/spa/detail':
        return html(200, page('SPAの詳細', ['/spa']));
      case '/orphan':
        return html(200, page('サイトマップにだけあるページ', []));
      case '/private/secret':
        return html(200, page('非公開', []));
      case '/broken':
        return html(404, page('見つかりません', ['/']));
    }
    const post = p.match(/^\/blog\/post-(\d+)$/);
    const n = post ? Number(post[1]) : 0;
    if (n >= 1 && n <= BLOG_POSTS) {
      return html(200, page(`記事 ${n}`, ['/blog', ...(n < BLOG_POSTS ? [`/blog/post-${n + 1}`] : [])]));
    }
    return html(404, page('見つかりません', []));
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : 0;
  return { origin: `http://127.0.0.1:${actualPort}`, requests, close: () => new Promise((r) => server.close(() => r())) };
}
