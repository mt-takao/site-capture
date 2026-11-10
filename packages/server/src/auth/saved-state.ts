import { readFile } from 'node:fs/promises';
import type { BrowserContext, BrowserContextOptions } from 'playwright';

// 保存したログイン状態のファイルの形（設計書 7.1）。
// Playwright の storageState（Cookie と localStorage）に、sessionStorage を足したもの。
// sessionStorage は storageState の対象外だが、入室した状態を sessionStorage にだけ置くサイトがあるため、別に集めて保存する（2026-11-10）

type StorageState = Exclude<BrowserContextOptions['storageState'], string | undefined>;

export type SessionStorageByOrigin = Record<string, Array<[name: string, value: string]>>;

export type SavedLoginState = StorageState & { sessionStorage?: SessionStorageByOrigin };

export type SavedItemCounts = { cookies: number; localStorage: number; sessionStorage: number };

// ログイン用ブラウザで開いているすべてのタブから、sessionStorage をオリジンごとに集める
export async function collectSessionStorage(context: BrowserContext): Promise<SessionStorageByOrigin> {
  const result: SessionStorageByOrigin = {};
  for (const page of context.pages()) {
    const data = await page
      .evaluate(() => ({ origin: location.origin, items: Object.entries(sessionStorage) }))
      .catch(() => null);
    if (!data || data.origin === 'null' || data.items.length === 0) continue;
    result[data.origin] = data.items;
  }
  return result;
}

export function countSavedItems(state: SavedLoginState): SavedItemCounts {
  return {
    cookies: state.cookies?.length ?? 0,
    localStorage: (state.origins ?? []).reduce((n, o) => n + o.localStorage.length, 0),
    sessionStorage: Object.values(state.sessionStorage ?? {}).reduce((n, items) => n + items.length, 0),
  };
}

export async function readSavedLoginState(path: string): Promise<{ storageState: StorageState; sessionStorage: SessionStorageByOrigin }> {
  const { sessionStorage, ...storageState } = JSON.parse(await readFile(path, 'utf8')) as SavedLoginState;
  return { storageState, sessionStorage: sessionStorage ?? {} };
}

// 撮影するページの sessionStorage に、保存した値を書き戻すスクリプト。ページのスクリプトより先に、オリジンが一致するページでだけ動く。
// ページ側がすでに値を持っていれば上書きしない
export function sessionStorageInitScript(data: SessionStorageByOrigin): string {
  return `(() => {
  const data = ${JSON.stringify(data)};
  const items = data[location.origin];
  if (!items) return;
  for (const [name, value] of items) {
    try {
      if (sessionStorage.getItem(name) === null) sessionStorage.setItem(name, value);
    } catch {}
  }
})();`;
}
