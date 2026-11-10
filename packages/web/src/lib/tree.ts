import type { PageItem } from '@site-capture/shared';

// V-02: URL の階層でページをまとめる。/about/company は /about の下に入る

export type TreeNode = {
  segment: string; // 例: about
  prefix: string; // 例: /about
  page: PageItem | null; // そのパスちょうどのページ
  children: TreeNode[];
  count: number; // 配下（自分を含む）のページ数
};

export function buildTree(pages: PageItem[]): TreeNode {
  const root: TreeNode = { segment: '/', prefix: '/', page: null, children: [], count: 0 };
  for (const p of pages) {
    const pathOnly = p.path.split(/[?#]/)[0]!;
    const segments = pathOnly.split('/').filter(Boolean);
    let node = root;
    node.count++;
    for (const [i, seg] of segments.entries()) {
      const prefix = '/' + segments.slice(0, i + 1).join('/');
      let child = node.children.find((c) => c.segment === seg);
      if (!child) {
        child = { segment: seg, prefix, page: null, children: [], count: 0 };
        node.children.push(child);
      }
      child.count++;
      node = child;
    }
    // クエリ付きのページと、要素を押して撮ったページ（#click-n）は同じパスの下にまとめ、パスちょうどのページを優先して表示する
    if (!/[?#]/.test(p.path) && node.page && /[?#]/.test(node.page.path)) node.page = p;
    else node.page ??= p;
  }
  const sort = (n: TreeNode) => {
    n.children.sort((a, b) => a.segment.localeCompare(b.segment, 'ja'));
    n.children.forEach(sort);
  };
  sort(root);
  return root;
}

export function inPrefix(p: PageItem, prefix: string): boolean {
  if (prefix === '/') return true;
  const path = p.path.split(/[?#]/)[0]!;
  return path === prefix || path.startsWith(prefix + '/');
}
