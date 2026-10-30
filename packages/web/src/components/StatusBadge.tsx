import type { CrawlStatus, PageStatus } from '@site-capture/shared';
import { crawlStatusLabel, pageStatusLabel } from '../lib/format';
import styles from './StatusBadge.module.css';

type Tone = 'neutral' | 'success' | 'danger' | 'warning' | 'accent';

export function Badge({ tone = 'neutral', live = false, children }: { tone?: Tone; live?: boolean; children: React.ReactNode }) {
  return (
    <span className={`${styles.badge} ${tone !== 'neutral' ? styles[tone] : ''}`}>
      {live && <span className={`${styles.dot} ${styles.pulse}`} />}
      {children}
    </span>
  );
}

const crawlTone: Record<CrawlStatus, Tone> = { queued: 'neutral', running: 'accent', done: 'success', stopped: 'neutral', error: 'danger' };
const pageTone: Record<PageStatus, Tone> = { queued: 'neutral', capturing: 'accent', done: 'success', failed: 'danger', skipped: 'neutral' };

export function CrawlStatusBadge({ status }: { status: CrawlStatus }) {
  return (
    <Badge tone={crawlTone[status]} live={status === 'running'}>
      {crawlStatusLabel[status]}
    </Badge>
  );
}

export function PageStatusBadge({ status }: { status: PageStatus }) {
  return (
    <Badge tone={pageTone[status]} live={status === 'capturing'}>
      {pageStatusLabel[status]}
    </Badge>
  );
}
