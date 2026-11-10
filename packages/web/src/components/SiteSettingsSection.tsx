import { useEffect, useState } from 'react';
import { DEFAULT_SITE_SETTINGS, MAX_CLICK_STATES_PER_PAGE, type SiteSettings, type SiteSettingsItem } from '@site-capture/shared';
import { api } from '../lib/api';
import { Badge } from './StatusBadge';
import styles from './SiteSettingsSection.module.css';

// サイト設定（S-05, J-02, J-03, J-07）の一覧と編集。組み込みのプリセットは見ることと複製だけができる

type Draft = {
  id: string | null; // null なら新規
  name: string;
  hostPatterns: string;
  waitForSelector: string;
  hideSelectors: string;
  hideByText: string;
  scrollContainerSelector: string;
  beforeCaptureScript: string;
  expandTogglesScript: string;
  reloadPerViewport: boolean;
  clickSelectors: string;
  concurrency: string;
  intervalMs: string;
};

const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);

function toDraft(s: SiteSettings, id: string | null): Draft {
  return {
    id,
    name: s.name,
    hostPatterns: s.hostPatterns.join('\n'),
    waitForSelector: s.waitForSelector ?? '',
    hideSelectors: s.hideSelectors.join('\n'),
    hideByText: s.hideByText.join('\n'),
    scrollContainerSelector: s.scrollContainerSelector ?? '',
    beforeCaptureScript: s.beforeCaptureScript ?? '',
    expandTogglesScript: s.expandTogglesScript ?? '',
    reloadPerViewport: s.reloadPerViewport,
    clickSelectors: (s.clickSelectors ?? []).join('\n'),
    concurrency: s.concurrency == null ? '' : String(s.concurrency),
    intervalMs: s.intervalMs == null ? '' : String(s.intervalMs),
  };
}

function fromDraft(d: Draft): SiteSettings {
  return {
    name: d.name,
    hostPatterns: lines(d.hostPatterns.replace(/[\s,]+/g, '\n')),
    waitForSelector: d.waitForSelector || undefined,
    hideSelectors: lines(d.hideSelectors),
    hideByText: lines(d.hideByText),
    scrollContainerSelector: d.scrollContainerSelector || undefined,
    beforeCaptureScript: d.beforeCaptureScript || undefined,
    expandTogglesScript: d.expandTogglesScript || undefined,
    reloadPerViewport: d.reloadPerViewport,
    clickSelectors: lines(d.clickSelectors),
    concurrency: d.concurrency === '' ? undefined : Number(d.concurrency),
    intervalMs: d.intervalMs === '' ? undefined : Number(d.intervalMs),
  };
}

export function SiteSettingsSection() {
  const [items, setItems] = useState<SiteSettingsItem[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [viewing, setViewing] = useState<SiteSettingsItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.listSiteSettings().then(setItems).catch((e: Error) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const body = fromDraft(draft);
      if (draft.id) await api.updateSiteSettings(draft.id, body);
      else await api.createSiteSettings(body);
      setDraft(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (s: SiteSettingsItem) => {
    if (!window.confirm(`サイト設定「${s.name}」を削除します。よろしいですか？`)) return;
    try {
      await api.deleteSiteSettings(s.id);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => (d ? { ...d, [key]: value } : d));

  return (
    <section className={styles.section} id="site-settings">
      <div className={styles.head}>
        <h2 className={styles.title}>サイト設定</h2>
        {!draft && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setViewing(null);
              setDraft(toDraft({ ...DEFAULT_SITE_SETTINGS, name: '' }, null));
            }}
          >
            ＋ 新しく作る
          </button>
        )}
      </div>
      <p className={styles.hint}>
        サイトごとに、撮る前に隠す要素や待つ要素、撮影前に実行するスクリプトを決めておけます。撮影するURLのホストに合う設定が自動で使われます（自分で作った設定は組み込みより優先されます）。
      </p>

      {draft && (
        <form className={styles.form} onSubmit={save}>
          <div className={styles.grid}>
            <label className={styles.field}>
              名前
              <input className="input" required value={draft.name} onChange={(e) => set('name', e.target.value)} placeholder="例: 自社コーポレートサイト" />
            </label>
            <label className={styles.field}>
              対象のホスト（1行に1つ）
              <textarea className="input" rows={2} value={draft.hostPatterns} onChange={(e) => set('hostPatterns', e.target.value)} placeholder={'example.com\n*.example.com'} />
              <span className={styles.note}>*.example.com はサブドメインすべてに当てはまります</span>
            </label>
            <label className={styles.field}>
              隠す要素（CSS セレクタ、1行に1つ）
              <textarea className="input" rows={3} value={draft.hideSelectors} onChange={(e) => set('hideSelectors', e.target.value)} placeholder={'#cookie-banner\n.chat-widget'} />
              <span className={styles.note}>Cookie 同意バナーやチャットなど</span>
            </label>
            <label className={styles.field}>
              文字列で探して隠す要素（1行に1つ）
              <textarea className="input" rows={3} value={draft.hideByText} onChange={(e) => set('hideByText', e.target.value)} placeholder="無料で試す" />
              <span className={styles.note}>クラス名が自動で作られるサイト向け。文字列が一致するボタン・リンクごと隠します</span>
            </label>
            <label className={styles.field}>
              表示を待つ要素（CSS セレクタ）
              <input className="input mono" value={draft.waitForSelector} onChange={(e) => set('waitForSelector', e.target.value)} placeholder="main article" />
            </label>
            <label className={styles.field}>
              スクロール領域（CSS セレクタ。空なら自動で見つける）
              <input className="input mono" value={draft.scrollContainerSelector} onChange={(e) => set('scrollContainerSelector', e.target.value)} placeholder=".content-scroller" />
            </label>
            <label className={styles.field}>
              同時に開くページ数（空なら撮影ごとの設定）
              <input className="input" type="number" min={1} max={5} value={draft.concurrency} onChange={(e) => set('concurrency', e.target.value)} />
            </label>
            <label className={styles.field}>
              アクセス間隔（ミリ秒。空なら撮影ごとの設定）
              <input className="input" type="number" min={0} step={1000} value={draft.intervalMs} onChange={(e) => set('intervalMs', e.target.value)} />
            </label>
          </div>
          <label className={styles.field}>
            押してから撮る要素（CSS セレクタ、1行に1つ）
            <textarea className="input mono" rows={2} value={draft.clickSelectors} onChange={(e) => set('clickSelectors', e.target.value)} placeholder={'[data-case]\nbutton[aria-haspopup="dialog"]'} />
            <span className={styles.note}>
              押したときだけ開くダイアログなどを撮ります。当てはまる要素を1つずつ押し、開いた画面を元のページとは別の画像として撮ります（1ページに{MAX_CLICK_STATES_PER_PAGE}個まで）。送信や削除のボタンには当てはまらないように書いてください
            </span>
          </label>
          <label className={styles.field}>
            撮影前に実行するスクリプト（JavaScript）
            <textarea className="input" rows={5} value={draft.beforeCaptureScript} onChange={(e) => set('beforeCaptureScript', e.target.value)} placeholder="document.querySelector('.modal-close')?.click();" />
            <span className={styles.note}>ページを開いて表示が落ち着いた後に、そのページの中で実行します。await も使えます</span>
          </label>
          <label className={styles.check}>
            <input type="checkbox" checked={!draft.reloadPerViewport} onChange={(e) => set('reloadPerViewport', !e.target.checked)} />
            1回の読み込みで、画面幅を切り替えながら撮る（アクセス制限の厳しいサイト向け）
          </label>
          {error && <div className={styles.error}>{error}</div>}
          <div className={styles.actions}>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              保存
            </button>
            <button type="button" className="btn" onClick={() => setDraft(null)}>
              やめる
            </button>
          </div>
        </form>
      )}

      {!draft && error && <div className={styles.error}>{error}</div>}

      {items && (
        <ul className={styles.list}>
          {items.map((s) => (
            <li key={s.id} className={styles.item}>
              <div className={styles.itemMain}>
                <span className={styles.itemName}>
                  {s.name}
                  {s.builtin && <Badge>組み込み</Badge>}
                </span>
                <span className={styles.itemHosts}>{s.hostPatterns.length > 0 ? s.hostPatterns.join(', ') : 'ほかのどれにも当てはまらないサイト'}</span>
              </div>
              <div className={styles.actions}>
                {s.builtin ? (
                  <button type="button" className="btn btn-sm" onClick={() => setViewing(viewing?.id === s.id ? null : s)}>
                    {viewing?.id === s.id ? '閉じる' : '中身を見る'}
                  </button>
                ) : (
                  <button type="button" className="btn btn-sm" onClick={() => setDraft(toDraft(s, s.id))}>
                    編集
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    setViewing(null);
                    setDraft(toDraft({ ...s, name: `${s.name}のコピー` }, null));
                  }}
                >
                  複製
                </button>
                {!s.builtin && (
                  <button type="button" className="btn btn-sm btn-danger" onClick={() => remove(s)}>
                    削除
                  </button>
                )}
              </div>
              {viewing?.id === s.id && <pre className={styles.view}>{JSON.stringify(fromDraft(toDraft(s, s.id)), null, 2)}</pre>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
