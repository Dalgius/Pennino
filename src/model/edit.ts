// Operazioni di editing condivise dalle fasi (selezione, maniglie, spostamenti, aggancio).

import type { BuildingElement, ContextItem, Project, SiteItem, Vec2 } from './types';
import {
  add,
  bbox,
  roofBase,
  slabHoles,
  stairFootprints,
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
    if (e.kind === 'beam' && e.levelId === levelId) {
      const width = byId(p.catalog.beam, e.typeId)?.width ?? 0.3;
      if (projectOnSegment(w, e.a, e.b).d < width / 2 + tol) return e.id;
    }
    if (e.kind === 'stair' && e.levelId === levelId) {
      if (stairFootprints(p, e).some((q) => pointInPolygon(w, q) || distToPolyline(w, q, true) < tol)) return e.id;
    }
  }
  for (const e of p.elements) {
    if (e.kind === 'roof' && e.levelId === levelId && distToPolyline(w, e.points, true) < tol * 2) return e.id;
  }
  for (const e of [...p.elements].reverse()) {
    if (e.kind === 'slab' && e.levelId === levelId && pointInPolygon(w, e.points) && !slabHoles(p, e).some((h) => pointInPolygon(w, h))) return e.id;
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

export type SnapKind = 'estremo' | 'medio' | 'intersezione' | 'perpendicolare' | 'muro' | 'bordo' | 'griglia' | 'libero';

export interface Snap {
  p: Vec2;
  kind: SnapKind;
}

export type SnapCandidate = { p: Vec2; kind: SnapKind };

/** Segmento agganciabile: asse di muri e travi (con la loro mezza larghezza) o lato di solai e coperture */
export interface SnapSegment {
  id: string;
  a: Vec2;
  b: Vec2;
  half: number;
  kind: 'muro' | 'bordo';
}

/** Assi e lati del livello agganciabili */
export function snapSegments(p: Project, levelId: string): SnapSegment[] {
  const out: SnapSegment[] = [];
  for (const e of p.elements) {
    if (!('levelId' in e) || e.levelId !== levelId) continue;
    if (e.kind === 'wall') out.push({ id: e.id, a: e.a, b: e.b, half: wallThickness(byId(p.catalog.wall, e.typeId)) / 2, kind: 'muro' });
    else if (e.kind === 'beam') out.push({ id: e.id, a: e.a, b: e.b, half: (byId(p.catalog.beam, e.typeId)?.width ?? 0.3) / 2, kind: 'muro' });
    else if (e.kind === 'slab' || e.kind === 'roof')
      e.points.forEach((q, i) => out.push({ id: e.id, a: q, b: e.points[(i + 1) % e.points.length], half: 0, kind: 'bordo' }));
  }
  return out.filter((s) => dist(s.a, s.b) > 1e-6);
}

/** Intersezione propria tra due segmenti (estremi esclusi entro eps) */
function segmentIntersection(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2 | null {
  const r = sub(b, a);
  const s = sub(d, c);
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-9) return null;
  const q = sub(c, a);
  const t = (q.x * s.y - q.y * s.x) / den;
  const u = (q.x * r.y - q.y * r.x) / den;
  if (t < -1e-6 || t > 1 + 1e-6 || u < -1e-6 || u > 1 + 1e-6) return null;
  return { x: a.x + r.x * t, y: a.y + r.y * t };
}

/** Punti notevoli del livello per l'aggancio */
export function snapPoints(p: Project, levelId: string): SnapCandidate[] {
  const out: SnapCandidate[] = [];
  for (const e of p.elements) {
    if (!('levelId' in e) || e.levelId !== levelId) continue;
    if (e.kind === 'wall' || e.kind === 'beam' || e.kind === 'stair') {
      out.push({ p: e.a, kind: 'estremo' }, { p: e.b, kind: 'estremo' });
      out.push({ p: { x: (e.a.x + e.b.x) / 2, y: (e.a.y + e.b.y) / 2 }, kind: 'medio' });
    } else if (e.kind === 'slab' || e.kind === 'roof') e.points.forEach((q) => out.push({ p: q, kind: 'estremo' }));
    else if (e.kind === 'column') out.push({ p: e.p, kind: 'estremo' });
  }
  // incroci tra assi di muri e travi
  const segs = snapSegments(p, levelId).filter((s) => s.kind === 'muro');
  for (let i = 0; i < segs.length; i++)
    for (let j = i + 1; j < segs.length; j++) {
      const x = segmentIntersection(segs[i].a, segs[i].b, segs[j].a, segs[j].b);
      if (x && !out.some((c) => c.kind === 'estremo' && dist(c.p, x) < 1e-4)) out.push({ p: x, kind: 'intersezione' });
    }
  return out;
}

/**
 * Aggancio agli oggetti. Priorità: estremi e incroci › punti medi › muri e lati
 * (perpendicolare dal punto di partenza, incrocio della direzione ortogonale con l'asse,
 * proiezione sull'asse) › griglia/ortogonale.
 * Basta portare il cursore sul corpo del muro: il punto cade sull'asse, così le
 * connessioni a T e ad L si formano da sole.
 */
export function snapModel(
  raw: Vec2,
  opts: { candidates: SnapCandidate[]; segments: SnapSegment[]; tol: number; grid: number; from?: Vec2; ortho: boolean },
): Snap {
  const { tol, from } = opts;
  const pick = (kinds: SnapKind[]) => {
    let best: Snap | null = null;
    let bd = tol;
    for (const c of opts.candidates) {
      if (!kinds.includes(c.kind)) continue;
      const d = dist(raw, c.p);
      if (d < bd && !(from && dist(c.p, from) < 1e-6)) {
        bd = d;
        best = { p: c.p, kind: c.kind };
      }
    }
    return best;
  };
  const strong = pick(['estremo', 'intersezione']);
  if (strong) return strong;
  const mid = pick(['medio']);
  if (mid) return mid;

  // segmento sotto il cursore (corpo del muro o lato)
  let seg: SnapSegment | null = null;
  let sd = Infinity;
  for (const s of opts.segments) {
    const pr = projectOnSegment(raw, s.a, s.b);
    const reach = s.half + tol;
    if (pr.d < reach && pr.d - s.half < sd) {
      // il segmento appena disegnato da "from" non è un ospite utile
      if (from && projectOnSegment(from, s.a, s.b).d < 1e-6) continue;
      sd = pr.d - s.half;
      seg = s;
    }
  }
  if (seg) {
    const L = dist(seg.a, seg.b);
    const u = { x: (seg.b.x - seg.a.x) / L, y: (seg.b.y - seg.a.y) / L };
    const onAxis = (q: Vec2) => {
      const t = ((q.x - seg!.a.x) * u.x + (q.y - seg!.a.y) * u.y) / L;
      return t >= -1e-6 && t <= 1 + 1e-6;
    };
    const ok = (q: Vec2) => onAxis(q) && dist(q, raw) < seg!.half + tol * 2 && !(from && dist(q, from) < 0.01);
    if (from) {
      if (opts.ortho) {
        // incrocio della direzione ortogonale (orizzontale o verticale) con l'asse
        const d = sub(raw, from);
        const horiz = Math.abs(d.x) >= Math.abs(d.y);
        const dir = horiz ? { x: 1, y: 0 } : { x: 0, y: 1 };
        const den = dir.x * u.y - dir.y * u.x;
        if (Math.abs(den) > 1e-6) {
          const q0 = sub(seg.a, from);
          const t = (q0.x * u.y - q0.y * u.x) / den;
          const q = { x: from.x + dir.x * t, y: from.y + dir.y * t };
          if (ok(q)) return { p: q, kind: seg.kind };
        }
      }
      // piede della perpendicolare da "from"
      const t = (from.x - seg.a.x) * u.x + (from.y - seg.a.y) * u.y;
      const foot = { x: seg.a.x + u.x * t, y: seg.a.y + u.y * t };
      if (ok(foot) && dist(foot, projectOnSegment(raw, seg.a, seg.b).q) < tol) return { p: foot, kind: 'perpendicolare' };
    }
    // proiezione sull'asse, arrotondata al passo lungo il muro
    const pr = projectOnSegment(raw, seg.a, seg.b);
    let s = pr.t * L;
    if (opts.grid > 0) s = Math.min(L, Math.max(0, Math.round(s / opts.grid) * opts.grid));
    const q = { x: seg.a.x + u.x * s, y: seg.a.y + u.y * s };
    if (!(from && dist(q, from) < 0.01)) return { p: q, kind: seg.kind };
  }
  return snapPoint(raw, opts);
}

export function snapPoint(
  raw: Vec2,
  opts: { candidates: SnapCandidate[]; tol: number; grid: number; from?: Vec2; ortho: boolean },
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
      return [e.a, e.b];
    case 'stair':
      return stairFootprints(p, e).flat();
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

/** Ingombro in pianta di un oggetto di contesto o di cantiere (per la selezione a riquadro) */
function siteFootprint(it: SiteItem | ContextItem | { id: string; kind: 'lotto'; points: Vec2[] }): { pts: Vec2[]; closed: boolean } {
  const box = (c: Vec2, r: number) => [
    { x: c.x - r, y: c.y - r },
    { x: c.x + r, y: c.y - r },
    { x: c.x + r, y: c.y + r },
    { x: c.x - r, y: c.y + r },
  ];
  switch (it.kind) {
    case 'albero':
      return { pts: box(it.p, it.radius), closed: true };
    case 'gru':
      return { pts: box(it.p, 1), closed: true };
    case 'mezzo':
      return { pts: box(it.p, VEHICLE_SIZE[it.vehicle][0] / 2), closed: true };
    case 'accesso':
      return { pts: box(it.p, it.width / 2), closed: true };
    case 'strada':
    case 'percorso':
    case 'recinzione':
      return { pts: it.points, closed: false };
    default:
      return { pts: it.points, closed: true };
  }
}

/** Selezione a riquadro per contesto (01) e cantiere (05): stesse regole di 02 */
export function siteItemsInRect(
  items: (SiteItem | ContextItem | { id: string; kind: 'lotto'; points: Vec2[] })[],
  r: { minX: number; minY: number; maxX: number; maxY: number },
  crossing: boolean,
): string[] {
  const inside = (q: Vec2) => q.x >= r.minX && q.x <= r.maxX && q.y >= r.minY && q.y <= r.maxY;
  const corners = [
    { x: r.minX, y: r.minY },
    { x: r.maxX, y: r.minY },
    { x: r.maxX, y: r.maxY },
    { x: r.minX, y: r.maxY },
  ];
  const out: string[] = [];
  for (const it of items) {
    const { pts, closed } = siteFootprint(it);
    if (!pts.length) continue;
    if (!crossing) {
      if (pts.every(inside)) out.push(it.id);
      continue;
    }
    const n = closed ? pts.length : pts.length - 1;
    let hit = pts.some(inside);
    for (let i = 0; !hit && i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      hit = corners.some((c, j) => segmentsCross(a, b, c, corners[(j + 1) % 4]));
    }
    if (hit) out.push(it.id);
  }
  return out;
}
