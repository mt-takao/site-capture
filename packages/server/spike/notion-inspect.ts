// M1 準備: Notion のトグルと「Notion を無料で使う」ボタンの DOM 構造、Accept-Language の効果を1回の読み込みで調べる。
// 使い方: tsx spike/notion-inspect.ts <URL>
import { chromium } from 'playwright';
import { DOM_OBSERVER_INIT_SCRIPT, NetworkTracker, waitForStable } from '../src/capture/stabilize.js';
import { TSX_COMPAT_INIT_SCRIPT } from '../src/capture/prepare.js';

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  locale: 'ja-JP',
  extraHTTPHeaders: { 'Accept-Language': 'ja-JP,ja;q=0.9' },
});
await context.addInitScript(TSX_COMPAT_INIT_SCRIPT);
await context.addInitScript(DOM_OBSERVER_INIT_SCRIPT);
const page = await context.newPage();
const network = new NetworkTracker(page);
const res = await page.goto(process.argv[2], { waitUntil: 'domcontentloaded' });
console.log('status', res?.status());
console.log('stable', await waitForStable(page, network, { quietWindowMs: 1000, maxWaitMs: 15000 }));

const info = await page.evaluate(() => {
  const describe = (el: Element | null, depth = 4) => {
    const chain: string[] = [];
    for (let n = el; n && chain.length < depth; n = n.parentElement) {
      const attrs = Array.from(n.attributes)
        .filter((a) => a.name !== 'class' && a.name !== 'style')
        .map((a) => `${a.name}="${a.value.slice(0, 40)}"`)
        .join(' ');
      chain.push(`<${n.tagName.toLowerCase()} ${attrs}>`);
    }
    return chain;
  };
  const byText = (re: RegExp) =>
    Array.from(document.querySelectorAll('body *')).filter(
      (e) => e.children.length === 0 && re.test(e.textContent?.trim() ?? ''),
    );
  return {
    htmlLang: document.documentElement.lang,
    navigatorLanguage: navigator.language,
    signupButtons: byText(/Get Notion free|Notionを今すぐ使う|Notion を無料|無料で|Try Notion|Notionを使ってみる/).map((e) => ({
      text: e.textContent?.trim(),
      chain: describe(e, 5),
    })),
    ariaExpanded: Array.from(document.querySelectorAll('[aria-expanded]')).slice(0, 10).map((e) => ({
      value: e.getAttribute('aria-expanded'),
      text: (e.closest('[data-block-id]')?.textContent ?? e.textContent ?? '').trim().slice(0, 60),
      chain: describe(e, 3),
    })),
    toggleBlocks: Array.from(document.querySelectorAll('[class*="toggle"]')).slice(0, 5).map((e) => describe(e, 2)),
    blockIdCount: document.querySelectorAll('[data-block-id]').length,
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
