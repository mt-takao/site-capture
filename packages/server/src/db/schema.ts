// 設計書 4章「データモデル」。マイグレーションは PRAGMA user_version で管理する（配列の n 番目を適用すると version = n+1）
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE crawls (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    start_url      TEXT    NOT NULL,
    status         TEXT    NOT NULL,              -- queued / running / done / stopped / error
    settings_json  TEXT    NOT NULL,
    auth_profile_id TEXT,
    output_dir     TEXT    NOT NULL,
    created_at     TEXT    NOT NULL,
    started_at     TEXT,
    finished_at    TEXT,
    pages_found    INTEGER NOT NULL DEFAULT 0,
    pages_done     INTEGER NOT NULL DEFAULT 0,
    pages_failed   INTEGER NOT NULL DEFAULT 0,
    pages_skipped  INTEGER NOT NULL DEFAULT 0,
    error_message  TEXT
  );

  CREATE TABLE pages (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    crawl_id           INTEGER NOT NULL REFERENCES crawls(id) ON DELETE CASCADE,
    url                TEXT    NOT NULL,
    normalized_url     TEXT    NOT NULL,
    path               TEXT    NOT NULL,
    group_key          TEXT    NOT NULL,
    depth              INTEGER NOT NULL,
    found_from_page_id INTEGER REFERENCES pages(id),
    status             TEXT    NOT NULL,          -- queued / capturing / done / failed / skipped
    skip_reason        TEXT,
    http_status        INTEGER,
    title              TEXT,
    final_url          TEXT,
    error_message      TEXT,
    wait_timed_out     INTEGER NOT NULL DEFAULT 0,
    created_at         TEXT    NOT NULL,
    updated_at         TEXT    NOT NULL,
    UNIQUE (crawl_id, normalized_url)
  );
  CREATE INDEX pages_crawl_status ON pages (crawl_id, status);

  CREATE TABLE shots (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id        INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    viewport_width INTEGER NOT NULL,
    file_path      TEXT    NOT NULL,
    thumb_path     TEXT    NOT NULL,
    image_width    INTEGER NOT NULL,
    image_height   INTEGER NOT NULL,
    method         TEXT    NOT NULL,              -- fullpage / tiled / expand / stitch
    fell_back      INTEGER NOT NULL DEFAULT 0,
    captured_at    TEXT    NOT NULL,
    UNIQUE (page_id, viewport_width)
  );

  CREATE TABLE auth_profiles (
    id                 TEXT PRIMARY KEY,
    name               TEXT NOT NULL,
    origin             TEXT NOT NULL,
    storage_state_path TEXT NOT NULL,
    created_at         TEXT NOT NULL,
    last_used_at       TEXT
  );

  CREATE TABLE site_settings (
    id            TEXT PRIMARY KEY,
    name          TEXT    NOT NULL,
    host_pattern  TEXT    NOT NULL,
    is_builtin    INTEGER NOT NULL DEFAULT 0,
    settings_json TEXT    NOT NULL
  );
  `,
  // M6: 撮影中の警告を残す（画面を開き直しても見られるように）。
  // 撮影開始時に使ったサイト設定も残す（後で設定を編集・削除しても、撮影時の設定が分かり、撮り直しにも同じものを使うため）
  `
  ALTER TABLE crawls ADD COLUMN warnings_json TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE crawls ADD COLUMN site_settings_json TEXT;
  `,
  // J-10: 要素を押してから撮るページ。押す要素（セレクタ・何番目か・名前）を残す（撮り直しでも同じ要素を押すため）。
  // normalized_url は元のページの URL に #click-<番号> を付けたものにする（同じ撮影セッションの中で重ならないように）
  `
  ALTER TABLE pages ADD COLUMN click_json TEXT;
  `,
];
