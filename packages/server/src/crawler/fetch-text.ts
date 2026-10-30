import type { BrowserContext } from 'playwright';

// robots.txt とサイトマップの取得に使う。ブラウザコンテキストの通信を使うので、ログイン状態や Basic 認証が効く
export type FetchText = (url: string) => Promise<{ status: number; text: string } | null>;

export function contextFetchText(context: BrowserContext, timeoutMs = 15000): FetchText {
  return async (url) => {
    try {
      const res = await context.request.get(url, { timeout: timeoutMs, failOnStatusCode: false, maxRedirects: 5 });
      return { status: res.status(), text: await res.text() };
    } catch {
      return null;
    }
  };
}
