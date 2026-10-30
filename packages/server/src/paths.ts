import { homedir } from 'node:os';
import { join } from 'node:path';

// 設計書 3.2「保存データ」。保存先のルートは環境変数 SITE_CAPTURE_HOME で変えられる
export function dataRoot(): string {
  return process.env.SITE_CAPTURE_HOME ?? join(homedir(), 'SiteCapture');
}

export function databasePath(root = dataRoot()): string {
  return join(root, 'site-capture.db');
}

// 例: ~/SiteCapture/captures/example.com/20261030-153012
export function captureDir(host: string, date: Date, root = dataRoot()): string {
  return join(root, 'captures', host, timestamp(date));
}

function timestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
