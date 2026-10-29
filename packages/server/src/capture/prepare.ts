import type { Page } from 'playwright';

// 設計書 6.1 ③: 隠す要素とアニメーション停止のCSSを差し込む（S-05, S-06）
export async function injectCaptureStyles(
  page: Page,
  options: { hideSelectors: string[]; disableAnimations: boolean },
): Promise<void> {
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
  if (rules.length > 0) await page.addStyleTag({ content: rules.join('\n') });
}

// tsx（esbuild）で実行すると、page.evaluate に渡す関数の中に `__name(...)` という補助呼び出しが入る。
// ブラウザ側にはこの関数がないので、ページ読み込み前に何もしない関数として定義しておく
export const TSX_COMPAT_INIT_SCRIPT = 'globalThis.__name = globalThis.__name || ((fn) => fn);';
