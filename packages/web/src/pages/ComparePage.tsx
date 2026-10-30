import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { ComparePair, ComparePairStatus, CompareResult, CrawlSummary } from '@site-capture/shared';
import { CompareViewer, type CompareMode } from '../components/CompareViewer';
import { Segmented } from '../components/Segmented';
import { Badge } from '../components/StatusBadge';
import { api } from '../lib/api';
import { formatDateTime, shotFor } from '../lib/format';
import styles from './ComparePage.module.css';

// V-05, V-05a, V-05b: 2つの撮影結果を、同じパスのページどうしで見比べる。
// 比べる2件・画面幅・表示中のページ・表示方法は URL に持たせ、開き直しても同じ表示になるようにする

type Filter = 'all' | ComparePairStatus;

const statusLabel: Record<ComparePairStatus, string> = { both: '両方', added: '追加', removed: '削除' };

export function ComparePage() {
  const [search, setSearch] = useSearchParams();
  const [crawls, setCrawls] = useState<CrawlSummary[] | null>(null);
  const [result, setResult] = useState<CompareResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [opacity, setOpacity] = useState(50);
  const [split, setSplit] = useState(50);

  const a = Number(search.get('a')) || null;
  const b = Number(search.get('b')) || null;
  const mode = (search.get('mode') as CompareMode | null) ?? 'side';
  const update = (patch: Record<string, string | number | null>) => {
    const next = new URLSearchParams(search);
    for (const [k, v] of Object.entries(patch)) {
      if (v == null) next.delete(k);
      else next.set(k, String(v));
    }
    setSearch(next, { replace: true });
  };

  useEffect(() => {
    api.listCrawls().then(setCrawls).catch((e: Error) => setError(e.message));
  }, []);

  // B だけ指定されたら、同じサイトの1つ前の撮影を A にする（撮影結果の画面の「比較」から来たとき）
  useEffect(() => {
    if (!crawls || a || !b) return;
    const target = crawls.find((c) => c.id === b);
    const candidates = crawls.filter((c) => c.id !== b);
    const previous =
      candidates.find((c) => c.host === target?.host && c.createdAt < (target?.createdAt ?? '')) ??
      candidates.find((c) => c.host === target?.host) ??
      candidates[0];
    if (previous) update({ a: previous.id });
  }, [crawls, a, b]);

  useEffect(() => {
    setResult(null);
    setError(null);
    if (!a || !b) return;
    api.compare(a, b).then(setResult).catch((e: Error) => setError(e.message));
  }, [a, b]);

  const width = Number(search.get('w')) || result?.commonWidths[0] || 0;
  const pairs = useMemo(() => (result?.pairs ?? []).filter((p) => filter === 'all' || p.status === filter), [result, filter]);
  const counts = useMemo(() => {
    const c = { both: 0, added: 0, removed: 0 };
    for (const p of result?.pairs ?? []) c[p.status]++;
    return c;
  }, [result]);
  const key = search.get('key');
  const current: ComparePair | undefined = pairs.find((p) => p.key === key) ?? pairs[0];
  const index = current ? pairs.indexOf(current) : -1;

  // ← → キーで前後のページへ移る
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
      const next = e.key === 'ArrowLeft' ? pairs[index - 1] : e.key === 'ArrowRight' ? pairs[index + 1] : undefined;
      if (next) update({ key: next.key });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const crawlLabel = (c: CrawlSummary | undefined) => (c ? `${c.host}　${formatDateTime(c.createdAt)}` : '');
  const crawlOptions = (crawls ?? []).map((c) => (
    <option key={c.id} value={c.id}>
      #{c.id} {crawlLabel(c)}（{c.counts.done}ページ）
    </option>
  ));

  return (
    <>
      <h1 className={styles.title}>比較</h1>
      <div className={styles.head}>
        <label className={styles.pick}>
          <span className={styles.pickLabel}>
            <span className={styles.tagA}>A</span>比べる元
          </span>
          <select className="input" value={a ?? ''} onChange={(e) => update({ a: e.target.value || null, key: null })}>
            <option value="">選んでください</option>
            {crawlOptions}
          </select>
        </label>
        <button type="button" className="btn" onClick={() => update({ a: b, b: a })} disabled={!a || !b} aria-label="A と B を入れ替える">
          ⇄ 入れ替え
        </button>
        <label className={styles.pick}>
          <span className={styles.pickLabel}>
            <span className={styles.tagB}>B</span>比べる先
          </span>
          <select className="input" value={b ?? ''} onChange={(e) => update({ b: e.target.value || null, key: null })}>
            <option value="">選んでください</option>
            {crawlOptions}
          </select>
        </label>
      </div>

      {error && <p className={styles.error}>{error}</p>}
      {(!a || !b) && !error && <p className={styles.message}>比べる撮影を2つ選んでください。</p>}
      {result && result.commonWidths.length === 0 && (
        <p className={styles.message}>2つの撮影に共通する画面幅がないため、比べられません。同じ画面幅で撮った撮影を選んでください。</p>
      )}

      {result && result.commonWidths.length > 0 && (
        <>
          <div className={styles.toolbar}>
            {result.commonWidths.length > 1 && (
              <Segmented label="画面幅" value={width} options={result.commonWidths.map((w) => ({ value: w, label: `${w}px` }))} onChange={(w) => update({ w })} />
            )}
            <Segmented<CompareMode>
              label="表示方法"
              value={mode}
              onChange={(m) => update({ mode: m })}
              options={[
                { value: 'side', label: '左右に並べる' },
                { value: 'overlay', label: '重ねる' },
                { value: 'swipe', label: 'スライダー' },
              ]}
            />
            {mode === 'overlay' && current?.status === 'both' && (
              <label className={styles.range}>
                A の濃さ
                <input type="range" min={0} max={100} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} />
                {opacity}%
              </label>
            )}
            {mode === 'swipe' && current?.status === 'both' && (
              <label className={styles.range}>
                境目
                <input type="range" min={0} max={100} value={split} onChange={(e) => setSplit(Number(e.target.value))} />
              </label>
            )}
            <span className={styles.spacer} />
            <button type="button" className="btn btn-sm" disabled={index <= 0} onClick={() => update({ key: pairs[index - 1]!.key })}>
              ← 前
            </button>
            <button type="button" className="btn btn-sm" disabled={index < 0 || index >= pairs.length - 1} onClick={() => update({ key: pairs[index + 1]!.key })}>
              次 →
            </button>
          </div>

          <div className={styles.body}>
            <div className={styles.list}>
              <Segmented<Filter>
                label="絞り込み"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: 'all', label: `すべて ${result.pairs.length}` },
                  { value: 'both', label: `両方 ${counts.both}` },
                  { value: 'added', label: `追加 ${counts.added}` },
                  { value: 'removed', label: `削除 ${counts.removed}` },
                ]}
              />
              <ul className={styles.items}>
                {pairs.map((p) => (
                  <li key={p.key}>
                    <button
                      type="button"
                      className={`${styles.item} ${p === current ? styles.itemActive : ''}`}
                      onClick={() => update({ key: p.key })}
                      aria-current={p === current}
                    >
                      <span className={styles.itemRow}>
                        <span className={styles.itemPath} title={p.key}>
                          {p.key}
                        </span>
                        {p.status !== 'both' && <Badge tone={p.status === 'added' ? 'success' : 'danger'}>{statusLabel[p.status]}</Badge>}
                      </span>
                      <span className={styles.itemTitle}>{(p.b ?? p.a)?.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              {current ? (
                <CompareViewer
                  key={`${current.key}-${width}`}
                  a={current.a ? shotFor(current.a, width) : undefined}
                  b={current.b ? shotFor(current.b, width) : undefined}
                  labelA={current.a ? `${crawlLabel(result.a)}` : 'A にはこのページがありません（追加されたページ）'}
                  labelB={current.b ? `${crawlLabel(result.b)}` : 'B にはこのページがありません（削除されたページ）'}
                  mode={mode}
                  opacity={opacity}
                  split={split}
                  onSplitChange={setSplit}
                />
              ) : (
                <p className={styles.message}>該当するページはありません</p>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}
