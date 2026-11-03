import type { Page } from 'playwright';

// 設計書 6.1 ③: 隠す要素とアニメーション停止のCSSを差し込む（S-05, S-06）。
// page.addStyleTag は使わない。差し込んだ後にページ側の読み込み完了の合図を待つ作りで、Notion では
// ページ自身の無関係なエラー（解析用通信の CSP 違反）がその失敗として返ってくることがあったため（2026-11-04）。
// 差し込めなかった・効かなかった場合は 0.3 秒待って1回だけやり直し、それでもだめなら false を返す（呼び出し側は撮影を続ける）
export async function injectCaptureStyles(
  page: Page,
  options: { hideSelectors: string[]; disableAnimations: boolean },
): Promise<boolean> {
  const rules: string[] = [];
  if (options.hideSelectors.length > 0) {
    rules.push(`${options.hideSelectors.join(',\n')} { visibility: hidden !important; }`);
  }
  if (options.disableAnimations) {
    rules.push(`*, *::before, *::after {
      animation-duration: 0s !important; animation-delay: 0s !important;
      transition-duration: 0s !important; transition-delay: 0s !important;
      caret-color: transparent !important;
    }`);
  }
  if (rules.length === 0) return true;
  const css = rules.join('\n');
  for (let attempt = 0; attempt < 2; attempt++) {
    const applied = await page
      .evaluate((css) => {
        const style = document.createElement('style');
        style.setAttribute('data-sc-capture-style', '');
        style.textContent = css;
        (document.head ?? document.documentElement).appendChild(style);
        // ページの CSP でインラインのスタイルが禁止されていると、要素は入っても sheet が作られない
        return style.sheet != null;
      }, css)
      .catch(() => false);
    if (applied) return true;
    await page.evaluate(() => document.querySelectorAll('style[data-sc-capture-style]').forEach((el) => el.remove())).catch(() => {});
    await page.waitForTimeout(300);
  }
  return false;
}

// tsx（esbuild）で実行すると、page.evaluate に渡す関数の中に `__name(...)` という補助呼び出しが入る。
// ブラウザ側にはこの関数がないので、ページ読み込み前に何もしない関数として定義しておく
export const TSX_COMPAT_INIT_SCRIPT = 'globalThis.__name = globalThis.__name || ((fn) => fn);';

// 設計書 6.1 ⑥: 文字列で要素を探して隠す（S-05 の hideByText）。
// クラス名が自動生成のサイト（Notion など）向け。文字列が完全に一致する要素を探し、
// それを含むボタン・リンク（なければその要素自体）を隠す。隠した数を返す
export async function hideByText(page: Page, texts: string[]): Promise<number> {
  if (texts.length === 0) return 0;
  return page.evaluate((texts) => {
    const wanted = new Set(texts.map((t) => t.trim()));
    let count = 0;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      if (el.children.length > 0) continue;
      if (!wanted.has(el.textContent?.trim() ?? '')) continue;
      const target = el.closest<HTMLElement>('button, a, [role="button"]') ?? el;
      if (target.hasAttribute('data-sc-hidden-by-text')) continue;
      target.setAttribute('data-sc-hidden-by-text', '');
      target.style.setProperty('visibility', 'hidden', 'important');
      count++;
    }
    return count;
  }, texts);
}

// 設計書 6.1 ⑥: 撮影前スクリプト（J-07, J-09）を実行する。スクリプトは関数本体として扱い、Promise を返してもよい
export async function runPageScript(page: Page, script: string): Promise<void> {
  await page.evaluate(`(async () => { ${script} })()`);
}

// 設計書 5.4: JavaScript によるページ移動（History API）で生まれたURLを記録する。ページ読み込み前に入れる
export const HISTORY_HOOK_INIT_SCRIPT = `(() => {
  if (window.__scHistoryUrls) return;
  window.__scHistoryUrls = [];
  for (const name of ['pushState', 'replaceState']) {
    const original = history[name];
    history[name] = function (state, title, url) {
      if (url != null) {
        try { window.__scHistoryUrls.push(new URL(String(url), location.href).href); } catch {}
      }
      return original.apply(this, arguments);
    };
  }
})();`;

// 設計書 5.4: ページ内のリンク（a[href], area[href]）と、History API で生まれたURLを集める
export async function collectLinks(page: Page): Promise<string[]> {
  const links = await page.evaluate(() => {
    const out = new Set<string>();
    for (const el of Array.from(document.querySelectorAll<HTMLAnchorElement | HTMLAreaElement>('a[href], area[href]'))) {
      if (el.href) out.add(el.href);
    }
    const w = window as unknown as { __scHistoryUrls?: string[] };
    for (const url of w.__scHistoryUrls ?? []) out.add(url);
    return [...out];
  });
  return links.filter((u) => u.startsWith('http://') || u.startsWith('https://'));
}
