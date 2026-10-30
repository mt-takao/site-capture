import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { AuthProfileItem, LoginSessionInfo } from '@site-capture/shared';
import { SiteSettingsSection } from '../components/SiteSettingsSection';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/format';
import styles from './SettingsPage.module.css';

// 設計書 9.1「設定」: ログイン状態の作成と削除（L-01〜L-03）と、サイト設定の編集（S-05, J-02, J-03, J-07）

export function SettingsPage() {
  const [search] = useSearchParams();
  const [profiles, setProfiles] = useState<AuthProfileItem[] | null>(null);
  const [name, setName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const [url, setUrl] = useState(search.get('url') ?? '');
  const [session, setSession] = useState<LoginSessionInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = () => api.listAuthProfiles().then(setProfiles).catch((e: Error) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  // 名前を手で編集するまでは、URL のホスト名を名前の候補として入れ続ける
  useEffect(() => {
    if (nameEdited) return;
    try {
      setName(new URL(url).host);
    } catch {
      setName('');
    }
  }, [url, nameEdited]);

  // 利用者がブラウザのウィンドウを閉じたことに気づけるよう、開いている間は状態を確かめ続ける
  useEffect(() => {
    if (!session || session.status !== 'open') return;
    const timer = window.setInterval(() => {
      api
        .getLoginSession(session.id)
        .then((s) => s.status === 'closed' && setSession(s))
        .catch(() => setSession(null));
    }, 1500);
    return () => window.clearInterval(timer);
  }, [session]);

  const open = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setSession(await api.openLoginSession(name, url));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      const profile = await api.saveLoginSession(session.id);
      setNotice(`「${profile.name}」のログイン状態を保存しました。撮影開始の画面で選べます。`);
      setSession(null);
      setNameEdited(false);
      setUrl('');
      await load();
    } catch (err) {
      setError((err as Error).message);
      setSession(null);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (session) await api.cancelLoginSession(session.id).catch(() => {});
    setSession(null);
  };

  const remove = async (p: AuthProfileItem) => {
    if (!window.confirm(`「${p.name}」のログイン状態を削除します。よろしいですか？`)) return;
    try {
      await api.deleteAuthProfile(p.id);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>設定</h1>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>ログイン状態</h2>
        <p className={styles.hint}>
          ログインが必要なページを撮るために、ログインした後の状態（Cookie など）を保存します。パスワードは保存しません。
          ログインが切れたら作り直してください。
        </p>

        {!session && (
          <form className={styles.form} onSubmit={open}>
            <label className={styles.field}>
              名前
              <input
                className="input"
                required
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameEdited(true);
                }}
                placeholder="例: 社内ポータル"
              />
            </label>
            <label className={styles.field}>
              ログインするページのURL
              <input className="input" type="url" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/login" />
            </label>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              ログイン用ブラウザを開く
            </button>
          </form>
        )}

        {session?.status === 'open' && (
          <div className={styles.session} role="status">
            <strong>ログイン用のブラウザを開きました</strong>
            <ol className={styles.steps}>
              <li>別のウィンドウで開いたブラウザで、いつもどおりログインしてください。</li>
              <li>ログインが終わったら、下の「ログイン状態を保存」を押してください。ブラウザは自動で閉じます。</li>
            </ol>
            <div className={styles.actions}>
              <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
                ログイン状態を保存
              </button>
              <button type="button" className="btn" onClick={cancel} disabled={busy}>
                やめる
              </button>
            </div>
          </div>
        )}

        {session?.status === 'closed' && (
          <div className={styles.error}>
            ブラウザが閉じられたため、保存できませんでした。
            <button type="button" className="btn btn-sm" style={{ marginLeft: 8 }} onClick={() => setSession(null)}>
              やり直す
            </button>
          </div>
        )}

        {error && <div className={styles.error}>{error}</div>}
        {notice && <div className={styles.notice}>{notice}</div>}

        {profiles && profiles.length === 0 && <p className={styles.empty}>保存したログイン状態はありません</p>}
        {profiles && profiles.length > 0 && (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>名前</th>
                <th>サイト</th>
                <th className={styles.hideNarrow}>作成</th>
                <th className={styles.hideNarrow}>最後に使った日</th>
                <th>
                  <span className="muted">操作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {profiles.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td className="mono">{p.origin}</td>
                  <td className={styles.hideNarrow}>{formatDateTime(p.createdAt)}</td>
                  <td className={styles.hideNarrow}>{formatDateTime(p.lastUsedAt)}</td>
                  <td>
                    <button type="button" className="btn btn-sm btn-danger" onClick={() => remove(p)}>
                      削除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <SiteSettingsSection />
    </div>
  );
}
