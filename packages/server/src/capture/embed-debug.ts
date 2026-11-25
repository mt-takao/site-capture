import type { Page } from 'playwright';

// 原因を調べるための記録（環境変数 SC_DEBUG=1 のときだけ使う）。
// ページの中に埋め込まれたもの（iframe、canvas、video、object など）が写らないときに、どう作られているかを調べる

export const DEBUG = process.env.SC_DEBUG === '1';

// 失敗した通信と、400 以上を返した通信を集める。ページを開く前に呼ぶ
export function collectFailedRequests(page: Page): string[] {
  const out: string[] = [];
  page.on('requestfailed', (req) => out.push(`失敗 ${req.resourceType()} ${req.url().slice(0, 150)} ${req.failure()?.errorText ?? ''}`));
  page.on('response', (res) => {
    if (res.status() >= 400) out.push(`${res.status()} ${res.request().resourceType()} ${res.url().slice(0, 150)}`);
  });
  return out;
}

export async function describeEmbedsForDebug(page: Page): Promise<string[]> {
  const lines: string[] = [];
  // Shadow DOM の中もたどって、埋め込み要素を探す
  const embeds = await page.evaluate(() => {
    const out: string[] = [];
    const desc = (n: Element) => {
      const cls = typeof (n as HTMLElement).className === 'string' ? (n as HTMLElement).className.trim().split(/\s+/).slice(0, 3).join('.') : '';
      return `${n.tagName.toLowerCase()}${n.id ? `#${n.id}` : ''}${cls ? `.${cls}` : ''}`;
    };
    const walk = (root: Document | ShadowRoot, depth: string) => {
      for (const el of Array.from(root.querySelectorAll('*'))) {
        if (el.shadowRoot) walk(el.shadowRoot, `${depth}${desc(el)}>>`);
        if (!['IFRAME', 'CANVAS', 'VIDEO', 'OBJECT', 'EMBED', 'FRAME'].includes(el.tagName)) continue;
        const r = el.getBoundingClientRect();
        const attrs = ['src', 'loading', 'sandbox', 'allow', 'data-src', 'title']
          .map((a) => (el.getAttribute(a) != null ? `${a}=${(el.getAttribute(a) ?? '').slice(0, 120)}` : ''))
          .filter(Boolean)
          .join(' ');
        const srcdoc = el.getAttribute('srcdoc');
        out.push(
          `${depth}${desc(el)} ${Math.round(r.width)}x${Math.round(r.height)} @y=${Math.round(r.top + window.scrollY)} ` +
            `visibility=${getComputedStyle(el).visibility} opacity=${getComputedStyle(el).opacity} ${attrs}${srcdoc != null ? ` srcdoc(${srcdoc.length}文字)` : ''}`,
        );
      }
    };
    walk(document, '');
    return out;
  });
  lines.push(`埋め込み要素 ${embeds.length} 個`, ...embeds.map((l) => `  ${l}`));

  // 「デモ」と書かれた説明の近く（デモの枠があるはずの場所）の作りを、Shadow DOM の中も含めて書き出す
  const outline = await page.evaluate((keyword) => {
    const out: string[] = [];
    const desc = (n: Element) => {
      const cls = typeof (n as HTMLElement).className === 'string' ? (n as HTMLElement).className.trim().split(/\s+/).slice(0, 3).join('.') : '';
      const r = n.getBoundingClientRect();
      const cs = getComputedStyle(n);
      const extra = [
        cs.display === 'none' ? 'display=none' : '',
        cs.visibility === 'hidden' ? 'hidden' : '',
        cs.opacity !== '1' ? `opacity=${cs.opacity}` : '',
        /url\(/.test(cs.backgroundImage) ? 'bg-image' : '',
        n.shadowRoot ? 'shadow' : '',
        n.getAttribute('src') ? `src=${(n.getAttribute('src') ?? '').slice(0, 80)}` : '',
      ].filter(Boolean).join(' ');
      return `${n.tagName.toLowerCase()}${n.id ? `#${n.id}` : ''}${cls ? `.${cls}` : ''} ${Math.round(r.width)}x${Math.round(r.height)}${extra ? ` ${extra}` : ''}`;
    };
    const roots: Array<Document | ShadowRoot> = [document];
    for (let i = 0; i < roots.length; i++) for (const el of Array.from(roots[i]!.querySelectorAll('*'))) if (el.shadowRoot) roots.push(el.shadowRoot);
    let caption: Element | null = null;
    for (const root of roots) {
      for (const el of Array.from(root.querySelectorAll('*'))) {
        const own = Array.from(el.childNodes).some((c) => c.nodeType === 3 && (c.textContent ?? '').includes(keyword));
        if (own && el.getBoundingClientRect().height > 0) caption = el;
      }
    }
    if (!caption) return [`「${keyword}」と書かれた要素は見つかりませんでした`];
    // 説明の3段上の要素から下を書き出す（デモの枠は説明の近くにあるはず）
    let top: Element = caption;
    for (let i = 0; i < 3 && top.parentElement; i++) top = top.parentElement;
    const walk = (n: Element, indent: string) => {
      if (out.length >= 60) return;
      out.push(`${indent}${desc(n)}`);
      const kids = [...Array.from(n.children), ...(n.shadowRoot ? Array.from(n.shadowRoot.children) : [])];
      for (const k of kids) walk(k, `${indent}  `);
    };
    walk(top, '');
    return out;
  }, 'デモ');
  lines.push('「デモ」の近くの作り', ...outline.map((l) => `  ${l}`));

  const frames = page.frames().filter((f) => f !== page.mainFrame());
  lines.push(`フレーム ${frames.length} 個`);
  for (const f of frames) {
    const info = await f
      .evaluate(() => ({
        ready: document.readyState,
        text: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
        elements: document.querySelectorAll('*').length,
        size: `${document.documentElement.scrollWidth}x${document.documentElement.scrollHeight}`,
      }))
      .catch((e: Error) => ({ error: e.message.split('\n')[0] }));
    lines.push(`  ${f.url().slice(0, 150)} ${JSON.stringify(info)}`);
  }
  return lines;
}

// つなぎ合わせて撮るとき、1画面撮るごとに呼ぶ。スクロールしてもページの中での位置が変わらないはずの要素のうち、
// 前の画面から位置・見え方が変わったもの（スクロールに合わせて動く要素）を書き出す
export async function describeScrollLinkedForDebug(page: Page, tileNo: number): Promise<string[]> {
  return page.evaluate((tileNo) => {
    type Info = { top: number; left: number; h: number; opacity: string; transform: string; position: string; desc: string };
    const w = window as unknown as { __scDbgPrev?: Record<string, Info>; __scDbgNext?: number };
    const prev = w.__scDbgPrev ?? {};
    const now: Record<string, Info> = {};
    const desc = (n: Element) => {
      const cls = typeof (n as HTMLElement).className === 'string' ? (n as HTMLElement).className.trim().split(/\s+/).slice(0, 3).join('.') : '';
      return `${n.tagName.toLowerCase()}${n.id ? `#${n.id}` : ''}${cls ? `.${cls}` : ''}`;
    };
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 100 || r.height < 60) continue;
      let id = el.getAttribute('data-sc-dbg');
      if (!id) {
        id = String((w.__scDbgNext = (w.__scDbgNext ?? 0) + 1));
        el.setAttribute('data-sc-dbg', id);
      }
      const cs = getComputedStyle(el);
      now[id] = {
        top: Math.round(r.top + window.scrollY),
        left: Math.round(r.left),
        h: Math.round(r.height),
        opacity: cs.opacity,
        transform: cs.transform,
        position: cs.position,
        desc: desc(el),
      };
    }
    w.__scDbgPrev = now;
    const out = [`[スクロールの調査] ${tileNo + 1}枚目 scrollY=${Math.round(window.scrollY)} 高さ=${document.documentElement.scrollHeight}`];
    // 位置・見え方が変わった要素のうち、親も同じだけ動いているものは省く（いちばん外側だけを書く）
    const changed = new Map<string, number>();
    for (const [id, n] of Object.entries(now)) {
      const p = prev[id];
      if (!p) continue;
      if (Math.abs(n.top - p.top) > 2 || n.opacity !== p.opacity || n.transform !== p.transform) changed.set(id, n.top - p.top);
    }
    let count = 0;
    for (const [id, dy] of changed) {
      const el = document.querySelector(`[data-sc-dbg="${id}"]`);
      let parent = el?.parentElement ?? null;
      let skip = false;
      for (; parent; parent = parent.parentElement) {
        const pid = parent.getAttribute('data-sc-dbg');
        if (pid && changed.get(pid) === dy) {
          skip = true;
          break;
        }
      }
      if (skip) continue;
      if (++count > 25) break;
      const n = now[id]!;
      const p = prev[id]!;
      out.push(
        `  ${n.desc} ${n.position} 位置 ${p.top}→${n.top}（${dy >= 0 ? '+' : ''}${dy}） 高さ ${n.h} 不透明度 ${p.opacity}→${n.opacity} 変形 ${n.transform.slice(0, 60)}`,
      );
    }
    // 固定・追従の要素（大きいもの）も書く
    if (tileNo === 0) {
      for (const n of Object.values(now)) {
        if (n.position === 'fixed' || n.position === 'sticky') out.push(`  固定/追従: ${n.desc} ${n.position} 位置 ${n.top} 高さ ${n.h}`);
      }
    }
    return out;
  }, tileNo);
}
