// Pianta di un livello generata dal modello.
// Usata sia dall'editor (fase 02) sia dai fogli di stampa (fase 03): stesso disegno, stessi dati.
// Coordinate in metri; l'asse Y del modello è ribaltato per l'SVG.

import type { Project, Vec2, Wall } from '../model/types';
import {
  add,
  bbox,
  byId,
  centroid,
  columnQuad,
  dist,
  dot,
  levelAbove,
  mul,
  norm,
  openingSpans,
  perp,
  sub,
  wallEndExtensions,
  wallLength,
  wallSegmentQuad,
  wallThickness,
} from '../model/geometry';

export const Y = (p: Vec2) => -p.y;
export const pts = (list: Vec2[]) => list.map((p) => `${p.x},${-p.y}`).join(' ');

interface Props {
  project: Project;
  levelId: string;
  /** Metri corrispondenti a 1 mm di carta (o all'equivalente a schermo) */
  mm: number;
  showDimensions?: boolean;
  showLabels?: boolean;
  selectedIds?: string[];
  ghostLevelId?: string;
  /** Ingrandimento dei testi a schermo (1 = dimensione di stampa) */
  textScale?: number;
}

export function PlanView({ project: p, levelId, mm, showDimensions, showLabels, selectedIds = [], ghostLevelId, textScale = 1 }: Props) {
  const ts = textScale;
  const els = p.elements;
  const onLevel = <T extends { levelId: string }>(e: T) => e.levelId === levelId;
  const walls = els.filter((e): e is Wall => e.kind === 'wall' && onLevel(e));
  const slabs = els.filter((e) => e.kind === 'slab' && onLevel(e));
  const columns = els.filter((e) => e.kind === 'column' && onLevel(e));
  const beams = els.filter((e) => e.kind === 'beam' && onLevel(e));
  const stairs = els.filter((e) => e.kind === 'stair' && onLevel(e));
  const roofs = els.filter((e) => e.kind === 'roof' && onLevel(e));
  const sel = new Set(selectedIds);
  const lvl = byId(p.levels, levelId);
  const nextLvl = levelAbove(p, levelId);

  const thin = 0.13 * mm;
  const med = 0.25 * mm;

  return (
    <g className="plan">
      {ghostLevelId && <GhostWalls project={p} levelId={ghostLevelId} mm={mm} />}

      {slabs.map(
        (s) =>
          s.kind === 'slab' && (
            <polygon key={s.id} points={pts(s.points)} className="pv-slab" strokeWidth={thin} />
          ),
      )}

      {roofs.map((r) => {
        if (r.kind !== 'roof') return null;
        const b = bbox(r.points);
        const o = r.overhang;
        const outline =
          r.shape === 'falde'
            ? [
                { x: b.minX - o, y: b.minY - o },
                { x: b.maxX + o, y: b.minY - o },
                { x: b.maxX + o, y: b.maxY + o },
                { x: b.minX - o, y: b.maxY + o },
              ]
            : r.points;
        const alongX = b.w >= b.h;
        return (
          <g key={r.id} className="pv-roof" strokeWidth={med} strokeDasharray={`${3 * mm} ${1.5 * mm}`}>
            <polygon points={pts(outline)} />
            {r.shape === 'falde' &&
              (alongX ? (
                <line x1={b.minX - o} y1={-(b.minY + b.h / 2)} x2={b.maxX + o} y2={-(b.minY + b.h / 2)} />
              ) : (
                <line x1={b.minX + b.w / 2} y1={-(b.minY - o)} x2={b.minX + b.w / 2} y2={-(b.maxY + o)} />
              ))}
          </g>
        );
      })}

      {stairs.map((s) => {
        if (s.kind !== 'stair') return null;
        const L = dist(s.a, s.b);
        const d = norm(sub(s.b, s.a));
        const n = mul(perp(d), s.width / 2);
        const rise = nextLvl ? nextLvl.elevation - (lvl?.elevation ?? 0) : lvl?.height ?? 3;
        const steps = Math.max(2, Math.ceil(rise / 0.18));
        const tread = L / steps;
        const quad = [add(s.a, n), add(s.b, n), sub(s.b, n), sub(s.a, n)];
        return (
          <g key={s.id} className="pv-stair" strokeWidth={thin}>
            <polygon points={pts(quad)} />
            {Array.from({ length: steps - 1 }, (_, i) => {
              const c = add(s.a, mul(d, tread * (i + 1)));
              const p1 = add(c, n);
              const p2 = sub(c, n);
              return <line key={i} x1={p1.x} y1={-p1.y} x2={p2.x} y2={-p2.y} />;
            })}
            <polyline
              points={pts([s.a, add(s.b, mul(d, -tread * 0.6))])}
              strokeWidth={med}
              markerEnd="url(#pv-arrow)"
            />
          </g>
        );
      })}

      {walls.map((w) => (
        <WallPlan key={w.id} project={p} wall={w} mm={mm} />
      ))}

      {columns.map((c) => {
        if (c.kind !== 'column') return null;
        return <polygon key={c.id} points={pts(columnQuad(c, byId(p.catalog.column, c.typeId)))} className="pv-column" />;
      })}

      {beams.map((b) => {
        if (b.kind !== 'beam') return null;
        const t = byId(p.catalog.beam, b.typeId);
        const q = wallSegmentQuad({ ...b, kind: 'wall', typeId: '', levelId: '' } as Wall, t?.width ?? 0.3, 0, dist(b.a, b.b));
        return (
          <polygon
            key={b.id}
            points={pts(q)}
            className="pv-beam"
            strokeWidth={med}
            strokeDasharray={`${2 * mm} ${1 * mm}`}
          />
        );
      })}

      {showDimensions && <WallDimensions project={p} walls={walls} mm={mm} ts={ts} />}

      {showLabels &&
        walls.map((w) => {
          const c = centroid([w.a, w.b]);
          const t = byId(p.catalog.wall, w.typeId);
          return (
            <text
              key={`l${w.id}`}
              x={c.x}
              y={-c.y - wallThickness(t) / 2 - 1.2 * mm}
              className="pv-label"
              fontSize={2 * mm * ts}
              textAnchor="middle"
            >
              {wallLength(w).toFixed(2)}
            </text>
          );
        })}

      {/* Evidenziazione selezione */}
      {els
        .filter((e) => sel.has(e.id))
        .map((e) => (
          <SelectionOutline key={`sel${e.id}`} project={p} id={e.id} mm={mm} levelId={levelId} />
        ))}
      <defs>
        <marker id="pv-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="pv-arrowhead" />
        </marker>
      </defs>
    </g>
  );
}

function WallPlan({ project: p, wall: w, mm }: { project: Project; wall: Wall; mm: number }) {
  const t = byId(p.catalog.wall, w.typeId);
  const th = wallThickness(t);
  const L = wallLength(w);
  const ext = wallEndExtensions(p, w);
  const spans = openingSpans(p, w);
  const pieces: [number, number][] = [];
  let cur = -ext.a;
  for (const s of spans) {
    if (s.start > cur) pieces.push([cur, s.start]);
    cur = Math.max(cur, s.end);
  }
  if (L + ext.b > cur) pieces.push([cur, L + ext.b]);
  const d = norm(sub(w.b, w.a));
  const n = perp(d);
  const isLayered = mm < 0.08 && t && t.layers.length > 1; // a scala ≥ 1:50 si vedono gli strati

  return (
    <g>
      {pieces.map(([s0, s1], i) =>
        isLayered ? (
          <g key={i}>
            {layerQuads(w, t!.layers, s0, s1).map((q, j) => (
              <polygon key={j} points={pts(q.quad)} fill={q.color} className="pv-layer" strokeWidth={0.1 * mm} />
            ))}
          </g>
        ) : (
          <polygon key={i} points={pts(wallSegmentQuad(w, th, s0, s1))} className="pv-wall" />
        ),
      )}
      {spans.map(({ opening: o, type, start, end }) => {
        const p0 = add(w.a, mul(d, start));
        const p1 = add(w.a, mul(d, end));
        const half = mul(n, th / 2);
        if (type.category === 'finestra') {
          const g1 = add(p0, mul(n, th * 0.08));
          const g2 = add(p1, mul(n, th * 0.08));
          const h1 = sub(p0, mul(n, th * 0.08));
          const h2 = sub(p1, mul(n, th * 0.08));
          const o1 = add(p0, half);
          const o2 = add(p1, half);
          const i1 = sub(p0, half);
          const i2 = sub(p1, half);
          return (
            <g key={o.id} className="pv-window" strokeWidth={0.18 * mm}>
              <polyline points={pts([o1, i1])} />
              <polyline points={pts([o2, i2])} />
              <polyline points={pts([g1, g2])} />
              <polyline points={pts([h1, h2])} />
              {type.sill > 0 && <polyline points={pts([o1, o2])} strokeWidth={0.1 * mm} />}
            </g>
          );
        }
        // Porta: anta e arco di apertura
        const side = o.flip ? -1 : 1;
        const hinge = sub(p0, mul(n, (side * th) / 2));
        const width = end - start;
        const leafEnd = sub(hinge, mul(n, side * width));
        const farJamb = sub(p1, mul(n, (side * th) / 2));
        const sweep = side > 0 ? 0 : 1;
        return (
          <g key={o.id} className="pv-door" strokeWidth={0.18 * mm}>
            <polyline points={pts([hinge, leafEnd])} strokeWidth={0.3 * mm} />
            <path
              d={`M${leafEnd.x},${-leafEnd.y} A${width},${width} 0 0 ${sweep} ${farJamb.x},${-farJamb.y}`}
              strokeDasharray={`${0.8 * mm} ${0.6 * mm}`}
            />
          </g>
        );
      })}
    </g>
  );
}

function layerQuads(w: Wall, layers: { thickness: number; color: string }[], s0: number, s1: number) {
  const total = layers.reduce((s, l) => s + l.thickness, 0);
  const d = norm(sub(w.b, w.a));
  const n = perp(d);
  const a0 = add(w.a, mul(d, s0));
  const a1 = add(w.a, mul(d, s1));
  let off = total / 2;
  return layers.map((l) => {
    const o0 = off;
    const o1 = off - l.thickness;
    off = o1;
    return {
      color: l.color,
      quad: [add(a0, mul(n, o0)), add(a1, mul(n, o0)), add(a1, mul(n, o1)), add(a0, mul(n, o1))],
    };
  });
}

function GhostWalls({ project: p, levelId, mm }: { project: Project; levelId: string; mm: number }) {
  return (
    <g className="pv-ghost" strokeWidth={0.18 * mm}>
      {p.elements.map((e) => {
        if (e.kind !== 'wall' || e.levelId !== levelId) return null;
        const th = wallThickness(byId(p.catalog.wall, e.typeId));
        return <polygon key={e.id} points={pts(wallSegmentQuad(e, th, 0, wallLength(e)))} />;
      })}
    </g>
  );
}

/** Quote dei muri perimetrali, posizionate sul lato esterno */
function WallDimensions({ project: p, walls, mm, ts }: { project: Project; walls: Wall[]; mm: number; ts: number }) {
  if (!walls.length) return null;
  const c = centroid(walls.flatMap((w) => [w.a, w.b]));
  const exterior = walls.filter((w) => {
    const t = byId(p.catalog.wall, w.typeId);
    return t?.layers.some((l) => l.role === 'isolante') || wallThickness(t) >= 0.25;
  });
  return (
    <g className="pv-dim" strokeWidth={0.13 * mm}>
      {exterior.map((w) => {
        const th = wallThickness(byId(p.catalog.wall, w.typeId));
        const d = norm(sub(w.b, w.a));
        let n = perp(d);
        const mid = centroid([w.a, w.b]);
        if (dot(n, sub(mid, c)) < 0) n = mul(n, -1);
        const off = th / 2 + 8 * mm;
        const a = add(w.a, mul(n, off));
        const b = add(w.b, mul(n, off));
        const tick = 1.2 * mm;
        const tk = (q: Vec2) => {
          const t1 = add(q, mul(add(d, n), tick * 0.7));
          const t2 = sub(q, mul(add(d, n), tick * 0.7));
          return <line x1={t1.x} y1={-t1.y} x2={t2.x} y2={-t2.y} strokeWidth={0.35 * mm} />;
        };
        const txt = add(centroid([a, b]), mul(n, 1.2 * mm));
        let ang = (Math.atan2(-d.y, d.x) * 180) / Math.PI;
        if (ang > 90 || ang < -90) ang += 180;
        // Catena: estremi del muro e delle aperture
        const marks = [0, ...openingSpans(p, w).flatMap((s) => [s.start, s.end]), wallLength(w)];
        return (
          <g key={w.id}>
            <line x1={a.x} y1={-a.y} x2={b.x} y2={-b.y} />
            <line x1={w.a.x + n.x * th * 0.5} y1={-(w.a.y + n.y * th * 0.5)} x2={a.x + n.x * tick} y2={-(a.y + n.y * tick)} />
            <line x1={w.b.x + n.x * th * 0.5} y1={-(w.b.y + n.y * th * 0.5)} x2={b.x + n.x * tick} y2={-(b.y + n.y * tick)} />
            {marks.map((m, i) => (
              <g key={i}>{tk(add(a, mul(d, m)))}</g>
            ))}
            <text
              x={txt.x}
              y={-txt.y}
              fontSize={2.2 * mm * ts}
              textAnchor="middle"
              className="pv-dimtext"
              transform={`rotate(${ang} ${txt.x} ${-txt.y})`}
            >
              {wallLength(w).toFixed(2)}
            </text>
            {/* Quote parziali sotto la quota totale */}
            {marks.length > 2 &&
              marks.slice(0, -1).map((m, i) => {
                const m2 = marks[i + 1];
                const seg = m2 - m;
                if (seg < 0.05) return null;
                const q = add(add(a, mul(d, (m + m2) / 2)), mul(n, -2.6 * mm));
                return (
                  <text
                    key={`p${i}`}
                    x={q.x}
                    y={-q.y}
                    fontSize={1.7 * mm * ts}
                    textAnchor="middle"
                    className="pv-dimtext pv-dimpartial"
                    transform={`rotate(${ang} ${q.x} ${-q.y})`}
                  >
                    {seg.toFixed(2)}
                  </text>
                );
              })}
          </g>
        );
      })}
    </g>
  );
}

function SelectionOutline({ project: p, id, mm, levelId }: { project: Project; id: string; mm: number; levelId: string }) {
  const e = p.elements.find((x) => x.id === id);
  if (!e) return null;
  const sw = 0.5 * mm;
  if ('levelId' in e && e.levelId !== levelId) return null;
  switch (e.kind) {
    case 'wall': {
      const th = wallThickness(byId(p.catalog.wall, e.typeId));
      return (
        <g className="pv-sel" strokeWidth={sw}>
          <polygon points={pts(wallSegmentQuad(e, th, 0, wallLength(e)))} />
          <circle cx={e.a.x} cy={-e.a.y} r={1.2 * mm} className="pv-handle" />
          <circle cx={e.b.x} cy={-e.b.y} r={1.2 * mm} className="pv-handle" />
        </g>
      );
    }
    case 'opening': {
      const w = p.elements.find((x) => x.id === e.wallId);
      const t = byId(p.catalog.opening, e.typeId);
      if (!w || w.kind !== 'wall' || !t || w.levelId !== levelId) return null;
      const th = wallThickness(byId(p.catalog.wall, w.typeId)) + 0.1;
      return (
        <g className="pv-sel" strokeWidth={sw}>
          <polygon points={pts(wallSegmentQuad(w, th, e.offset - t.width / 2, e.offset + t.width / 2))} />
        </g>
      );
    }
    case 'slab':
    case 'roof':
      return (
        <g className="pv-sel" strokeWidth={sw}>
          <polygon points={pts(e.points)} />
          {e.points.map((q, i) => (
            <circle key={i} cx={q.x} cy={-q.y} r={1.2 * mm} className="pv-handle" />
          ))}
        </g>
      );
    case 'column':
      return (
        <g className="pv-sel" strokeWidth={sw}>
          <polygon points={pts(columnQuad(e, byId(p.catalog.column, e.typeId)))} />
        </g>
      );
    case 'beam':
    case 'stair': {
      const wdt = e.kind === 'stair' ? e.width : byId(p.catalog.beam, e.typeId)?.width ?? 0.3;
      return (
        <g className="pv-sel" strokeWidth={sw}>
          <polygon points={pts(wallSegmentQuad(e as unknown as Wall, wdt, 0, dist(e.a, e.b)))} />
          <circle cx={e.a.x} cy={-e.a.y} r={1.2 * mm} className="pv-handle" />
          <circle cx={e.b.x} cy={-e.b.y} r={1.2 * mm} className="pv-handle" />
        </g>
      );
    }
  }
}
