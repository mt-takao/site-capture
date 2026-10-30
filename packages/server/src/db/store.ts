import Database from 'better-sqlite3';
import type { ShotRecord } from '../capture/types.js';
import type { CrawlSettings, SkipReason } from '../crawler/types.js';
import { MIGRATIONS } from './schema.js';

export type CrawlStatus = 'queued' | 'running' | 'done' | 'stopped' | 'error';
export type PageStatus = 'queued' | 'capturing' | 'done' | 'failed' | 'skipped';

export type CrawlRow = {
  id: number;
  start_url: string;
  status: CrawlStatus;
  settings_json: string;
  output_dir: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  pages_found: number;
  pages_done: number;
  pages_failed: number;
  pages_skipped: number;
  error_message: string | null;
};

export type PageRow = {
  id: number;
  crawl_id: number;
  url: string;
  normalized_url: string;
  path: string;
  group_key: string;
  depth: number;
  found_from_page_id: number | null;
  status: PageStatus;
  skip_reason: SkipReason | null;
  http_status: number | null;
  title: string | null;
  final_url: string | null;
  error_message: string | null;
  wait_timed_out: number;
};

export type ShotRow = {
  id: number;
  page_id: number;
  viewport_width: number;
  file_path: string;
  thumb_path: string;
  image_width: number;
  image_height: number;
  method: string;
  fell_back: number;
};

const now = () => new Date().toISOString();

// SQLite へのアクセスをまとめる。better-sqlite3 は同期 API なので、巡回中に並行して呼んでも順に処理される
export class Store {
  readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const version = this.db.pragma('user_version', { simple: true }) as number;
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[v]!);
        this.db.pragma(`user_version = ${v + 1}`);
      })();
    }
  }

  // 前回の起動中に途中で止まった撮影を stopped にする（設計書 1.1）
  markInterruptedCrawls(): number {
    const r = this.db
      .prepare(`UPDATE crawls SET status = 'stopped', finished_at = ? WHERE status IN ('queued', 'running')`)
      .run(now());
    this.db.prepare(`UPDATE pages SET status = 'queued', updated_at = ? WHERE status = 'capturing'`).run(now());
    return r.changes;
  }

  createCrawl(settings: CrawlSettings, outputDir: string): number {
    const r = this.db
      .prepare(
        `INSERT INTO crawls (start_url, status, settings_json, auth_profile_id, output_dir, created_at)
         VALUES (?, 'queued', ?, ?, ?, ?)`,
      )
      .run(settings.startUrl, JSON.stringify(settings), settings.authProfileId, outputDir, now());
    return Number(r.lastInsertRowid);
  }

  updateCrawlStatus(id: number, status: CrawlStatus, errorMessage: string | null = null): void {
    const time = now();
    if (status === 'running') {
      this.db.prepare(`UPDATE crawls SET status = ?, started_at = COALESCE(started_at, ?) WHERE id = ?`).run(status, time, id);
    } else if (status === 'queued') {
      this.db.prepare(`UPDATE crawls SET status = ? WHERE id = ?`).run(status, id);
    } else {
      this.db
        .prepare(`UPDATE crawls SET status = ?, finished_at = ?, error_message = ? WHERE id = ?`)
        .run(status, time, errorMessage, id);
    }
  }

  // ページ数の集計を pages から数え直す
  refreshCrawlCounts(id: number): void {
    this.db
      .prepare(
        `UPDATE crawls SET
           pages_found   = (SELECT COUNT(*) FROM pages WHERE crawl_id = @id),
           pages_done    = (SELECT COUNT(*) FROM pages WHERE crawl_id = @id AND status = 'done'),
           pages_failed  = (SELECT COUNT(*) FROM pages WHERE crawl_id = @id AND status = 'failed'),
           pages_skipped = (SELECT COUNT(*) FROM pages WHERE crawl_id = @id AND status = 'skipped')
         WHERE id = @id`,
      )
      .run({ id });
  }

  getCrawl(id: number): CrawlRow | undefined {
    return this.db.prepare(`SELECT * FROM crawls WHERE id = ?`).get(id) as CrawlRow | undefined;
  }

  listCrawls(): CrawlRow[] {
    return this.db.prepare(`SELECT * FROM crawls ORDER BY id DESC`).all() as CrawlRow[];
  }

  // 撮影セッションの中で同じ正規化URLがすでにあれば null を返す
  insertPage(p: {
    crawlId: number;
    url: string;
    normalizedUrl: string;
    path: string;
    groupKey: string;
    depth: number;
    foundFromPageId: number | null;
    status: PageStatus;
    skipReason?: SkipReason | null;
  }): number | null {
    const time = now();
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO pages
           (crawl_id, url, normalized_url, path, group_key, depth, found_from_page_id, status, skip_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.crawlId, p.url, p.normalizedUrl, p.path, p.groupKey, p.depth, p.foundFromPageId, p.status, p.skipReason ?? null, time, time);
    return r.changes === 0 ? null : Number(r.lastInsertRowid);
  }

  hasPage(crawlId: number, normalizedUrl: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM pages WHERE crawl_id = ? AND normalized_url = ?`).get(crawlId, normalizedUrl);
  }

  setPageStatus(pageId: number, status: PageStatus, extra: { skipReason?: SkipReason; errorMessage?: string } = {}): void {
    this.db
      .prepare(`UPDATE pages SET status = ?, skip_reason = ?, error_message = ?, updated_at = ? WHERE id = ?`)
      .run(status, extra.skipReason ?? null, extra.errorMessage ?? null, now(), pageId);
  }

  completePage(pageId: number, r: { httpStatus: number | null; title: string; finalUrl: string; shots: ShotRecord[] }): void {
    const time = now();
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE pages SET status = 'done', http_status = ?, title = ?, final_url = ?, wait_timed_out = ?,
             error_message = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(r.httpStatus, r.title, r.finalUrl, r.shots.some((s) => s.waitTimedOut) ? 1 : 0, time, pageId);
      const insert = this.db.prepare(
        `INSERT OR REPLACE INTO shots
           (page_id, viewport_width, file_path, thumb_path, image_width, image_height, method, fell_back, captured_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const s of r.shots) {
        insert.run(pageId, s.viewportWidth, s.filePath, s.thumbPath, s.imageWidth, s.imageHeight, s.method, s.fellBackToStitch ? 1 : 0, time);
      }
    })();
  }

  listPages(crawlId: number, status?: PageStatus): PageRow[] {
    return (
      status
        ? this.db.prepare(`SELECT * FROM pages WHERE crawl_id = ? AND status = ? ORDER BY id`).all(crawlId, status)
        : this.db.prepare(`SELECT * FROM pages WHERE crawl_id = ? ORDER BY id`).all(crawlId)
    ) as PageRow[];
  }

  listShots(pageId: number): ShotRow[] {
    return this.db.prepare(`SELECT * FROM shots WHERE page_id = ? ORDER BY viewport_width DESC`).all(pageId) as ShotRow[];
  }
}
