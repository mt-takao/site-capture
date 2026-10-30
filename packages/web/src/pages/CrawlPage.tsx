import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { PageItem } from '@site-capture/shared';
import { Segmented } from '../components/Segmented';
import { Badge, CrawlStatusBadge, PageStatusBadge } from '../components/StatusBadge';
import { api, useCrawl } from '../lib/api';
import { formatDateTime, formatDuration, pageName, shotFor, skipReasonLabel } from '../lib/format';
import { buildTree, inPrefix, type TreeNode } from '../lib/tree';
import styles from './CrawlPage.module.css';

// 設計書 9.1「撮影結果」: 上部に進捗、左にURLの階層、右にサムネイルの格子（V-01〜V-03, S-07）

type Filter = 'all' | 'done' | 'failed' | 'timedOut' | 'skipped';

export function CrawlPage() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const { crawl, pages, warnings, error } = useCrawl(id);
  const [width, setWidth] = useState<number | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [prefix, setPrefix] = useState('/');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const viewports = crawl?.viewports ?? [];
  const currentWidth = width ?? viewports[0] ?? 1440;
  const running = crawl?.status === 'running' || crawl?.status === 'queued';

  // 対象外のページは「対象外」で絞り込んだときだけ表示する
  const listed = useMemo(() => pages.filter((p) => (filter === 'skipped' ? p.status === 'skipped' : p.status !== 'skipped')), [pages, filter]);
  const tree = useMemo(() => buildTree(listed), [listed]);
  const visible = useMemo(
    () =>
      listed.filter((p) => {
        if (!inPrefix(p, prefix)) return false;
        if (filter === 'done') return p.status === 'done';
        if (filter === 'failed') return p.status === 'failed';
        if (filter === 'timedOut') return p.waitTimedOut;
        return true;
      }),
    [listed, filter, prefix],
  );

  if (error) return <p className={styles.errorBox}>{error}</p>;
  if (!crawl) return <p className="muted">読み込み中…</p>;

  const counts = crawl.counts;
  const target = counts.found - counts.skipped;
  const progress = target > 0 ? Math.round(((counts.done + counts.failed) / target) * 100) : 0;
  const timedOutCount = pages.filter((p) => p.waitTimedOut).length;

  const stop = async () => {
    setBusy(true);
    setActionError(null);
    try {
      await api.stopCrawl(id);
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!window.confirm('この撮影結果と画像をすべて削除します。よろしいですか？')) return;
    setBusy(true);
    try {
      await api.deleteCrawl(id);
      navigate('/');
    } catch (e) {
      setActionError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <>
      <div className={styles.head}>
        <div>
          <div className={styles.titleRow}>
            <h1 className={styles.title}>{crawl.host}</h1>
            <CrawlStatusBadge status={crawl.status} />
          </div>
          <div className={styles.sub}>
            <a href={crawl.startUrl} target="_blank" rel="noreferrer">
              {crawl.startUrl}
            </a>
            <span>開始 {formatDateTime(crawl.startedAt ?? crawl.createdAt)}</span>
            <span>所要時間 {formatDuration(crawl.startedAt, crawl.finishedAt)}</span>
            <span>サイト設定: {crawl.siteSettingsName}</span>
            {crawl.settings.authProfileId && <span>ログイン状態: {crawl.authProfileName ?? '（削除済み）'}</span>}
          </div>
        </div>
        <div className={styles.headActions}>
          {running ? (
            <button type="button" className="btn" onClick={stop} disabled={busy}>
              停止
            </button>
          ) : (
            <>
              <Link to={`/compare?b=${id}`} className="btn">
                ほかの撮影と比較
              </Link>
              <button type="button" className="btn btn-danger" onClick={remove} disabled={busy}>
                削除
              </button>
            </>
          )}
        </div>
      </div>

      <section className={styles.progress} aria-label="撮影の進み具合">
        <div className={styles.stats}>
          <Stat label="見つけたページ" value={counts.found} />
          <Stat label="撮影済み" value={counts.done} />
          <Stat label="失敗" value={counts.failed} danger={counts.failed > 0} />
          <Stat label="対象外" value={counts.skipped} />
          {timedOutCount > 0 && <Stat label="待ちきれずに撮影" value={timedOutCount} />}
        </div>
        <div className={styles.bar} role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
          <div className={`${styles.barFill} ${running ? '' : styles.barDone}`} style={{ width: `${running ? progress : 100}%` }} />
        </div>
        {warnings.length > 0 && (
          <ul className={styles.warnings}>
            {warnings.slice(-3).map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        )}
        {crawl.errorMessage && <div className={styles.errorBox}>エラー: {crawl.errorMessage}</div>}
        {actionError && <div className={styles.errorBox}>{actionError}</div>}
      </section>

      <div className={styles.toolbar}>
        {viewports.length > 1 && (
          <>
            <span className={styles.toolbarLabel}>画面幅</span>
            <Segmented label="画面幅" value={currentWidth} options={viewports.map((w) => ({ value: w, label: `${w}px` }))} onChange={setWidth} />
          </>
        )}
        <span className={styles.spacer} />
        <Segmented<Filter>
          label="絞り込み"
          value={filter}
          onChange={(f) => {
            setFilter(f);
            setPrefix('/');
          }}
          options={[
            { value: 'all', label: 'すべて' },
            { value: 'done', label: '撮影済み' },
            { value: 'failed', label: `失敗 ${counts.failed}` },
            { value: 'timedOut', label: `待ちきれず ${timedOutCount}` },
            { value: 'skipped', label: `対象外 ${counts.skipped}` },
          ]}
        />
      </div>

      <div className={styles.body}>
        <nav className={styles.tree} aria-label="URLの階層">
          <ul className={styles.treeList}>
            <TreeItem node={tree} selected={prefix} onSelect={setPrefix} label={`すべて（${crawl.host}）`} />
          </ul>
        </nav>
        <div>
          {visible.length === 0 ? (
            <p className={styles.empty}>{running ? 'ページを探しています…' : '該当するページはありません'}</p>
          ) : (
            <div className={`${styles.grid} ${currentWidth < 768 ? styles.gridNarrow : ''}`}>
              {visible.map((p) => (
                <PageCard key={p.id} page={p} crawlId={id} width={currentWidth} />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function Stat({ label, value, danger = false }: { label: string; value: number; danger?: boolean }) {
  return (
    <div className={`${styles.stat} ${danger ? styles.statDanger : ''}`}>
      <span className={styles.statValue}>{value}</span>
      <span className={styles.statLabel}>{label}</span>
    </div>
  );
}

function TreeItem({ node, selected, onSelect, label }: { node: TreeNode; selected: string; onSelect: (p: string) => void; label?: string }) {
  return (
    <li>
      <button
        type="button"
        className={`${styles.treeItem} ${selected === node.prefix ? styles.treeItemActive : ''}`}
        onClick={() => onSelect(node.prefix)}
        title={node.prefix}
      >
        <span className={styles.treeName}>{label ?? `/${node.segment}`}</span>
        <span className={styles.treeCount}>{node.count}</span>
      </button>
      {node.children.length > 0 && (
        <ul className={styles.treeList}>
          {node.children.map((c) => (
            <TreeItem key={c.prefix} node={c} selected={selected} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </li>
  );
}

function PageCard({ page, crawlId, width }: { page: PageItem; crawlId: number; width: number }) {
  const shot = shotFor(page, width);
  const content = (
    <>
      <div className={`${styles.thumb} ${width >= 768 ? styles.thumbWide : ''}`}>
        {shot ? (
          <img src={shot.thumbUrl} alt="" loading="lazy" />
        ) : (
          <div className={styles.thumbEmpty}>
            {page.status === 'skipped' && page.skipReason ? skipReasonLabel[page.skipReason] : page.status === 'failed' ? '撮影に失敗しました' : '撮影待ち'}
          </div>
        )}
      </div>
      <div className={styles.cardBody}>
        <span className={styles.cardTitle} title={pageName(page)}>
          {pageName(page)}
        </span>
        <span className={styles.cardPath} title={page.url}>
          {page.path}
        </span>
        {page.status !== 'done' || page.waitTimedOut || (page.httpStatus ?? 200) >= 400 ? (
          <div className={styles.cardBadges}>
            {page.status !== 'done' && <PageStatusBadge status={page.status} />}
            {page.waitTimedOut && <Badge tone="warning">待ちきれずに撮影</Badge>}
            {(page.httpStatus ?? 200) >= 400 && <Badge tone="warning">HTTP {page.httpStatus}</Badge>}
          </div>
        ) : null}
        {page.errorMessage && <span className={styles.cardError}>{page.errorMessage}</span>}
      </div>
    </>
  );
  return page.status === 'done' ? (
    <Link to={`/crawls/${crawlId}/pages/${page.id}?w=${width}`} className={styles.card}>
      {content}
    </Link>
  ) : (
    <div className={styles.card}>{content}</div>
  );
}
