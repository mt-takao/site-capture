// 撮影エンジンの設定と結果の型（設計書 4.1）

// 撮影の設定は画面と共通なので packages/shared に置いている
export { DEFAULT_CAPTURE_OPTIONS, type CaptureOptions } from '@site-capture/shared';

export type SiteSettings = {
  name: string;
  hostPatterns: string[]; // 例: ['*.notion.site']
  waitForSelector?: string; // J-02
  hideSelectors: string[]; // S-05
  hideByText: string[]; // S-05 文字列で探して隠す
  scrollContainerSelector?: string; // J-03（手動指定）
  beforeCaptureScript?: string; // J-07
  expandTogglesScript?: string; // J-09（expandToggles が true のときだけ実行）
  reloadPerViewport: boolean; // 画面幅ごとに開き直すか（設計書 6.1）
  concurrency?: number; // C-11 の上書き
  intervalMs?: number; // C-11 の上書き
};

export const DEFAULT_SITE_SETTINGS: SiteSettings = {
  name: '標準',
  hostPatterns: [],
  hideSelectors: [],
  hideByText: [],
  reloadPerViewport: true,
};

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
  shots: ShotRecord[];
};

// 画面幅から画面の高さを決める。スマホ幅（768px 未満）は iPhone 相当の 812px、それ以外は 900px
export function viewportForWidth(width: number): Viewport {
  return { width, height: width < 768 ? 812 : 900 };
}
