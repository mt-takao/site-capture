import type { Sampling } from './types.js';

// 設計書 5.3「間引き」（C-03b）

// パスの最後の区切りを除いた部分。例: /blog/2026/hello → /blog/2026/、/about → /
export function groupKey(url: string): string {
  const path = new URL(url).pathname;
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i + 1);
}

export class Sampler {
  private counts = new Map<string, number>();

  constructor(private readonly sampling: Sampling) {}

  // このURLを撮るなら true（数を数える）。間引くなら false
  admit(url: string): boolean {
    if (this.sampling.mode === 'all') return true;
    const key = groupKey(url);
    if (!this.isTarget(key)) return true;
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    return n <= this.sampling.n;
  }

  private isTarget(key: string): boolean {
    if (this.sampling.mode !== 'firstN') return false;
    // 'auto' はトップ直下（/about、/contact のように型の違うページが並ぶ階層）以外のすべて
    if (this.sampling.prefixes === 'auto') return key !== '/';
    return this.sampling.prefixes.some((p) => key.startsWith(p.endsWith('/') ? p : `${p}/`));
  }
}
