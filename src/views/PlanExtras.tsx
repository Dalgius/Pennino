// Ciò che in pianta non è un elemento costruttivo: locali, annotazioni libere, stati di progetto.
// Disegnato dentro PlanView, quindi compare sia nell'editor sia sulle tavole.

import type { Annotation, Project, Vec2, Wall } from '../model/types';
import { add, byId, columnQuad, dist, mul, norm, slabOutline, sub, wallSegmentQuad } from '../model/geometry';
import { roomInfo } from '../model/rooms';
import { statusOf } from '../model/states';
import { wallGeom, wallOutline } from '../model/walls';

const P = (list: Vec2[]) => list.map((p) => `${p.x},${-p.y}`).join(' ');
const INK = 'var(--hatch-ink, #1b1b1b)';
const SEL = '#1f7ab8';
const m2 = (v: number) => `${v.toFixed(2).replace('.', ',')} m²`;

/** Colori convenzionali delle tavole comparative */
export const DEMOLITION_COLOR = '#e3b700';
export const CONSTRUCTION_COLOR = '#d93a2b';

/** Etichette dei locali: nome e superficie netta; il locale selezionato mostra il suo contorno */
export function RoomLabels({ project: p, levelId, mm, ts, selected }: { project: Project; levelId: string; mm: number; ts: number; selected: Set<string> }) {
  const rooms = (p.rooms ?? []).filter((r) => r.levelId === levelId);
  if (!rooms.length) return null;
  const font = 2.6 * mm * ts;
  return (
    <g className="pv-rooms">
      {rooms.map((r) => {
        const info = roomInfo(p, r);
        const on = selected.has(r.id);
        return (
          <g key={r.id}>
            {on && info.shape && <polygon points={P(info.shape.net)} fill={SEL} fillOpacity={0.12} stroke={SEL} strokeWidth={0.4 * mm} />}
            <text x={r.p.x} y={-r.p.y} fontSize={font} textAnchor="middle" fill={on ? SEL : INK} stroke="none" style={{ fontWeight: 600, letterSpacing: '0.04em' }}>
              {r.name.toUpperCase()}
            </text>
            <text x={r.p.x} y={-r.p.y + font * 1.25} fontSize={font * 0.85} textAnchor="middle" fill={info.shape ? (on ? SEL : INK) : CONSTRUCTION_COLOR} stroke="none">
              {info.shape ? m2(info.area) : 'vano non chiuso'}
            </text>
          </g>
        );
      })}
    </g>
  );
}

/** Punti caratteristici di un'annotazione (per selezione e spostamento) */
export function annotationPoints(n: Annotation): Vec2[] {
  if (n.kind === 'quota') return [n.a, n.b];
  if (n.kind === 'testo') return n.leader ? [n.p, n.leader] : [n.p];
  return [n.p];
}

/** Linea di quota di un'annotazione «quota»: estremi sulla linea e posizione del testo */
export function quotaGeometry(n: Extract<Annotation, { kind: 'quota' }>) {
  const d = norm(sub(n.b, n.a));
  const out = { x: -d.y, y: d.x };
  const a = add(n.a, mul(out, n.offset));
  const b = add(n.b, mul(out, n.offset));
  return { d, out, a, b, mid: mul(add(a, b), 0.5), len: dist(n.a, n.b) };
}

export function Annotations({ project: p, levelId, mm, ts, selected }: { project: Project; levelId: string; mm: number; ts: number; selected: Set<string> }) {
  const list = (p.annotations ?? []).filter((n) => n.levelId === levelId);
  if (!list.length) return null;
  const font = 2 * mm * ts;
  const lvl = byId(p.levels, levelId);
  return (
    <g className="pv-annotations" fill="none">
      {list.map((n) => {
        const c = selected.has(n.id) ? SEL : INK;
        if (n.kind === 'quota') {
          const g = quotaGeometry(n);
          const tick = 1.1 * mm * ts;
          const diag = mul(add(g.d, g.out), tick * 0.7);
          let ang = (Math.atan2(-g.d.y, g.d.x) * 180) / Math.PI;
          const flip = ang > 90 || ang <= -90;
          if (flip) ang += 180;
          const t = add(g.mid, mul(g.out, (flip ? -1 : 1) * font * 0.35 * (n.offset < 0 ? -1 : 1)));
          return (
            <g key={n.id} stroke={c} strokeWidth={0.13 * mm}>
              <line x1={n.a.x} y1={-n.a.y} x2={g.a.x} y2={-g.a.y} strokeWidth={0.09 * mm} />
              <line x1={n.b.x} y1={-n.b.y} x2={g.b.x} y2={-g.b.y} strokeWidth={0.09 * mm} />
              <line x1={g.a.x} y1={-g.a.y} x2={g.b.x} y2={-g.b.y} />
              {[g.a, g.b].map((q, i) => (
                <line key={i} x1={q.x + diag.x} y1={-(q.y + diag.y)} x2={q.x - diag.x} y2={-(q.y - diag.y)} strokeWidth={0.35 * mm} />
              ))}
              <text x={t.x} y={-t.y} fontSize={font} textAnchor="middle" fill={c} stroke="none" transform={`rotate(${ang} ${t.x} ${-t.y})`}>
                {(Math.round(g.len * 100 + 1e-6) / 100).toFixed(2)}
              </text>
            </g>
          );
        }
        if (n.kind === 'testo') {
          const lines = n.text.split('\n');
          return (
            <g key={n.id} stroke={c} strokeWidth={0.13 * mm}>
              {n.leader && (
                <>
                  <line x1={n.p.x} y1={-n.p.y + font * 0.3} x2={n.leader.x} y2={-n.leader.y} />
                  <circle cx={n.leader.x} cy={-n.leader.y} r={0.45 * mm} fill={c} stroke="none" />
                </>
              )}
              <text x={n.p.x} y={-n.p.y} fontSize={font * 1.15} fill={c} stroke="none">
                {lines.map((l, i) => (
                  <tspan key={i} x={n.p.x} dy={i ? font * 1.4 : 0}>
                    {l || ' '}
                  </tspan>
                ))}
              </text>
            </g>
          );
        }
        // quota altimetrica: triangolo pieno a metà e quota del piano finito
        const z = (lvl?.elevation ?? 0) + n.dz;
        const r = 1.6 * mm * ts;
        const label = `${z > 0 ? '+' : z < 0 ? '−' : '±'}${Math.abs(z).toFixed(2).replace('.', ',')}`;
        return (
          <g key={n.id} stroke={c} strokeWidth={0.13 * mm}>
            <polygon points={`${n.p.x - r},${-n.p.y - r * 1.2} ${n.p.x + r},${-n.p.y - r * 1.2} ${n.p.x},${-n.p.y}`} />
            <polygon points={`${n.p.x - r},${-n.p.y - r * 1.2} ${n.p.x},${-n.p.y - r * 1.2} ${n.p.x},${-n.p.y}`} fill={c} stroke="none" />
            <line x1={n.p.x - r} y1={-n.p.y - r * 1.2} x2={n.p.x + r * 5} y2={-n.p.y - r * 1.2} />
            <text x={n.p.x + r * 1.4} y={-n.p.y - r * 1.5} fontSize={font} fill={c} stroke="none">
              {label}
            </text>
          </g>
        );
      })}
    </g>
  );
}

/** Comparativa: demolizioni in giallo, nuove costruzioni in rosso, sopra il disegno */
export function StatusOverlay({ project: p, levelId, mm }: { project: Project; levelId: string; mm: number }) {
  const shapes: { id: string; poly: Vec2[]; color: string }[] = [];
  for (const e of p.elements) {
    const s = statusOf(e);
    if (s === 'esistente') continue;
    const color = s === 'demolito' ? DEMOLITION_COLOR : CONSTRUCTION_COLOR;
    if (e.kind === 'opening') {
      const w = p.elements.find((x) => x.id === e.wallId);
      const t = byId(p.catalog.opening, e.typeId);
      if (!w || w.kind !== 'wall' || w.levelId !== levelId || !t || statusOf(w) === s) continue;
      shapes.push({ id: e.id, poly: wallSegmentQuad(w, 2 * wallGeom(p, w).half, e.offset - t.width / 2, e.offset + t.width / 2), color });
      continue;
    }
    if (e.levelId !== levelId) continue;
    if (e.kind === 'wall') shapes.push({ id: e.id, poly: wallOutline(wallGeom(p, e)), color });
    else if (e.kind === 'column') shapes.push({ id: e.id, poly: columnQuad(e, byId(p.catalog.column, e.typeId)), color });
    else if (e.kind === 'beam') shapes.push({ id: e.id, poly: wallSegmentQuad(e as unknown as Wall, byId(p.catalog.beam, e.typeId)?.width ?? 0.3, 0, dist(e.a, e.b)), color });
    else if (e.kind === 'slab') shapes.push({ id: e.id, poly: slabOutline(p, e), color });
  }
  if (!shapes.length) return null;
  return (
    <g className="pv-status" pointerEvents="none">
      {shapes.map((s) => (
        <polygon key={s.id} points={P(s.poly)} fill={s.color} fillOpacity={0.45} stroke={s.color} strokeWidth={0.35 * mm} />
      ))}
    </g>
  );
}
