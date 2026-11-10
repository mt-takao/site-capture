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

export type CapturePageResult = {
  url: string;
  finalUrl: string;
  httpStatus: number | null;
  title: string;
  links: string[]; // いちばん広い画面幅で集めたリンク（絶対URL、未正規化）
  hasPasswordField: boolean; // 見えているパスワードの入力欄があるか（ログイン画面が写っていないかの判定に使う）
  shots: ShotRecord[];
};

// 画面幅から画面の高さを決める。スマホ幅（768px 未満）は iPhone 相当の 812px、それ以外は 900px
export function viewportForWidth(width: number): Viewport {
  return { width, height: width < 768 ? 812 : 900 };
}
