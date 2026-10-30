import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser, BrowserContext } from 'playwright';
import type { AuthProfileItem, LoginSessionInfo } from '@site-capture/shared';
import type { AuthProfileRow, Store } from '../db/store.js';
import { authDir } from '../paths.js';

// 設計書 7.1「ログイン状態の保存」（L-01〜L-03）。
// 画面ありのブラウザを開いて利用者に手でログインしてもらい、ログイン後の Cookie と localStorage だけを保存する。
// アプリはパスワードを入力も保存もしない（L-02）

type Session = { info: LoginSessionInfo; browser: Browser; context: BrowserContext };

export class LoginSessionError extends Error {}

export class LoginSessionManager {
  private sessions = new Map<string, Session>();

  constructor(
    private readonly store: Store,
    // 本番では画面ありで起動する。テストでは画面なしのブラウザを渡す
    private readonly launchLoginBrowser: () => Promise<Browser>,
  ) {}

  async open(name: string, url: string): Promise<LoginSessionInfo> {
    const trimmed = name.trim();
    if (!trimmed) throw new LoginSessionError('名前を入力してください');
    const target = parseHttpUrl(url);
    const browser = await this.launchLoginBrowser();
    const context = await browser.newContext({ locale: 'ja-JP', viewport: null });
    const page = await context.newPage();
    const info: LoginSessionInfo = { id: randomUUID(), name: trimmed, url: target.href, status: 'open' };
    const session = { info, browser, context };
    this.sessions.set(info.id, session);
    // 利用者がウィンドウを閉じたら、保存はできなくなる
    browser.on('disconnected', () => (info.status = 'closed'));
    context.on('close', () => (info.status = 'closed'));
    await page.goto(target.href).catch(() => {
      // 開けなくても、利用者がブラウザで URL を直して操作できるのでそのままにする
    });
    return { ...info };
  }

  get(id: string): LoginSessionInfo | undefined {
    const s = this.sessions.get(id);
    return s ? { ...s.info } : undefined;
  }

  // テストで、開いたブラウザを操作するために使う
  contextOf(id: string): BrowserContext | undefined {
    return this.sessions.get(id)?.context;
  }

  // ログイン状態を保存してブラウザを閉じる
  async save(id: string): Promise<AuthProfileItem> {
    const s = this.sessions.get(id);
    if (!s) throw new LoginSessionError('ログイン用ブラウザが見つかりません');
    if (s.info.status === 'closed') {
      this.sessions.delete(id);
      throw new LoginSessionError('ブラウザが閉じられたため保存できません。もう一度開いてください');
    }
    const dir = authDir();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const profileId = randomUUID();
    const path = join(dir, `${profileId}.json`);
    await s.context.storageState({ path });
    await chmod(path, 0o600);
    this.store.createAuthProfile({ id: profileId, name: s.info.name, origin: new URL(s.info.url).origin, storageStatePath: path });
    await this.close(id);
    return authProfileItem(this.store.getAuthProfile(profileId)!);
  }

  async close(id: string): Promise<void> {
    const s = this.sessions.get(id);
    this.sessions.delete(id);
    await s?.browser.close().catch(() => {});
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }
}

export function authProfileItem(row: AuthProfileRow): AuthProfileItem {
  return { id: row.id, name: row.name, origin: row.origin, createdAt: row.created_at, lastUsedAt: row.last_used_at };
}

// ログイン状態を消す（データベースの行とファイル）
export async function deleteAuthProfile(store: Store, id: string): Promise<boolean> {
  const row = store.getAuthProfile(id);
  if (!row) return false;
  store.deleteAuthProfile(id);
  await rm(row.storage_state_path, { force: true });
  return true;
}

function parseHttpUrl(url: string): URL {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    throw new LoginSessionError('URLの形式が正しくありません');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new LoginSessionError('http または https のURLを入力してください');
  return u;
}
