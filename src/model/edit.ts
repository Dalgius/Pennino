// Operazioni di editing condivise dalle fasi (selezione, maniglie, spostamenti, aggancio).

import type { BuildingElement, ContextItem, Project, SiteItem, Vec2 } from './types';
import {
  add,
  bbox,
  roofBase,
  byId,
  columnQuad,
  dist,
  distToPolyline,
  pointInPolygon,
  projectOnSegment,
  sub,
  wallLength,
  wallSegmentQuad,
  wallThickness,
} from './geometry';
import { VEHICLE_SIZE } from '../views/SiteView';

type Editable = BuildingElement | SiteItem | ContextItem;

export function getHandles(o: Editable): Vec2[] {
  if ('a' in o && 'b' in o) return [o.a, o.b];
  if ('points' in o) return o.points;
  if ('p' in o) return [o.p];
  return [];
}

export function setHandle(o: Editable, i: number, v: Vec2) {
  if ('a' in o && 'b' in o) {
    if (i === 0) o.a = v;
    else o.b = v;
  } else if ('points' in o) o.points[i] = v;
  else if ('p' in o) o.p = v;
}

export function translate(o: Editable, d: Vec2) {
  if ('a' in o && 'b' in o) {
    o.a = add(o.a, d);
    o.b = add(o.b, d);
  } else if ('points' in o) o.points = o.points.map((q) => add(q, d));
  else if ('p' in o) o.p = add(o.p, d);
}

/** Elimina elementi e tutto ciò che ospitano (aperture nei muri) */
export function deleteElements(p: Project, ids: string[]) {
  const set = new Set(ids);
  p.elements = p.elements.filter((e) => !set.has(e.id) && !(e.kind === 'opening' && set.has(e.wallId)));
}

/** Elemento del modello sotto il puntatore sul livello indicato */
export function hitTestModel(p: Project, w: Vec2, levelId: string, tol: number): string | null {
  const walls = p.elements.filter((e) => e.kind === 'wall' && e.levelId === levelId);
  // Aperture
  for (const e of p.elements) {
    if (e.kind !== 'opening') continue;
    const wall = walls.find((x) => x.id === e.wallId);
    const t = byId(p.catalog.opening, e.typeId);
    if (!wall || wall.kind !== 'wall' || !t) continue;
    const th = wallThickness(byId(p.catalog.wall, wall.typeId));
    const q = wallSegmentQuad(wall, th + tol * 2, e.offset - t.width / 2, e.offset + t.width / 2);
    if (pointInPolygon(w, q)) return e.id;
  }
  for (const e of p.elements) {
    if (e.kind === 'column' && e.levelId === levelId) {
      const q = columnQuad(e, byId(p.catalog.column, e.typeId));
      if (pointInPolygon(w, q) || distToPolyline(w, q, true) < tol) return e.id;
    }
  }
  let best: { id: string; d: number } | null = null;
  for (const e of walls) {
    if (e.kind !== 'wall') continue;
    const th = wallThickness(byId(p.catalog.wall, e.typeId));
    const d = projectOnSegment(w, e.a, e.b).d;
    if (d < th / 2 + tol && (!best || d < best.d)) best = { id: e.id, d };
  }
  if (best) return best.id;
  for (const e of p.elements) {
    if ((e.kind === 'beam' || e.kind === 'stair') && e.levelId === levelId) {
      const width = e.kind === 'stair' ? e.width : byId(p.catalog.beam, e.typeId)?.width ?? 0.3;
      if (projectOnSegment(w, e.a, e.b).d < width / 2 + tol) return e.id;
    }
  }
  for (const e of p.elements) {
    if (e.kind === 'roof' && e.levelId === levelId && distToPolyline(w, e.points, true) < tol * 2) return e.id;
  }
  for (const e of [...p.elements].reverse()) {
    if (e.kind === 'slab' && e.levelId === levelId && pointInPolygon(w, e.points)) return e.id;
  }
  // coperture: clic all'interno della falda (con lo sporto)
  const here = byId(p.levels, levelId);
  for (const e of p.elements) {
    if (e.kind !== 'roof') continue;
    const onRoofLevel = here?.kind === 'copertura' && Math.abs(roofBase(p, e) - here.elevation) < 0.01;
    if (e.levelId !== levelId && !onRoofLevel) continue;
    const b = bbox(e.points);
    const o = e.overhang;
    const inside = e.shape === 'falde' ? w.x >= b.minX - o && w.x <= b.maxX + o && w.y >= b.minY - o && w.y <= b.maxY + o : pointInPolygon(w, e.points);
    if (inside) return e.id;
  }
  return null;
}

export function hitTestSite(items: (SiteItem | ContextItem)[], w: Vec2, tol: number): string | null {
  for (const s of [...items].reverse()) {
    switch (s.kind) {
      case 'gru':
        if (dist(w, s.p) < 1.5 + tol) return s.id;
        break;
      case 'mezzo': {
        const [L] = VEHICLE_SIZE[s.vehicle];
        if (dist(w, s.p) < L / 2) return s.id;
        break;
      }
      case 'accesso':
        if (dist(w, s.p) < s.width / 2 + tol) return s.id;
        break;
      case 'albero':
        if (dist(w, s.p) < s.radius) return s.id;
        break;
      case 'recinzione':
        if (distToPolyline(w, s.points, false) < tol * 1.5) return s.id;
        break;
      case 'percorso':
      case 'strada':
        if (distToPolyline(w, s.points, false) < s.width / 2) return s.id;
        break;
      case 'area':
      case 'edificio':
        if (pointInPolygon(w, s.points)) return s.id;
        break;
    }
  }
  return null;
}

export interface Snap {
  p: Vec2;
  kind: 'estremo' | 'medio' | 'griglia' | 'libero' | 'muro';
}

/** Punti notevoli del livello per l'aggancio */
export function snapPoints(p: Project, levelId: string): { p: Vec2; kind: Snap['kind'] }[] {
  const out: { p: Vec2; kind: Snap['kind'] }[] = [];
  for (const e of p.elements) {
    if (!('levelId' in e) || e.levelId !== levelId) continue;
    if (e.kind === 'wall' || e.kind === 'beam' || e.kind === 'stair') {
      out.push({ p: e.a, kind: 'estremo' }, { p: e.b, kind: 'estremo' });
      out.push({ p: { x: (e.a.x + e.b.x) / 2, y: (e.a.y + e.b.y) / 2 }, kind: 'medio' });
    } else if (e.kind === 'slab' || e.kind === 'roof') e.points.forEach((q) => out.push({ p: q, kind: 'estremo' }));
    else if (e.kind === 'column') out.push({ p: e.p, kind: 'estremo' });
  }
  return out;
}

export function snapPoint(
  raw: Vec2,
  opts: { candidates: { p: Vec2; kind: Snap['kind'] }[]; tol: number; grid: number; from?: Vec2; ortho: boolean },
): Snap {
  let best: Snap | null = null;
  let bd = opts.tol;
  for (const c of opts.candidates) {
    const d = dist(raw, c.p);
    if (d < bd) {
      bd = d;
      best = { p: c.p, kind: c.kind };
    }
  }
  if (best) return best;
  let q = raw;
  if (opts.from && opts.ortho) {
    const d = sub(raw, opts.from);
    q = Math.abs(d.x) >= Math.abs(d.y) ? { x: raw.x, y: opts.from.y } : { x: opts.from.x, y: raw.y };
    // aggancio ortogonale ai punti notevoli allineati
    for (const c of opts.candidates) {
      if (Math.abs(d.x) >= Math.abs(d.y) && Math.abs(c.p.x - q.x) < opts.tol) q = { x: c.p.x, y: q.y };
      if (Math.abs(d.x) < Math.abs(d.y) && Math.abs(c.p.y - q.y) < opts.tol) q = { x: q.x, y: c.p.y };
    }
  }
  if (opts.grid > 0) {
    const g = opts.grid;
    if (opts.from && opts.ortho) {
      // lungo la direzione ortogonale arrotonda la lunghezza al passo di griglia
      const dx = q.x - opts.from.x;
      const dy = q.y - opts.from.y;
      q = Math.abs(dx) >= Math.abs(dy)
        ? { x: opts.from.x + Math.round(dx / g) * g, y: q.y }
        : { x: q.x, y: opts.from.y + Math.round(dy / g) * g };
    } else q = { x: Math.round(q.x / g) * g, y: Math.round(q.y / g) * g };
  }
  return { p: q, kind: opts.grid > 0 ? 'griglia' : 'libero' };
}

/** Muro ospite più vicino per porte e finestre */
export function nearestWall(p: Project, w: Vec2, levelId: string, tol: number) {
  let best: { id: string; offset: number; d: number } | null = null;
  for (const e of p.elements) {
    if (e.kind !== 'wall' || e.levelId !== levelId) continue;
    const th = wallThickness(byId(p.catalog.wall, e.typeId));
    const pr = projectOnSegment(w, e.a, e.b);
    if (pr.d < th / 2 + tol && (!best || pr.d < best.d)) best = { id: e.id, offset: pr.t * wallLength(e), d: pr.d };
  }
  return best;
}

/** Punti che descrivono l'ingombro in pianta di un elemento (per la selezione a riquadro) */
function footprintOf(p: Project, e: BuildingElement): Vec2[] {
  switch (e.kind) {
    case 'wall': {
      const th = wallThickness(byId(p.catalog.wall, e.typeId));
      return wallSegmentQuad(e, th, 0, wallLength(e));
    }
    case 'opening': {
      const w = p.elements.find((x) => x.id === e.wallId);
      const t = byId(p.catalog.opening, e.typeId);
      if (!w || w.kind !== 'wall' || !t) return [];
      const th = wallThickness(byId(p.catalog.wall, w.typeId));
      return wallSegmentQuad(w, th, e.offset - t.width / 2, e.offset + t.width / 2);
    }
    case 'slab':
    case 'roof':
      return e.points;
    case 'column':
      return columnQuad(e, byId(p.catalog.column, e.typeId));
    case 'beam':
    case 'stair':
      return [e.a, e.b];
  }
}

function openingLevel(p: Project, e: BuildingElement) {
  if (e.kind !== 'opening') return e.levelId;
  const w = p.elements.find((x) => x.id === e.wallId);
  return w && w.kind === 'wall' ? w.levelId : '';
}

/**
 * Selezione a riquadro. Finestra (crossing = false): elementi interamente contenuti.
 * Intersezione (crossing = true): elementi anche solo toccati dal riquadro.
 */
export function elementsInRect(
  p: Project,
  levelId: string,
  r: { minX: number; minY: number; maxX: number; maxY: number },
  crossing: boolean,
): string[] {
  const inside = (q: Vec2) => q.x >= r.minX && q.x <= r.maxX && q.y >= r.minY && q.y <= r.maxY;
  const out: string[] = [];
  for (const e of p.elements) {
    if (openingLevel(p, e) !== levelId) continue;
    const pts = footprintOf(p, e);
    if (!pts.length) continue;
    if (!crossing) {
      if (pts.every(inside)) out.push(e.id);
      continue;
    }
    const b = bbox(pts);
    const overlap = b.minX <= r.maxX && b.maxX >= r.minX && b.minY <= r.maxY && b.maxY >= r.minY;
    if (!overlap) continue;
    const corners = [
      { x: r.minX, y: r.minY },
      { x: r.maxX, y: r.minY },
      { x: r.maxX, y: r.maxY },
      { x: r.minX, y: r.maxY },
    ];
    const closed = pts.length > 2;
    const segHits = pts.some((a, i) => {
      if (!closed && i === pts.length - 1) return false;
      const b2 = pts[(i + 1) % pts.length];
      if (inside(a) || inside(b2)) return true;
      return corners.some((c, j) => segmentsCross(a, b2, c, corners[(j + 1) % 4]));
    });
    // come nei CAD: conta il bordo dell'elemento, non l'area che racchiude
    if (segHits) out.push(e.id);
  }
  // tracce di sezione
  for (const s of p.sections ?? []) {
    const ok = crossing ? inside(s.a) || inside(s.b) : inside(s.a) && inside(s.b);
    if (ok) out.push(s.id);
  }
  return out;
}

function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2) {
  const cr = (o: Vec2, p1: Vec2, p2: Vec2) => (p1.x - o.x) * (p2.y - o.y) - (p1.y - o.y) * (p2.x - o.x);
  const d1 = cr(c, d, a);
  const d2 = cr(c, d, b);
  const d3 = cr(a, b, c);
  const d4 = cr(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}
