import { useRef } from 'react';
import type { ShotItem } from '@site-capture/shared';
import styles from './CompareViewer.module.css';

// 設計書 9.4: 左右に並べる（スクロール連動）、半透明で重ねる、スライダーの3つの表示

export type CompareMode = 'side' | 'overlay' | 'swipe';

type Props = {
  a: ShotItem | undefined;
  b: ShotItem | undefined;
  labelA: string;
  labelB: string;
  mode: CompareMode;
  opacity: number; // 重ねるときの A の不透明度（0〜100）
  split: number; // スライダーの境目の位置（0〜100、左側が A）
  onSplitChange: (v: number) => void;
};

export function CompareViewer({ a, b, labelA, labelB, mode, opacity, split, onSplitChange }: Props) {
  const labels = (
    <div className={styles.labels}>
      <span className={styles.tag}>
        <span className={styles.tagA}>A</span>
        {labelA}
      </span>
      <span className={styles.tag}>
        {labelB}
        <span className={styles.tagB}>B</span>
      </span>
    </div>
  );

  if (!a || !b) {
    const only = a ?? b;
    return (
      <div className={styles.single}>
        {labels}
        <div className={`${styles.scroll} ${styles.checker}`}>{only && <img src={only.imageUrl} alt="" />}</div>
      </div>
    );
  }

  if (mode === 'side') return <SideBySide a={a} b={b} labels={labels} />;

  // 同じ画面幅の画像なので幅は同じ。表示する幅は画像の幅を上限にする
  const maxWidth = Math.max(a.imageWidth, b.imageWidth);
  return (
    <div>
      {labels}
      <div className={`${styles.scroll} ${styles.checker}`}>
        {mode === 'overlay' ? (
          <div className={styles.stage} style={{ maxWidth }}>
            <img src={b.imageUrl} alt="B" />
            <img src={a.imageUrl} alt="A" style={{ opacity: opacity / 100 }} />
          </div>
        ) : (
          <Swipe a={a} b={b} maxWidth={maxWidth} split={split} onSplitChange={onSplitChange} />
        )}
      </div>
    </div>
  );
}

// 左右に並べる。どちらかをスクロールすると、もう片方も同じ位置（上からの距離）にスクロールする
function SideBySide({ a, b, labels }: { a: ShotItem; b: ShotItem; labels: React.ReactNode }) {
  const left = useRef<HTMLDivElement>(null);
  const right = useRef<HTMLDivElement>(null);
  // 相手をスクロールさせたことで起きる scroll イベントで、こちらを動かし返さないための目印
  const syncing = useRef<HTMLDivElement | null>(null);

  const sync = (from: HTMLDivElement | null, to: HTMLDivElement | null) => {
    if (!from || !to) return;
    if (syncing.current === from) {
      syncing.current = null;
      return;
    }
    if (to.scrollTop === from.scrollTop) return;
    syncing.current = to;
    to.scrollTop = from.scrollTop;
  };

  return (
    <div>
      {labels}
      <div className={styles.side}>
        <div ref={left} className={`${styles.scroll} ${styles.checker}`} onScroll={() => sync(left.current, right.current)}>
          <img src={a.imageUrl} alt="A" />
        </div>
        <div ref={right} className={`${styles.scroll} ${styles.checker}`} onScroll={() => sync(right.current, left.current)}>
          <img src={b.imageUrl} alt="B" />
        </div>
      </div>
    </div>
  );
}

// スライダー。境目の左側に A、右側に B を表示する。画像の上をドラッグしても境目を動かせる
function Swipe({
  a,
  b,
  maxWidth,
  split,
  onSplitChange,
}: {
  a: ShotItem;
  b: ShotItem;
  maxWidth: number;
  split: number;
  onSplitChange: (v: number) => void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const move = (clientX: number) => {
    const rect = stage.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    onSplitChange(Math.round(Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100))));
  };
  return (
    <div
      ref={stage}
      className={`${styles.stage} ${styles.swipe}`}
      style={{ maxWidth }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        move(e.clientX);
      }}
      onPointerMove={(e) => e.buttons === 1 && move(e.clientX)}
    >
      {/* B も境目の右側だけに切り取る。A が B より短いとき、左側の足りない部分に B が見えず市松模様になるように */}
      <img src={b.imageUrl} alt="B" draggable={false} style={{ clipPath: `inset(0 0 0 ${split}%)` }} />
      <img src={a.imageUrl} alt="A" draggable={false} style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }} />
      <div className={styles.divider} style={{ left: `${split}%` }}>
        <div className={styles.handle} aria-hidden="true">
          ⇔
        </div>
      </div>
    </div>
  );
}
