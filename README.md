# Site Capture

URLを1つ入れると、そのサイト内でたどれるページを巡回して、各ページのスクリーンショットを撮るローカルアプリです。
自分のPC（macOS）だけで動きます。

- 要件: [docs/requirements.md](docs/requirements.md)
- 設計: [docs/design.md](docs/design.md)
- 技術検証の結果: [docs/m0-findings.md](docs/m0-findings.md)

現在は M1（撮影エンジン）まで完成しています。1つのURLをコマンドで撮れます。サイトの巡回（M2）と画面（M3）はこれから作ります。

## 準備（初回だけ）

Node.js 24 と pnpm が必要です。

```bash
pnpm install
```

```bash
pnpm --filter @site-capture/server exec playwright install chromium
```

## 1つのURLを撮る

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

## テスト

```bash
pnpm test
```

検証用ページ（`packages/server/test/fixtures/`）を実際に Chromium で撮る結合テストを含むため、1分ほどかかります。
