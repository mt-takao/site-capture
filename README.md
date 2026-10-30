# Site Capture

URLを1つ入れると、そのサイト内でたどれるページを巡回して、各ページのスクリーンショットを撮るローカルアプリです。
自分のPC（macOS）だけで動きます。

- 要件: [docs/requirements.md](docs/requirements.md)
- 設計: [docs/design.md](docs/design.md)
- 技術検証の結果: [docs/m0-findings.md](docs/m0-findings.md)

現在は M3（画面の基本）まで完成しています。ブラウザの画面から撮影を始め、進み具合と結果を見られます。ログインが必要なページ（M4）と比較画面（M5）はこれから作ります。

## 準備（初回だけ）

Node.js 24 と pnpm が必要です。

```bash
pnpm install
```

```bash
pnpm --filter @site-capture/server exec playwright install chromium
```

## 起動する

```bash
pnpm start
```

- 画面をビルドしてからサーバーを起動し、ブラウザで http://127.0.0.1:4310 を開きます
- 終了するにはターミナルで `Ctrl + C` を押します（撮影中のページを撮り終えてから終了します）
- 画面でできること
  - 撮影履歴: 過去の撮影の一覧
  - 新しく撮影: URL・画面幅・巡回の範囲を選んで撮影を始める
  - 撮影結果: 進み具合をリアルタイムで表示。URLの階層や状態で絞り込み、画面幅を切り替えてサムネイルを見る。撮影中は停止、終わったら削除できる
  - ページ詳細: 画像を原寸または幅に合わせて表示。← → キーで前後のページへ移る

開発するときは `pnpm dev` を使います。サーバー（4310）と画面（http://127.0.0.1:5173 、変更がすぐ反映される）を同時に起動します。

## コマンドで1つのURLを撮る

```bash
pnpm capture https://example.com/
```

- 画像は `~/SiteCapture/captures/<ドメイン>/<撮影日時>/` に保存されます
- オプション
  - `--widths 1440,375`: 画面幅（カンマ区切り）。初期値は 1440 と 375
  - `--out <フォルダ>`: 保存先
  - `--expand-toggles`: Notion のトグルを開いて撮る
  - `--no-preset`: サイト用のプリセット（Notion など）を使わない
- Notion の公開ページ（`*.notion.site`）は、アクセス制限を避けるため1回の読み込みで全画面幅を撮ります。制限を受けた場合は 60秒 → 120秒 → 240秒 待って撮り直します

## コマンドでサイト全体を巡回して撮る

```bash
pnpm crawl https://example.com/
```

- 起点のURLから同じサイト内のリンクとサイトマップをたどり、見つけたページを撮ります
- 撮影結果は `~/SiteCapture/site-capture.db`（SQLite）に記録され、画像は `~/SiteCapture/captures/<ドメイン>/<撮影日時>/` に保存されます
- `Ctrl + C` で止められます（撮影中のページは撮り終えてから止まります）
- 主なオプション（すべては `pnpm crawl --help`）
  - `--max-pages 200`: 撮る最大ページ数
  - `--sample <n>`: 同じ階層のページ（ブログ記事など）は先頭 n 件だけ撮る
  - `--include-subdomains`: サブドメインも巡回する
  - `--keep-query`: パラメータだけが違うURLを別ページとして撮る
  - `--exclude <パターン>`: 除外するURLのパターン（`*` でワイルドカード）
- 保存先のルート（`~/SiteCapture`）は環境変数 `SITE_CAPTURE_HOME` で変えられます

## テスト

```bash
pnpm test
```

検証用ページ（`packages/server/test/fixtures/`）とテスト用サイト（`packages/server/test/helpers/site-server.ts`）を実際に Chromium で撮る結合テストと、API のテストを含むため、2分ほどかかります。

型チェックは `pnpm typecheck` で、3つのパッケージ（shared、server、web）をまとめて確かめます。
