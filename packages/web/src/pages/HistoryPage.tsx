import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { CrawlSummary } from '@site-capture/shared';
import { CrawlStatusBadge } from '../components/StatusBadge';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/format';
import styles from './HistoryPage.module.css';

// V-04: 撮影履歴（トップ）
export function HistoryPage() {
  const [crawls, setCrawls] = useState<CrawlSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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
          <Link key={c.id} to={`/crawls/${c.id}`} className={styles.card}>
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
    </>
  );
}
