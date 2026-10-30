import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { CrawlSummary } from '@site-capture/shared';
import { CrawlStatusBadge } from '../components/StatusBadge';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/format';
import styles from './HistoryPage.module.css';

// V-04: 撮影履歴（トップ）
export function HistoryPage() {
  const [crawls, setCrawls] = useState<CrawlSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const navigate = useNavigate();

  // 比較する2件を選ぶ。3件目を選んだら、先に選んだほうを外す
  const toggle = (id: number) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id].slice(-2)));

  const compare = () => {
    // 古いほうを A（比べる元）、新しいほうを B（比べる先）にする
    const [a, b] = selected
      .map((id) => crawls!.find((c) => c.id === id)!)
      .sort((x, y) => x.createdAt.localeCompare(y.createdAt));
    navigate(`/compare?a=${a!.id}&b=${b!.id}`);
  };

  useEffect(() => {
    const load = () => api.listCrawls().then(setCrawls).catch((e: Error) => setError(e.message));
    load();
    // 撮影中のものがあれば、件数を最新にするため定期的に読み直す
    const timer = window.setInterval(load, 5000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <>
      <div className={styles.head}>
        <h1 className={styles.title}>撮影履歴</h1>
        <Link to="/new" className="btn btn-primary">
          新しく撮影
        </Link>
      </div>
      {error && <p className={styles.failed}>{error}</p>}
      {crawls?.length === 0 && (
        <div className={styles.empty}>
          <p>まだ撮影していません。</p>
          <p>URLを1つ入れると、そのサイトのページを巡回して全部撮ります。</p>
          <Link to="/new" className="btn btn-primary">
            最初の撮影を始める
          </Link>
        </div>
      )}
      <div className={styles.grid}>
        {crawls?.map((c) => (
          <Link key={c.id} to={`/crawls/${c.id}`} className={`${styles.card} ${selected.includes(c.id) ? styles.cardSelected : ''}`}>
            <label
              className={styles.check}
              onClick={(e) => {
                // カードのリンクに飛ばず、選択だけを切り替える
                e.preventDefault();
                e.stopPropagation();
                toggle(c.id);
              }}
            >
              <input type="checkbox" checked={selected.includes(c.id)} readOnly aria-label={`${c.host} の撮影を比較に選ぶ`} />
            </label>
            <div className={styles.thumb}>
              {c.thumbUrl ? <img src={c.thumbUrl} alt="" loading="lazy" /> : <div className={styles.thumbEmpty}>画像なし</div>}
            </div>
            <div className={styles.body}>
              <div className={styles.row}>
                <span className={styles.host}>{c.host}</span>
                <CrawlStatusBadge status={c.status} />
              </div>
              <span className={styles.url}>{c.startUrl}</span>
              <div className={styles.meta}>
                <span>{formatDateTime(c.createdAt)}</span>
                <span>{c.counts.done}ページ</span>
                {c.counts.failed > 0 && <span className={styles.failed}>失敗 {c.counts.failed}</span>}
                <span>{c.viewports.join(' / ')}px</span>
              </div>
            </div>
          </Link>
        ))}
      </div>
      {selected.length > 0 && (
        <div className={styles.compareBar} role="region" aria-label="比較">
          <span>{selected.length === 1 ? '比べるもう1件を選んでください' : '2件を選びました'}</span>
          <button type="button" className="btn btn-primary" disabled={selected.length < 2} onClick={compare}>
            比較する
          </button>
          <button type="button" className="btn" onClick={() => setSelected([])}>
            選択を解除
          </button>
        </div>
      )}
    </>
  );
}
