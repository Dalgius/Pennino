import { useEffect, useState, type ReactNode } from 'react';

export function Panel({
  title,
  aside,
  children,
  className,
}: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className ?? ''}`}>
      {title && (
        <header className="panel-head">
          <h3>{title}</h3>
          {aside && <div className="panel-aside">{aside}</div>}
        </header>
      )}
      <div className="panel-body">{children}</div>
    </section>
  );
}

/** Campo numerico: conferma con Invio o all'uscita, annulla con Esc */
export function NumberField({
  label,
  value,
  onChange,
  unit,
  step = 0.01,
  digits = 2,
  min,
  max,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  unit?: string;
  step?: number;
  digits?: number;
  min?: number;
  max?: number;
  disabled?: boolean;
}) {
  const [text, setText] = useState(value.toFixed(digits));
  useEffect(() => setText(value.toFixed(digits)), [value, digits]);
  const commit = () => {
    const n = parseFloat(text.replace(',', '.'));
    if (!isFinite(n)) return setText(value.toFixed(digits));
    let v = n;
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    if (Math.abs(v - value) > 1e-9) onChange(v);
    setText(v.toFixed(digits));
  };
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="field-input">
        <input
          className="mono"
          value={text}
          disabled={disabled}
          inputMode="decimal"
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') {
              setText(value.toFixed(digits));
              (e.target as HTMLInputElement).blur();
            }
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              const v = value + (e.key === 'ArrowUp' ? step : -step);
              onChange(min !== undefined ? Math.max(min, v) : v);
            }
          }}
        />
        {unit && <span className="field-unit">{unit}</span>}
      </span>
    </label>
  );
}

export function TextField({
  label,
  value,
  onChange,
  wide,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  wide?: boolean;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <label className={`field ${wide ? 'field-wide' : ''}`}>
      <span className="field-label">{label}</span>
      <span className="field-input">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => text !== value && onChange(text)}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      </span>
    </label>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="field-input">
        <select value={value} onChange={(e) => onChange(e.target.value as T)}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </span>
    </label>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  small,
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  small?: boolean;
}) {
  return (
    <div className={`segmented ${small ? 'segmented-sm' : ''}`}>
      {options.map((o) => (
        <button key={o.value} className={o.value === value ? 'on' : ''} title={o.title} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Stat({ label, value, unit, note, accent }: { label: string; value: string; unit?: string; note?: ReactNode; accent?: boolean }) {
  return (
    <div className={`stat ${accent ? 'stat-accent' : ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">
        {value}
        {unit && <span className="stat-unit">{unit}</span>}
      </div>
      {note && <div className="stat-note">{note}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function KeyHint({ k, children }: { k: string; children: ReactNode }) {
  return (
    <span className="keyhint">
      <kbd>{k}</kbd>
      {children}
    </span>
  );
}
