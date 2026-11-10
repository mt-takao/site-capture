import type { Page } from 'playwright';
import { MAX_CLICK_STATES_PER_PAGE } from '@site-capture/shared';
import type { ClickTarget } from './types.js';

// 設計書 6.6「要素を押してから撮る」（J-10）。
// ボタンを押したときだけ開くダイアログなど、ページを開いただけでは写らない画面を撮るために使う

// 押す要素に付ける目印
const CLICK_TARGET_ATTR = 'data-sc-click-target';
// 開いたダイアログのうち、スクロールする要素に付ける目印（撮影ではここをスクロール領域として扱う）
export const DIALOG_SCROLLER_ATTR = 'data-sc-dialog-scroller';
// 開いたダイアログ本体に付ける目印
export const DIALOG_ATTR = 'data-sc-dialog';

const CLICK_TIMEOUT_MS = 5000;
const DIALOG_APPEAR_MAX_MS = 3000;

export class ClickTargetNotFoundError extends Error {
  constructor(readonly target: ClickTarget) {
    super(`押す要素が見つかりません: ${target.selector} の ${target.index + 1} 番目`);
    this.name = 'ClickTargetNotFoundError';
  }
}

export class ClickNavigatedError extends Error {
  constructor(readonly to: string) {
    super(`要素を押すと別のページ（${to}）に移動したため撮りませんでした。押す要素の CSS セレクタを見直してください`);
    this.name = 'ClickNavigatedError';
  }
}

export type OpenedDialog = {
  title: string | null; // ダイアログの名前（aria-labelledby、aria-label、見出しの順に探す）
  fixed: boolean; // 画面に固定されているか（モーダルの <dialog> など。ページと一緒にスクロールしない）
  scrollable: boolean; // ダイアログの中にスクロールする要素があるか（あれば DIALOG_SCROLLER_ATTR を付けてある）
};

// セレクタに当てはまる、見えている要素を集める。押す前（ふつうのページの撮影中）に呼ぶ
export async function findClickTargets(page: Page, selectors: string[]): Promise<ClickTarget[]> {
  if (selectors.length === 0) return [];
  return page.evaluate(
    ({ selectors, max }) => {
      const visible = (el: Element) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('dialog:not([open])');
      };
      const labelOf = (el: Element) => {
        const text =
          el.getAttribute('aria-label') ||
          el.getAttribute('title') ||
          el.querySelector('h1, h2, h3, h4, h5, h6')?.textContent ||
          el.textContent ||
          '';
        const t = text.replace(/\s+/g, ' ').trim();
        return t.length > 40 ? `${t.slice(0, 40)}…` : t;
      };
      const seen = new Set<Element>();
      const out: Array<{ selector: string; index: number; no: number; label: string }> = [];
      for (const selector of selectors) {
        let els: Element[];
        try {
          els = Array.from(document.querySelectorAll(selector)).filter(visible);
        } catch {
          continue; // セレクタの書き方の誤りは、押して撮るときではなくここで無視する（ふつうの撮影は続ける）
        }
        els.forEach((el, index) => {
          if (seen.has(el) || out.length >= max) return;
          seen.add(el);
          out.push({ selector, index, no: out.length + 1, label: labelOf(el) || `${selector} の ${index + 1} 番目` });
        });
      }
      return out;
    },
    { selectors, max: MAX_CLICK_STATES_PER_PAGE },
  );
}

// 要素を押し、開いたダイアログを見つける。ダイアログが見つからなければ null（押した後のページ全体を撮る）
export async function openClickTarget(page: Page, target: ClickTarget): Promise<OpenedDialog | null> {
  const found = await page.evaluate(
    ({ selector, index, attr }) => {
      const visible = (el: Element) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('dialog:not([open])');
      };
      document.querySelectorAll(`[${attr}]`).forEach((el) => el.removeAttribute(attr));
      const el = Array.from(document.querySelectorAll(selector)).filter(visible)[index];
      if (!el) return false;
      el.setAttribute(attr, '');
      return true;
    },
    { selector: target.selector, index: target.index, attr: CLICK_TARGET_ATTR },
  );
  if (!found) throw new ClickTargetNotFoundError(target);

  const before = withoutHash(page.url());
  const locator = page.locator(`[${CLICK_TARGET_ATTR}]`).first();
  try {
    // 実際のマウス操作で押す（ページ側が document でクリックを受け取る作りでも動くように）
    await locator.click({ timeout: CLICK_TIMEOUT_MS });
  } catch {
    // ほかの要素に重なっていて押せないときは、要素の click() を直接呼ぶ
    await locator.evaluate((el) => (el as HTMLElement).click());
  }

  const startedAt = Date.now();
  while (true) {
    if (withoutHash(page.url()) !== before) throw new ClickNavigatedError(page.url());
    const dialog = await findOpenDialog(page);
    if (dialog || Date.now() - startedAt >= DIALOG_APPEAR_MAX_MS) return dialog;
    await page.waitForTimeout(100);
  }
}

// 開いているダイアログを探し、中のスクロールする要素に目印を付ける。画面幅を変えた後にも呼び直す
export async function findOpenDialog(page: Page): Promise<OpenedDialog | null> {
  return page.evaluate(({ attr, dialogAttr }) => {
    for (const a of [attr, dialogAttr]) document.querySelectorAll(`[${a}]`).forEach((el) => el.removeAttribute(a));
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
    };
    const candidates = Array.from(
      document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]'),
    ).filter(visible);
    if (candidates.length === 0) return null;
    // モーダルとして開いたものを優先し、その中では後から開いた（文書の後ろにある）ものを選ぶ
    const isModal = (el: Element) => {
      try {
        return el.matches(':modal') || el.getAttribute('aria-modal') === 'true';
      } catch {
        return el.getAttribute('aria-modal') === 'true';
      }
    };
    const dialog = candidates.filter(isModal).at(-1) ?? candidates.at(-1)!;
    dialog.setAttribute(dialogAttr, '');

    const textOf = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() || null;
    const labelledBy = dialog.getAttribute('aria-labelledby');
    const title =
      (labelledBy ? labelledBy.split(/\s+/).map((id) => textOf(document.getElementById(id))).filter(Boolean).join(' ') : null) ||
      dialog.getAttribute('aria-label') ||
      textOf(dialog.querySelector('h1, h2, h3, h4, h5, h6'));

    let fixed = false;
    for (let node: Element | null = dialog; node; node = node.parentElement) {
      if (getComputedStyle(node).position === 'fixed') fixed = true;
    }
    if (isModal(dialog) && dialog.tagName === 'DIALOG') fixed = true;

    // スクロールする要素は、ダイアログの中と、ダイアログを包む要素（画面全体を覆う固定の背景など）から探す
    const ancestors: Element[] = [];
    for (let node = dialog.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      ancestors.push(node);
    }
    let scroller: Element | null = null;
    let bestHidden = 1;
    for (const el of [dialog, ...Array.from(dialog.querySelectorAll('*')), ...ancestors]) {
      const oy = getComputedStyle(el).overflowY;
      if (oy !== 'auto' && oy !== 'scroll') continue;
      const hidden = el.scrollHeight - el.clientHeight;
      if (hidden > bestHidden) {
        scroller = el;
        bestHidden = hidden;
      }
    }
    if (scroller) scroller.setAttribute(attr, '');
    return { title: title && title.length > 120 ? `${title.slice(0, 120)}…` : title, fixed, scrollable: !!scroller };
  }, { attr: DIALOG_SCROLLER_ATTR, dialogAttr: DIALOG_ATTR });
}

// 画面に固定されたダイアログを、ページの先頭からの位置に置き直して高さの制限を外し、ページ全体として撮れるようにする。
// 撮る範囲の高さ（ダイアログの下端に、上の余白と同じだけの余白を足したもの）を返す。伸びきらなければ null
export async function expandFixedDialog(page: Page): Promise<number | null> {
  const ok = await page.evaluate(
    ({ attr, dialogAttr }) => {
      const dialog = document.querySelector(`[${dialogAttr}]`);
      if (!dialog) return false;
      window.scrollTo(0, 0);
      const scroller = document.querySelector(`[${attr}]`);
      // 伸ばす要素: スクロールする要素から上にたどった要素すべてと、ダイアログから上にたどった要素すべて
      const chain = new Set<HTMLElement>();
      for (const start of [scroller, dialog]) {
        for (let n = start as HTMLElement | null; n && n !== document.body && n !== document.documentElement; n = n.parentElement) chain.add(n);
      }
      for (const el of chain) {
        el.setAttribute('data-sc-dexp', el.getAttribute('style') ?? '');
        const cs = getComputedStyle(el);
        if (cs.position === 'fixed' || el === dialog) {
          // 今の見た目の位置と幅のまま、ページの中の位置に置き直す（中央寄せの transform なども外す）
          const r = el.getBoundingClientRect();
          for (const [k, v] of [
            ['position', 'absolute'], ['top', `${r.top}px`], ['left', `${r.left}px`], ['width', `${r.width}px`],
            ['right', 'auto'], ['bottom', 'auto'], ['margin', '0'], ['transform', 'none'], ['translate', 'none'],
          ]) el.style.setProperty(k!, v!, 'important');
        }
        for (const [k, v] of [['height', 'auto'], ['max-height', 'none'], ['overflow', 'visible']]) el.style.setProperty(k!, v!, 'important');
      }
      const style = document.createElement('style');
      style.setAttribute('data-sc-dexp-style', '');
      style.textContent = 'html, body { overflow: visible !important; height: auto !important; }';
      document.head.appendChild(style);
      window.scrollTo(0, 0);
      window.dispatchEvent(new Event('resize'));
      return true;
    },
    { attr: DIALOG_SCROLLER_ATTR, dialogAttr: DIALOG_ATTR },
  );
  if (!ok) return null;
  await page.waitForTimeout(300);
  return fitDialogSpacer(page);
}

// 伸ばしたダイアログの下端（ページの先頭から）を測り、そこまでページが伸びるよう目印の要素を置き直す。
// 画面の大きさを変えるとダイアログの高さも変わることがあるので、変えた後にも呼ぶ
export async function fitDialogSpacer(page: Page): Promise<number | null> {
  return page.evaluate(
    ({ attr, dialogAttr }) => {
      const dialog = document.querySelector(`[${dialogAttr}]`);
      if (!dialog) return null;
      const scroller = document.querySelector(`[${attr}]`);
      if (scroller && scroller.scrollHeight - scroller.clientHeight > 1) return null;
      document.querySelectorAll('[data-sc-dexp-spacer]').forEach((el) => el.remove());
      window.scrollTo(0, 0);
      const r = dialog.getBoundingClientRect();
      const top = r.top + window.scrollY;
      // 下にも上と同じだけ（80px まで）の余白を付ける
      const bottom = Math.ceil(r.bottom + window.scrollY + Math.max(0, Math.min(top, 80)));
      // 固定の要素はページの高さに数えられないので、ダイアログの下端まで届く目印の要素を置いてページを伸ばす
      const spacer = document.createElement('div');
      spacer.setAttribute('data-sc-dexp-spacer', '');
      spacer.style.cssText = `position:absolute;top:0;left:0;width:1px;height:${bottom}px;pointer-events:none;visibility:hidden`;
      document.body.appendChild(spacer);
      return bottom;
    },
    { attr: DIALOG_SCROLLER_ATTR, dialogAttr: DIALOG_ATTR },
  );
}

// expandFixedDialog で加えた書き換えを元に戻す
export async function undoExpandFixedDialog(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll('[data-sc-dexp-style], [data-sc-dexp-spacer]').forEach((el) => el.remove());
    document.querySelectorAll<HTMLElement>('[data-sc-dexp]').forEach((el) => {
      const before = el.getAttribute('data-sc-dexp');
      if (before) el.setAttribute('style', before);
      else el.removeAttribute('style');
      el.removeAttribute('data-sc-dexp');
    });
  });
}

function withoutHash(url: string): string {
  const i = url.indexOf('#');
  return i === -1 ? url : url.slice(0, i);
}
