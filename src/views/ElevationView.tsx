// Prospetto ortogonale generato dal modello: muri, aperture, solai, copertura e quote dei livelli.

import type { Project, Vec2 } from '../model/types';
import {
  bbox,
  byId,
  dot,
  fmtLevel,
  norm,
  openingSpans,
  roofRidgeRise,
  sortedLevels,
  sub,
  wallHeight,
  wallLength,
  wallSegmentQuad,
  wallThickness,
} from '../model/geometry';
import { fixtureSpec, leafSpans } from '../model/openings';
import { wallGeom } from '../model/walls';

export type Direction = 'sud' | 'nord' | 'est' | 'ovest';

/** Asse orizzontale del prospetto (u) e direzione di profondità verso l'osservatore */
function axes(dir: Direction): { u: Vec2; depth: Vec2 } {
  switch (dir) {
    case 'sud':
      return { u: { x: 1, y: 0 }, depth: { x: 0, y: 1 } };
    case 'nord':
      return { u: { x: -1, y: 0 }, depth: { x: 0, y: -1 } };
    case 'est':
      return { u: { x: 0, y: 1 }, depth: { x: -1, y: 0 } };
    case 'ovest':
      return { u: { x: 0, y: -1 }, depth: { x: 1, y: 0 } };
  }
}

export function elevationExtents(p: Project, dir: Direction) {
  const { u } = axes(dir);
  let min = Infinity;
  let max = -Infinity;
  for (const e of p.elements) {
    const list: Vec2[] = e.kind === 'wall' || e.kind === 'beam' ? [e.a, e.b] : e.kind === 'slab' || e.kind === 'roof' ? e.points : [];
    for (const q of list) {
      min = Math.min(min, dot(q, u));
      max = Math.max(max, dot(q, u));
    }
  }
  if (!isFinite(min)) return { min: 0, max: 10 };
  return { min: min - 1, max: max + 1 };
}

interface Props {
  project: Project;
  direction: Direction;
  mm: number;
  textScale?: number;
}

export function ElevationView({ project: p, direction, mm, textScale = 1 }: Props) {
  const ts = textScale;
  const { u, depth } = axes(direction);
  const U = (q: Vec2) => dot(q, u);
  const D = (q: Vec2) => dot(q, depth);
  const Z = (z: number) => -z;
  const items: { depth: number; node: React.ReactNode }[] = [];
  const ext = elevationExtents(p, direction);

  for (const e of p.elements) {
    const lvl = 'levelId' in e ? byId(p.levels, e.levelId) : undefined;
    if (!lvl) continue;
    if (e.kind === 'wall') {
      const th = wallThickness(byId(p.catalog.wall, e.typeId));
      const quad = wallSegmentQuad(e, th, -th / 2, wallLength(e) + th / 2);
      const us = quad.map(U);
      const u0 = Math.min(...us);
      const u1 = Math.max(...us);
      const z0 = lvl.elevation;
      const z1 = z0 + wallHeight(p, e);
      const facing = Math.abs(dot(norm(sub(e.b, e.a)), u)) > 0.7;
      const holes: string[] = [];
      const glass: React.ReactNode[] = [];
      const g = wallGeom(p, e);
      if (facing) {
        for (const s of openingSpans(p, e)) {
          const a = U({ x: e.a.x + (e.b.x - e.a.x) * (s.start / wallLength(e)), y: e.a.y + (e.b.y - e.a.y) * (s.start / wallLength(e)) });
          const b = U({ x: e.a.x + (e.b.x - e.a.x) * (s.end / wallLength(e)), y: e.a.y + (e.b.y - e.a.y) * (s.end / wallLength(e)) });
          const x0 = Math.min(a, b);
          const x1 = Math.max(a, b);
          const h0 = z0 + s.type.sill;
          const h1 = Math.min(z1, h0 + s.type.height);
          holes.push(`M${x0},${Z(h0)} L${x1},${Z(h0)} L${x1},${Z(h1)} L${x0},${Z(h1)} Z`);
          const isDoor = s.type.category === 'porta';
          const spec = fixtureSpec(p, e, g, s.opening, s.type);
          const US = (sv: number) => U({ x: e.a.x + g.d.x * sv, y: e.a.y + g.d.y * sv });
          const tf = spec.ct + spec.tf; // telaio in vista
          const dash = `${1.2 * mm} ${0.8 * mm}`;
          glass.push(
            <g key={s.opening.id}>
              {/* telaio fisso */}
              <rect x={x0} y={Z(h1)} width={x1 - x0} height={h1 - h0} className="ev-frame-fill" strokeWidth={0.25 * mm} />
              {leafSpans(spec, s.start, s.end).map((l, i) => {
                const la = US(l.s0);
                const lb = US(l.s1);
                const lx0 = Math.min(la, lb);
                const lx1 = Math.max(la, lb);
                const lz0 = isDoor ? h0 + 0.01 : h0 + tf;
                const lz1 = h1 - tf;
                const prof = isDoor ? 0 : 0.06; // profilo dell'anta attorno al vetro
                const hx = US(l.hinge);
                const fx = US(l.free);
                return (
                  <g key={i}>
                    <rect x={lx0} y={Z(lz1)} width={lx1 - lx0} height={lz1 - lz0} className={isDoor ? 'ev-door' : 'ev-frame-fill'} strokeWidth={0.18 * mm} />
                    {!isDoor && (
                      <rect x={lx0 + prof} y={Z(lz1 - prof)} width={Math.max(0, lx1 - lx0 - 2 * prof)} height={Math.max(0, lz1 - lz0 - 2 * prof)} className="ev-glass" strokeWidth={0.13 * mm} />
                    )}
                    {/* simbolo d'apertura: il vertice indica il lato delle cerniere */}
                    <polyline
                      points={`${fx},${Z(lz1)} ${hx},${Z((lz0 + lz1) / 2)} ${fx},${Z(lz0)}`}
                      className="ev-swing"
                      strokeWidth={0.13 * mm}
                      strokeDasharray={dash}
                    />
                  </g>
                );
              })}
              {spec.hasSill && <rect x={x0 - 0.03} y={Z(h0)} width={x1 - x0 + 0.06} height={0.04} className="ev-sill" strokeWidth={0.25 * mm} />}
              {spec.hasThreshold && <line x1={x0} y1={Z(h0)} x2={x1} y2={Z(h0)} className="ev-frame" strokeWidth={0.35 * mm} />}
            </g>,
          );
        }
      }
      const outer = `M${u0},${Z(z0)} L${u1},${Z(z0)} L${u1},${Z(z1)} L${u0},${Z(z1)} Z`;
      items.push({
        depth: Math.min(...quad.map(D)),
        node: (
          <g key={e.id}>
            <path d={[outer, ...holes].join(' ')} fillRule="evenodd" className="ev-wall" strokeWidth={0.25 * mm} />
            {glass}
          </g>
        ),
      });
    } else if (e.kind === 'slab') {
      const t = byId(p.catalog.slab, e.typeId);
      const us = e.points.map(U);
      const th = t?.thickness ?? 0.3;
      items.push({
        depth: Math.max(...e.points.map(D)) + 0.01,
        node: (
          <rect
            key={e.id}
            x={Math.min(...us)}
            y={Z(lvl.elevation)}
            width={Math.max(...us) - Math.min(...us)}
            height={th}
            className="ev-slab"
            strokeWidth={0.25 * mm}
          />
        ),
      });
    } else if (e.kind === 'column') {
      const t = byId(p.catalog.column, e.typeId);
      const w = Math.abs(u.x) > 0.5 ? t?.width ?? 0.3 : t?.depth ?? 0.3;
      items.push({
        depth: D(e.p),
        node: <rect key={e.id} x={U(e.p) - w / 2} y={Z(lvl.elevation + lvl.height)} width={w} height={lvl.height} className="ev-wall" strokeWidth={0.25 * mm} />,
      });
    } else if (e.kind === 'beam') {
      const t = byId(p.catalog.beam, e.typeId);
      const h = t?.height ?? 0.4;
      const top = lvl.elevation + lvl.height;
      const a = U(e.a);
      const b = U(e.b);
      items.push({
        depth: Math.max(D(e.a), D(e.b)),
        node: <rect key={e.id} x={Math.min(a, b)} y={Z(top)} width={Math.abs(b - a) || t?.width || 0.3} height={h} className="ev-wall" strokeWidth={0.25 * mm} />,
      });
    } else if (e.kind === 'roof') {
      const t = byId(p.catalog.roof, e.typeId);
      const th = t?.thickness ?? 0.3;
      const base = lvl.elevation + lvl.height;
      const b = bbox(e.points);
      const o = e.overhang;
      const corners = [
        { x: b.minX - o, y: b.minY - o },
        { x: b.maxX + o, y: b.maxY + o },
      ];
      const us = corners.map(U);
      const u0 = Math.min(...us);
      const u1 = Math.max(...us);
      const dpt = Math.max(...corners.map(D));
      if (e.shape === 'piana') {
        items.push({
          depth: dpt + 0.02,
          node: <rect key={e.id} x={u0} y={Z(base + th)} width={u1 - u0} height={th} className="ev-roof" strokeWidth={0.35 * mm} />,
        });
      } else {
        const rise = roofRidgeRise(e.points, e.pitch);
        const ridgeAlongX = b.w >= b.h;
        const ridgeParallelToView = ridgeAlongX === Math.abs(u.x) > 0.5;
        const extra = Math.tan((e.pitch * Math.PI) / 180) * o; // l'aggetto abbassa la linea di gronda
        const eave = base - extra;
        const shape = ridgeParallelToView
          ? `M${u0},${Z(eave)} L${u1},${Z(eave)} L${u1},${Z(eave + th)} L${u1},${Z(base + rise + th)} L${u0},${Z(base + rise + th)} L${u0},${Z(eave + th)} Z`
          : `M${u0},${Z(eave)} L${u0},${Z(eave + th)} L${(u0 + u1) / 2},${Z(base + rise + th)} L${u1},${Z(eave + th)} L${u1},${Z(eave)} L${(u0 + u1) / 2},${Z(base + rise)} Z`;
        const wall = [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.maxY }].map(U);
        const g0 = Math.min(...wall);
        const g1 = Math.max(...wall);
        items.push({
          depth: dpt + 0.02,
          node: (
            <g key={e.id}>
              {!ridgeParallelToView && (
                <path d={`M${g0},${Z(base)} L${g1},${Z(base)} L${(g0 + g1) / 2},${Z(base + rise)} Z`} className="ev-wall" strokeWidth={0.25 * mm} />
              )}
              <path d={shape} className="ev-roof" strokeWidth={0.35 * mm} />
              {ridgeParallelToView && (
                <line x1={u0} y1={Z(eave + th)} x2={u1} y2={Z(eave + th)} className="ev-frame" strokeWidth={0.18 * mm} />
              )}
            </g>
          ),
        });
      }
    }
  }

  // Disegno dal più lontano al più vicino
  items.sort((a, b) => a.depth - b.depth);
  const levels = sortedLevels(p);
  const gl = p.site.groundLevel;

  return (
    <g className="elev">
      {items.map((i) => i.node)}
      <line x1={ext.min - 2} y1={Z(gl)} x2={ext.max + 2} y2={Z(gl)} className="ev-ground" strokeWidth={0.7 * mm} />
      {levels.map((l) => (
        <g key={l.id} className="ev-level">
          <line x1={ext.max + 0.5} y1={Z(l.elevation)} x2={ext.max + 0.5 + 14 * mm} y2={Z(l.elevation)} strokeWidth={0.13 * mm} />
          <path
            d={`M${ext.max + 1.5 * mm},${Z(l.elevation)} l${1.4 * mm},${-1.6 * mm} l${-2.8 * mm},0 z`}
            transform={`translate(${0.5 + 1.5 * mm} 0)`}
            className="ev-level-mark"
          />
          <text x={ext.max + 0.5 + 6 * mm} y={Z(l.elevation) - 1 * mm} fontSize={2 * mm * ts} className="ev-text">
            {fmtLevel(l.elevation)}
          </text>
          <text x={ext.max + 0.5 + 6 * mm} y={Z(l.elevation) + 2.6 * mm} fontSize={1.7 * mm * ts} className="ev-text ev-text-soft">
            {l.name}
          </text>
        </g>
      ))}
    </g>
  );
}

/** Altezza complessiva del disegno di prospetto (per l'impaginazione) */
export function elevationHeight(p: Project) {
  let top = 0;
  for (const e of p.elements) {
    const lvl = 'levelId' in e ? byId(p.levels, e.levelId) : undefined;
    if (!lvl) continue;
    const base = lvl.elevation + lvl.height;
    if (e.kind === 'roof') top = Math.max(top, base + roofRidgeRise(e.points, e.pitch) + 0.5);
    else top = Math.max(top, base);
  }
  return { top, bottom: Math.min(p.site.groundLevel, ...p.levels.map((l) => l.elevation)) - 0.6 };
}

