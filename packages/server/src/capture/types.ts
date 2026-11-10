// 撮影エンジンの設定と結果の型（設計書 4.1）

// 撮影の設定は画面と共通なので packages/shared に置いている
export { DEFAULT_CAPTURE_OPTIONS, type CaptureOptions } from '@site-capture/shared';

// サイト設定は画面でも編集するので packages/shared に置いている
export { DEFAULT_SITE_SETTINGS, type SiteSettings } from '@site-capture/shared';

export type Viewport = { width: number; height: number };

export type ShotRecord = {
  viewportWidth: number;
  filePath: string;
  thumbPath: string;
  imageWidth: number;
  imageHeight: number;
  method: 'fullpage' | 'tiled' | 'expand' | 'stitch';
  fellBackToStitch: boolean;
  waitTimedOut: boolean;
};

// J-10: 押してから撮る要素。セレクタに当てはまる「見えている要素」のうち何番目か（index、0 から）で指す。
// no はそのページの中での通し番号（1 から）。ファイル名と、撮影結果の中での区別に使う
export type ClickTarget = { selector: string; index: number; no: number; label: string };

export type CapturePageResult = {
  url: string;
  finalUrl: string;
  httpStatus: number | null;
  title: string;
  links: string[]; // いちばん広い画面幅で集めたリンク（絶対URL、未正規化）
  hasPasswordField: boolean; // 見えているパスワードの入力欄があるか（ログイン画面が写っていないかの判定に使う）
  clickTargets: ClickTarget[]; // J-10: サイト設定の clickSelectors に当てはまった要素（押して撮るページの撮影では空）
  shots: ShotRecord[];
};

// 画面幅から画面の高さを決める。スマホ幅（768px 未満）は iPhone 相当の 812px、それ以外は 900px
export function viewportForWidth(width: number): Viewport {
  return { width, height: width < 768 ? 812 : 900 };
}
