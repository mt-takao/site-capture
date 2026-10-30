import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import type { PageItem } from '@site-capture/shared';
import { Segmented } from '../components/Segmented';
import { Badge } from '../components/StatusBadge';
import { api } from '../lib/api';
import { pageName, shotFor, shotMethodLabel } from '../lib/format';
import styles from './PageDetailPage.module.css';

// 設計書 9.1「ページ詳細」: 原寸表示、画面幅の切り替え、ページの情報（V-03）

export function PageDetailPage() {
  const params = useParams();
  const crawlId = Number(params.id);
  const pageId = Number(params.pageId);
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const [pages, setPages] = useState<PageItem[] | null>(null);
  const [zoom, setZoom] = useState<'fit' | 'actual'>('fit');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listPages(crawlId).then(setPages).catch((e: Error) => setError(e.message));
  }, [crawlId]);

  const done = useMemo(() => (pages ?? []).filter((p) => p.status === 'done'), [pages]);
  const index = done.findIndex((p) => p.id === pageId);
  const page = done[index];
  const widths = page?.shots.map((s) => s.viewportWidth) ?? [];
  const width = Number(search.get('w')) || widths[0] || 0;
  const shot = page ? shotFor(page, width) : undefined;
  const prev = index > 0 ? done[index - 1] : undefined;
  const next = index >= 0 && index < done.length - 1 ? done[index + 1] : undefined;
  const go = (p: PageItem | undefined) => p && navigate(`/crawls/${crawlId}/pages/${p.id}?w=${width}`);

  // ← → キーで前後のページへ移る
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'ArrowLeft') go(prev);
      if (e.key === 'ArrowRight') go(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (error) return <p className={styles.error}>{error}</p>;
  if (!pages) return <p className="muted">読み込み中…</p>;
  if (!page || !shot) return <p className="muted">このページの画像は見つかりません。</p>;

  return (
    <>
      <div className={styles.head}>
        <Link to={`/crawls/${crawlId}`} className={styles.back}>
          ← 撮影結果に戻る
        </Link>
        <div className={styles.nav}>
          <span className="muted">
            {index + 1} / {done.length}
          </span>
          <button type="button" className="btn btn-sm" disabled={!prev} onClick={() => go(prev)} aria-label="前のページ">
            ← 前
          </button>
          <button type="button" className="btn btn-sm" disabled={!next} onClick={() => go(next)} aria-label="次のページ">
            次 →
          </button>
        </div>
      </div>
      <div className={styles.layout}>
        <div>
          <div className={styles.toolbar}>
            {widths.length > 1 && (
              <Segmented
                label="画面幅"
                value={shot.viewportWidth}
                options={widths.map((w) => ({ value: w, label: `${w}px` }))}
                onChange={(w) => setSearch({ w: String(w) }, { replace: true })}
              />
            )}
            <Segmented
              label="表示の大きさ"
              value={zoom}
              options={[
                { value: 'fit', label: '幅に合わせる' },
                { value: 'actual', label: '原寸' },
              ]}
              onChange={setZoom}
            />
          </div>
          <div className={`${styles.viewer} ${zoom === 'fit' ? styles.fit : ''}`}>
            <img src={shot.imageUrl} alt={`${pageName(page)}（${shot.viewportWidth}px）`} width={shot.imageWidth} height={shot.imageHeight} />
          </div>
        </div>
        <aside className={styles.info}>
          <h1 className={styles.infoTitle}>{pageName(page)}</h1>
          <dl className={styles.dl}>
            <dt>URL</dt>
            <dd>
              <a href={page.url} target="_blank" rel="noreferrer">
                {page.url}
              </a>
            </dd>
            {page.finalUrl && page.finalUrl !== page.url && (
              <>
                <dt>転送先</dt>
                <dd>{page.finalUrl}</dd>
              </>
            )}
            <dt>ステータス</dt>
            <dd>{page.httpStatus ?? '—'}</dd>
            <dt>階層</dt>
            <dd>{page.depth}</dd>
            <dt>画像</dt>
            <dd>
              {shot.imageWidth} × {shot.imageHeight}px
            </dd>
            <dt>撮影方式</dt>
            <dd>
              {shotMethodLabel[shot.method]}
              {shot.fellBack && '（展開方式から切り替え）'}
            </dd>
          </dl>
          {page.waitTimedOut && (
            <div>
              <Badge tone="warning">待ちきれずに撮影</Badge>
              <p className="muted">表示が落ち着くのを最大時間まで待ちましたが、落ち着かないまま撮りました。</p>
            </div>
          )}
          <a className="btn btn-sm" href={shot.imageUrl} target="_blank" rel="noreferrer">
            画像を新しいタブで開く
          </a>
        </aside>
      </div>
    </>
  );
}
