// 共通スタイルは部品ごとのスタイル（CSS Modules）より先に読み込む。後から読むと .input の幅などが部品側の指定を上書きしてしまう
import './styles/global.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router';
import { Layout } from './components/Layout';
import { ComparePage } from './pages/ComparePage';
import { CrawlPage } from './pages/CrawlPage';
import { HistoryPage } from './pages/HistoryPage';
import { NewCrawlPage } from './pages/NewCrawlPage';
import { PageDetailPage } from './pages/PageDetailPage';
import { SettingsPage } from './pages/SettingsPage';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<HistoryPage />} />
          <Route path="new" element={<NewCrawlPage />} />
          <Route path="crawls/:id" element={<CrawlPage />} />
          <Route path="crawls/:id/pages/:pageId" element={<PageDetailPage />} />
          <Route path="compare" element={<ComparePage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<p className="muted">ページが見つかりません。</p>} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
