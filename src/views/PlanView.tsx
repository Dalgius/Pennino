// Pianta di un livello generata dal modello.
// Usata sia dall'editor (fase 02) sia dai fogli di stampa (fase 03): stesso disegno, stessi dati.
// Coordinate in metri; l'asse Y del modello è ribaltato per l'SVG.

import type { Project, Vec2, Wall } from '../model/types';
import { computeDimensions, segmentEdit, type DimChain } from '../model/dimensions';
import { bandPolygon, layerBands, levelCenter, wallGeom, wallOutline, wallPieces } from '../model/walls';
import {
  add,
  bbox,
  byId,
  centroid,
  columnQuad,
  dist,
  levelAbove,
  mul,
  norm,
  openingSpans,
  perp,
  sub,
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
  /** Quote modificabili: clic su una cifra */
  onDimEdit?: (t: DimTarget) => void;
  activeDim?: string;
}

export function PlanView({ project: p, levelId, mm, showDimensions, showLabels, selectedIds = [], ghostLevelId, textScale = 1, onDimEdit, activeDim }: Props) {
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
  const center = levelCenter(p, levelId);

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
        <WallPlan key={w.id} project={p} wall={w} mm={mm} center={center} />
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

      {showDimensions && <DimChains project={p} levelId={levelId} mm={mm} ts={ts} onEdit={onDimEdit} activeKey={activeDim} />}

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

function WallPlan({ project: p, wall: w, mm, center }: { project: Project; wall: Wall; mm: number; center: Vec2 }) {
  const t = byId(p.catalog.wall, w.typeId);
  const th = wallThickness(t);
  const g = wallGeom(p, w, center);
  const spans = openingSpans(p, w);
  const pieces = wallPieces(g, spans);
  const d = g.d;
  const n = g.n;
  const isLayered = mm < 0.08 && t && t.layers.length > 1; // a scala ≥ 1:50 si vedono gli strati
  const bands = t ? layerBands(g, t.layers) : [];

  return (
    <g>
      {pieces.map(({ s0, s1 }, i) =>
        isLayered ? (
          <g key={i}>
            {bands.map((band, j) => (
              <polygon key={j} points={pts(bandPolygon(g, band.o0, band.o1, s0, s1))} fill={t!.layers[j].color} className="pv-layer" strokeWidth={0.1 * mm} />
            ))}
            <polygon points={pts(bandPolygon(g, g.half, -g.half, s0, s1))} className="pv-wall-outline" strokeWidth={0.35 * mm} />
          </g>
        ) : (
          <polygon key={i} points={pts(bandPolygon(g, g.half, -g.half, s0, s1))} className="pv-wall" />
        ),
      )}
      {spans.map(({ opening: o, type, start, end }) => {
        const p0 = add(w.a, mul(d, start));
        const p1 = add(w.a, mul(d, end));
        const half = mul(n, (g.extSign * th) / 2); // verso il lato esterno
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

function GhostWalls({ project: p, levelId, mm }: { project: Project; levelId: string; mm: number }) {
  return (
    <g className="pv-ghost" strokeWidth={0.18 * mm}>
      {p.elements.map((e) => {
        if (e.kind !== 'wall' || e.levelId !== levelId) return null;
        return <polygon key={e.id} points={pts(wallOutline(wallGeom(p, e)))} />;
      })}
    </g>
  );
}

export interface DimTarget {
  chain: DimChain;
  k: number;
  value: number;
  at: Vec2;
}

/**
 * Catene di quote. Fila 1 (parziali) a 6 mm dalla faccia, fila 2 (totale) a 13 mm.
 * Le cifre dei segmenti stretti vengono sfalsate per non sovrapporsi.
 */
function DimChains({
  project: p,
  levelId,
  mm,
  ts,
  onEdit,
  activeKey,
}: {
  project: Project;
  levelId: string;
  mm: number;
  ts: number;
  onEdit?: (t: DimTarget) => void;
  activeKey?: string;
}) {
  const chains = computeDimensions(p, levelId);
  const font = 2 * mm * ts;
  const charW = font * 0.62;
  return (
    <g className="pv-dim" strokeWidth={0.13 * mm}>
      {chains.map((c) => {
        const off = (c.row === 1 ? 6 : 13) * mm * ts;
        const P = (s: number, extra = 0) => add(add(c.origin, mul(c.dir, s)), mul(c.out, off + extra));
        const s0 = c.marks[0].s;
        const s1 = c.marks[c.marks.length - 1].s;
        const a = P(s0);
        const b = P(s1);
        let ang = (Math.atan2(-c.dir.y, c.dir.x) * 180) / Math.PI;
        // testo leggibile da sotto o da destra
        const flipText = ang > 90 || ang <= -90;
        if (flipText) ang += 180;
        const tick = 1.1 * mm * ts;
        let lastEnd = -Infinity;
        let stagger = 0;
        return (
          <g key={c.id}>
            <line x1={a.x} y1={-a.y} x2={b.x} y2={-b.y} />
            {c.marks.map((m, i) => {
              const f = add(c.origin, mul(c.dir, m.s));
              const q = P(m.s);
              const t1 = add(q, mul(add(c.dir, c.out), tick * 0.7));
              const t2 = sub(q, mul(add(c.dir, c.out), tick * 0.7));
              const e2 = add(q, mul(c.out, tick));
              const e1 = add(f, mul(c.out, 1.2 * mm));
              return (
                <g key={i}>
                  {c.row === 1 && <line x1={e1.x} y1={-e1.y} x2={e2.x} y2={-e2.y} className="pv-dim-ext" />}
                  <line x1={t1.x} y1={-t1.y} x2={t2.x} y2={-t2.y} strokeWidth={0.35 * mm} />
                </g>
              );
            })}
            {c.marks.slice(0, -1).map((m, k) => {
              const len = c.marks[k + 1].s - m.s;
              if (len < 0.005) return null;
              const label = len.toFixed(2);
              const mid = (m.s + c.marks[k + 1].s) / 2;
              const w = label.length * charW;
              const segPaper = len;
              // sfalsa la cifra se si sovrappone alla precedente
              const start = mid - w / 2;
              stagger = start < lastEnd + charW * 0.5 && segPaper < w * 1.1 ? (stagger ? 0 : 1) : 0;
              lastEnd = mid + w / 2;
              const q = P(mid, font * 0.35 + stagger * font * 1.15);
              const editable = !!onEdit && !!segmentEdit(c, k);
              const key = `${c.id}#${k}`;
              return (
                <text
                  key={`t${k}`}
                  x={q.x}
                  y={-q.y}
                  fontSize={font}
                  textAnchor="middle"
                  className={`pv-dimtext ${c.row === 1 && c.marks.length > 2 ? 'pv-dimpartial' : ''} ${editable ? 'pv-dim-editable' : ''} ${activeKey === key ? 'pv-dim-active' : ''}`}
                  transform={`rotate(${ang} ${q.x} ${-q.y})`}
                  onPointerDown={
                    editable
                      ? (e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          onEdit!({ chain: c, k, value: len, at: q });
                        }
                      : undefined
                  }
                >
                  {editable && <title>Clic per scrivere la misura: {segmentEdit(c, k)}</title>}
                  {label}
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
      return (
        <g className="pv-sel" strokeWidth={sw}>
          <polygon points={pts(wallOutline(wallGeom(p, e)))} />
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
