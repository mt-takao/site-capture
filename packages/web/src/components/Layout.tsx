import { Link, NavLink, Outlet } from 'react-router';
import styles from './Layout.module.css';

export function Layout() {
  const navClass = ({ isActive }: { isActive: boolean }) => `${styles.navLink} ${isActive ? styles.active : ''}`;
  return (
    <>
      <header className={styles.header}>
        <Link to="/" className={styles.brand}>
          <svg className={styles.logo} viewBox="0 0 32 32" aria-hidden="true">
            <rect x="3" y="6" width="26" height="20" rx="3" fill="currentColor" />
            <circle cx="16" cy="16" r="5" fill="var(--surface)" />
          </svg>
          Site Capture
        </Link>
        <nav className={styles.nav}>
          <NavLink to="/" end className={navClass}>
            撮影履歴
          </NavLink>
          <NavLink to="/new" className={navClass}>
            新しく撮影
          </NavLink>
          <NavLink to="/compare" className={navClass}>
            比較
          </NavLink>
          <NavLink to="/settings" className={navClass}>
            設定
          </NavLink>
        </nav>
      </header>
      <main className={styles.main}>
        <Outlet />
      </main>
    </>
  );
}
