import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import {
  DEFAULT_EXCLUDE_PATTERNS,
  defaultCrawlSettings,
  type AuthProfileItem,
  type SiteSettingsItem,
  type StartCrawlRequest,
} from '@site-capture/shared';
import { Badge } from '../components/StatusBadge';
import { api } from '../lib/api';
import styles from './NewCrawlPage.module.css';

// 設計書 9.1「撮影開始」: URL・画面幅・毎回選ぶ3つの設定を見せ、それ以外は「詳細設定」に折りたたむ

const WIDTH_PRESETS = [1920, 1440, 1280, 768, 375];

export function NewCrawlPage() {
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const fromId = Number(search.get('from')) || null;
  const defaults = defaultCrawlSettings('');
  const [url, setUrl] = useState('');
  const [widths, setWidths] = useState<number[]>(defaults.viewports);
  const [customWidth, setCustomWidth] = useState('');
  const [includeSubdomains, setIncludeSubdomains] = useState(false);
  const [keepQuery, setKeepQuery] = useState(false);
  const [sampleMode, setSampleMode] = useState<'all' | 'firstN'>('all');
  const [sampleN, setSampleN] = useState(3);
  const [maxPages, setMaxPages] = useState(defaults.maxPages);
  const [maxDepth, setMaxDepth] = useState('');
  const [excludes, setExcludes] = useState(DEFAULT_EXCLUDE_PATTERNS.join('\n'));
  const [useSitemap, setUseSitemap] = useState(true);
  const [respectRobots, setRespectRobots] = useState(true);
  const [concurrency, setConcurrency] = useState(defaults.concurrency);
  const [intervalMs, setIntervalMs] = useState(defaults.intervalMs);
  const [extraWaitMs, setExtraWaitMs] = useState(defaults.capture.extraWaitMs);
  const [maxWaitMs, setMaxWaitMs] = useState(defaults.capture.maxWaitMs);
  const [expandToggles, setExpandToggles] = useState(false);
  const [preset, setPreset] = useState<SiteSettingsItem | null>(null);
  const [siteList, setSiteList] = useState<SiteSettingsItem[]>([]);
  const [siteSettingsId, setSiteSettingsId] = useState(''); // 空なら URL から自動で選ぶ
  const [fromNote, setFromNote] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<AuthProfileItem[]>([]);
  const [authProfileId, setAuthProfileId] = useState('');
  const [authChosenByUser, setAuthChosenByUser] = useState(false);
  const [basicUser, setBasicUser] = useState('');
  const [basicPassword, setBasicPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listAuthProfiles().then(setProfiles).catch(() => setProfiles([]));
    api.listSiteSettings().then(setSiteList).catch(() => setSiteList([]));
  }, []);

  // 「同じ設定で新しく撮る」から来たときは、その撮影の設定を各欄に入れる
  useEffect(() => {
    if (!fromId) return;
    api
      .getCrawl(fromId)
      .then((c) => {
        const s = c.settings;
        setUrl(s.startUrl);
        setWidths(s.viewports);
        setIncludeSubdomains(s.includeSubdomains);
        setKeepQuery(s.keepQueryParams);
        setSampleMode(s.sampling.mode);
        if (s.sampling.mode === 'firstN') setSampleN(s.sampling.n);
        setMaxPages(s.maxPages);
        setMaxDepth(s.maxDepth == null ? '' : String(s.maxDepth));
        setExcludes(s.excludePatterns.join('\n'));
        setUseSitemap(s.useSitemap);
        setRespectRobots(s.respectRobotsTxt);
        setConcurrency(s.concurrency);
        setIntervalMs(s.intervalMs);
        setExtraWaitMs(s.capture.extraWaitMs);
        setMaxWaitMs(s.capture.maxWaitMs);
        setExpandToggles(s.capture.expandToggles);
        setSiteSettingsId(s.siteSettingsId ?? '');
        setAuthProfileId(s.authProfileId ?? '');
        setAuthChosenByUser(true);
        setFromNote(
          `撮影 #${c.id}（${c.host}）の設定を引き継ぎました。` +
            (s.usesBasicAuth ? 'Basic 認証の ID とパスワードは保存していないので、「ログイン」欄で入力し直してください。' : ''),
        );
      })
      .catch((e: Error) => setError(e.message));
  }, [fromId]);

  // URL のオリジンが一致するログイン状態を自動で選ぶ（利用者が自分で選んだ後は変えない）
  const origin = (() => {
    try {
      return new URL(url.trim()).origin;
    } catch {
      return null;
    }
  })();
  useEffect(() => {
    if (authChosenByUser) return;
    setAuthProfileId(profiles.find((p) => p.origin === origin)?.id ?? '');
  }, [origin, profiles, authChosenByUser]);

  // 入力されたURLに合うサイト設定（Notion など）を表示する
  useEffect(() => {
    if (!/^https?:\/\/[^/]+/.test(url.trim())) return setPreset(null);
    const timer = window.setTimeout(() => {
      api.matchSiteSettings(url.trim()).then(setPreset).catch(() => setPreset(null));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [url]);

  const addWidth = (w: number) => {
    if (!Number.isInteger(w) || w < 200 || w > 3840) return setError('画面幅は 200〜3840 の整数で指定してください');
    setError(null);
    setWidths((ws) => [...new Set([...ws, w])].sort((a, b) => b - a));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const settings: StartCrawlRequest = {
      startUrl: url.trim(),
      authProfileId: authProfileId || null,
      basicAuth: basicUser ? { username: basicUser, password: basicPassword } : null,
      viewports: widths,
      includeSubdomains,
      keepQueryParams: keepQuery,
      sampling: sampleMode === 'all' ? { mode: 'all' } : { mode: 'firstN', n: sampleN, prefixes: 'auto' },
      maxPages,
      maxDepth: maxDepth.trim() === '' ? null : Number(maxDepth),
      excludePatterns: excludes.split('\n'),
      useSitemap,
      respectRobotsTxt: respectRobots,
      concurrency,
      intervalMs,
      capture: { ...defaults.capture, extraWaitMs, maxWaitMs, expandToggles },
      siteSettingsId: siteSettingsId || null,
    };
    try {
      const crawl = await api.startCrawl(settings);
      navigate(`/crawls/${crawl.id}`);
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  };

  // 実際に使うサイト設定（手で選んだもの、なければ URL から自動で選ばれるもの）
  const effectiveSite = (siteSettingsId && siteList.find((s) => s.id === siteSettingsId)) || preset;
  const isNotion = !!effectiveSite?.expandTogglesScript;

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>新しく撮影</h1>
      {fromNote && <p className={styles.fromNote}>{fromNote}</p>}
      <form className={styles.form} onSubmit={submit}>
        <section className={styles.section}>
          <label className={styles.label} htmlFor="url">
            撮影するサイトのURL
          </label>
          <input
            id="url"
            className="input"
            type="url"
            required
            autoFocus
            placeholder="https://example.com/"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <p className={styles.hint}>このURLから、同じサイト内でたどれるページをすべて撮ります。</p>
          <div className={styles.preset}>
            <label htmlFor="site">サイト設定:</label>
            <select id="site" className={`input ${styles.siteSelect}`} value={siteSettingsId} onChange={(e) => setSiteSettingsId(e.target.value)}>
              <option value="">自動（{preset ? preset.name : 'URL に合うもの'}）</option>
              {siteList.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.hostPatterns.length > 0 ? `（${s.hostPatterns.join(', ')}）` : ''}
                </option>
              ))}
            </select>
            {effectiveSite && effectiveSite.name !== '標準' && <Badge tone="accent">{effectiveSite.name}</Badge>}
            <Link to="/settings#site-settings">サイト設定を編集</Link>
          </div>
          {effectiveSite?.intervalMs != null && (
            <p className={styles.hint}>
              このサイト設定では、{effectiveSite.intervalMs / 1000}秒以上の間隔・同時に{effectiveSite.concurrency ?? concurrency}ページ以下で撮ります
            </p>
          )}
        </section>

        <section className={styles.section}>
          <span className={styles.label}>画面幅</span>
          <div className={styles.chips}>
            {widths.map((w) => (
              <span key={w} className={styles.chip}>
                {w}px
                <button
                  type="button"
                  className={styles.chipRemove}
                  aria-label={`${w}px を外す`}
                  onClick={() => setWidths((ws) => ws.filter((x) => x !== w))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <div className={styles.inline}>
            {WIDTH_PRESETS.filter((w) => !widths.includes(w)).map((w) => (
              <button key={w} type="button" className="btn btn-sm" onClick={() => addWidth(w)}>
                + {w}px
              </button>
            ))}
            <input
              className={`input ${styles.small}`}
              inputMode="numeric"
              placeholder="幅を入力"
              aria-label="追加する画面幅"
              value={customWidth}
              onChange={(e) => setCustomWidth(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addWidth(Number(customWidth));
                  setCustomWidth('');
                }
              }}
            />
            <button
              type="button"
              className="btn btn-sm"
              disabled={!customWidth}
              onClick={() => {
                addWidth(Number(customWidth));
                setCustomWidth('');
              }}
            >
              追加
            </button>
          </div>
        </section>

        <section className={styles.section}>
          <label className={styles.label} htmlFor="auth">
            ログイン
          </label>
          <select
            id="auth"
            className="input"
            value={authProfileId}
            onChange={(e) => {
              setAuthProfileId(e.target.value);
              setAuthChosenByUser(true);
            }}
          >
            <option value="">ログインしない</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}（{p.origin}）
              </option>
            ))}
          </select>
          <p className={styles.hint}>
            ログインが必要なページを撮るときは、保存したログイン状態を選びます。
            {profiles.length === 0 ? 'まだありません。' : ''}
            <Link to={`/settings${url.trim() ? `?url=${encodeURIComponent(url.trim())}` : ''}`}>ログイン状態を作る</Link>
          </p>
          <details className={styles.details}>
            <summary>Basic認証（ID とパスワードの入力画面が出るサイト）</summary>
            <div className={styles.fieldGrid}>
              <label className={styles.field}>
                ID
                <input className="input" autoComplete="off" value={basicUser} onChange={(e) => setBasicUser(e.target.value)} />
              </label>
              <label className={styles.field}>
                パスワード
                <input
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={basicPassword}
                  onChange={(e) => setBasicPassword(e.target.value)}
                />
              </label>
            </div>
            <p className={styles.hint}>この撮影の間だけ使い、保存しません。起点のURLと同じサイトにだけ送ります。</p>
          </details>
        </section>

        <section className={styles.section}>
          <span className={styles.label}>巡回の範囲</span>
          <label className={styles.choice}>
            <input type="checkbox" checked={includeSubdomains} onChange={(e) => setIncludeSubdomains(e.target.checked)} />
            <span>
              サブドメインも巡回する
              <p className={styles.hint}>例: www.example.com から shop.example.com へのリンクもたどる</p>
            </span>
          </label>
          <label className={styles.choice}>
            <input type="checkbox" checked={keepQuery} onChange={(e) => setKeepQuery(e.target.checked)} />
            <span>
              パラメータだけが違うURLを別ページとして撮る
              <p className={styles.hint}>例: ?page=2 や ?id=123。オフなら、パラメータを無視して1枚だけ撮る</p>
            </span>
          </label>
          <div className={styles.choice}>
            <input
              type="checkbox"
              id="sample"
              checked={sampleMode === 'firstN'}
              onChange={(e) => setSampleMode(e.target.checked ? 'firstN' : 'all')}
            />
            <span>
              <label htmlFor="sample">同じ階層のページは先頭の数件だけ撮る</label>
              <span className={styles.inline}>
                <input
                  className={`input ${styles.small}`}
                  type="number"
                  min={1}
                  value={sampleN}
                  disabled={sampleMode === 'all'}
                  aria-label="撮る件数"
                  onChange={(e) => setSampleN(Number(e.target.value))}
                />
                <span className="muted">件</span>
              </span>
              <p className={styles.hint}>ブログ記事や商品詳細のように、同じ型のページが多いサイト向け。トップ直下のページは間引かない</p>
            </span>
          </div>
        </section>

        <section className={styles.section}>
          <details className={styles.details}>
            <summary>詳細設定</summary>
            <div className={styles.detailsBody}>
              <div className={styles.fieldGrid}>
                <label className={styles.field}>
                  最大ページ数
                  <input className="input" type="number" min={1} value={maxPages} onChange={(e) => setMaxPages(Number(e.target.value))} />
                </label>
                <label className={styles.field}>
                  最大階層（空欄で制限なし）
                  <input className="input" type="number" min={0} value={maxDepth} onChange={(e) => setMaxDepth(e.target.value)} />
                </label>
                <label className={styles.field}>
                  同時に開くページ数
                  <input className="input" type="number" min={1} max={5} value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))} />
                </label>
                <label className={styles.field}>
                  アクセス間隔（ミリ秒）
                  <input className="input" type="number" min={0} step={100} value={intervalMs} onChange={(e) => setIntervalMs(Number(e.target.value))} />
                </label>
                <label className={styles.field}>
                  撮影前の待ち時間（ミリ秒）
                  <input className="input" type="number" min={0} step={100} value={extraWaitMs} onChange={(e) => setExtraWaitMs(Number(e.target.value))} />
                </label>
                <label className={styles.field}>
                  表示を待つ最大時間（ミリ秒）
                  <input className="input" type="number" min={1000} step={1000} value={maxWaitMs} onChange={(e) => setMaxWaitMs(Number(e.target.value))} />
                </label>
              </div>
              <label className={styles.field}>
                除外するURLのパターン（1行に1つ。* でワイルドカード、* なしは部分一致）
                <textarea className="input" rows={5} value={excludes} onChange={(e) => setExcludes(e.target.value)} />
              </label>
              <label className={styles.choice}>
                <input type="checkbox" checked={useSitemap} onChange={(e) => setUseSitemap(e.target.checked)} />
                <span>sitemap.xml に載っているページも撮る</span>
              </label>
              <label className={styles.choice}>
                <input type="checkbox" checked={respectRobots} onChange={(e) => setRespectRobots(e.target.checked)} />
                <span>robots.txt で禁止されたページは撮らない</span>
              </label>
              <label className={styles.choice}>
                <input type="checkbox" checked={expandToggles} onChange={(e) => setExpandToggles(e.target.checked)} />
                <span>
                  Notion のトグルを開いて撮る
                  {!isNotion && <p className={styles.hint}>Notion の公開ページ（*.notion.site）でだけ働きます</p>}
                </span>
              </label>
            </div>
          </details>
        </section>

        {error && <div className={styles.error}>{error}</div>}
        <div className={styles.actions}>
          <button type="submit" className="btn btn-primary" disabled={submitting || !url.trim() || widths.length === 0}>
            {submitting ? '開始しています…' : '撮影を始める'}
          </button>
        </div>
      </form>
    </div>
  );
}
