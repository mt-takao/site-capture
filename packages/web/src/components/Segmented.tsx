import styles from './Segmented.module.css';

// 画面幅やフィルターの切り替えに使う、ボタンを並べた選択部品
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className={styles.group} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" className={styles.item} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
