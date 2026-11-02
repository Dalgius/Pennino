import type { Vec2 } from '../model/types';

/** Riquadro di selezione: pieno (finestra) da sinistra a destra, tratteggiato (intersezione) al contrario */
export function Marquee({ m }: { m: { a: Vec2; b: Vec2 } | null }) {
  if (!m) return null;
  return (
    <rect
      x={Math.min(m.a.x, m.b.x)}
      y={-Math.max(m.a.y, m.b.y)}
      width={Math.abs(m.b.x - m.a.x)}
      height={Math.abs(m.b.y - m.a.y)}
      className={m.b.x < m.a.x ? 'marquee marquee-cross' : 'marquee'}
      pointerEvents="none"
    />
  );
}

/** Riepilogo di una selezione multipla */
export function MultiSelection({ labels, onDelete, onClear }: { labels: string[]; onDelete: () => void; onClear: () => void }) {
  const counts = labels.reduce<Record<string, number>>((acc, k) => ((acc[k] = (acc[k] ?? 0) + 1), acc), {});
  return (
    <div className="inspector">
      <div className="insp-kicker">Selezione multipla</div>
      <h2 className="insp-title">{labels.length} oggetti</h2>
      <div className="kv-grid kv-1">
        {Object.entries(counts).map(([k, n]) => (
          <div key={k}>
            <span>{k}</span>
            <b className="mono">{n}</b>
          </div>
        ))}
      </div>
      <p className="note">Trascina per spostarli insieme · Maiusc + clic o riquadro per aggiungere · Canc per eliminare.</p>
      <div className="insp-actions">
        <button className="btn" onClick={onClear}>Deseleziona</button>
        <button className="btn btn-danger" onClick={onDelete}>Elimina selezione</button>
      </div>
    </div>
  );
}
