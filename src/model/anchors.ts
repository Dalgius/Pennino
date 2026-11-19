// Quote disegnate a mano legate agli elementi: ogni estremo ricorda su quale elemento è stato
// agganciato e in che punto (estremo o filo di un muro, stipite di un'apertura, faccia di un
// pilastro, vertice di un solaio). Quando l'elemento cambia, la quota lo segue.

import type { DimAnchor, Project, Vec2, Wall } from './types';
import { add, byId, columnQuad, dist, dot, mul, norm, perp, pointInPolygon, projectOnSegment, sub, wallLength, wallThickness } from './geometry';

const EPS = 1e-3;

/** Mezzo spessore e sistema locale (d lungo l'asse, n normale sinistra) di un muro o di una trave */
function frameOf(p: Project, e: { kind: 'wall' | 'beam'; a: Vec2; b: Vec2; typeId: string }) {
  const d = norm(sub(e.b, e.a));
  const half = e.kind === 'wall' ? wallThickness(byId(p.catalog.wall, e.typeId)) / 2 : (byId(p.catalog.beam, e.typeId)?.width ?? 0.3) / 2;
  return { d, n: perp(d), half, L: dist(e.a, e.b) };
}

/** Scostamento dall'asse: sul filo si ricorda il lato, così segue i cambi di spessore */
function across(v: number, half: number): { face: -1 | 0 | 1; v: number } {
  if (Math.abs(v - half) < EPS) return { face: 1, v: 0 };
  if (Math.abs(v + half) < EPS) return { face: -1, v: 0 };
  return { face: 0, v };
}

/** Elemento del livello su cui cade il punto q, e dove: null se non cade su nessuno */
export function anchorAt(p: Project, levelId: string, q: Vec2): DimAnchor | null {
  // 1. stipiti delle aperture
  for (const o of p.elements) {
    if (o.kind !== 'opening') continue;
    const w = p.elements.find((x): x is Wall => x.kind === 'wall' && x.id === o.wallId);
    const t = byId(p.catalog.opening, o.typeId);
    if (!w || !t || w.levelId !== levelId) continue;
    const f = frameOf(p, w);
    const s = dot(sub(q, w.a), f.d);
    const off = dot(sub(q, w.a), f.n);
    if (Math.abs(off) > f.half + EPS || s < o.offset - t.width / 2 - EPS || s > o.offset + t.width / 2 + EPS) continue;
    const side = Math.abs(s - (o.offset - t.width / 2)) < EPS ? -1 : Math.abs(s - (o.offset + t.width / 2)) < EPS ? 1 : 0;
    // solo sugli stipiti: un punto dentro il vano resta legato al muro
    if (!side) continue;
    return { k: 'apertura', id: o.id, side, u: side ? 0 : s - o.offset, ...across(off, f.half) };
  }
  // 2. pilastri
  for (const c of p.elements) {
    if (c.kind !== 'column' || c.levelId !== levelId) continue;
    const t = byId(p.catalog.column, c.typeId);
    const quad = columnQuad(c, t);
    const onEdge = quad.some((a, i) => projectOnSegment(q, a, quad[(i + 1) % 4]).d < EPS);
    if (!pointInPolygon(q, quad) && !onEdge) continue;
    const hw = (t?.width ?? 0.3) / 2;
    const hd = (t?.depth ?? 0.3) / 2;
    return { k: 'pilastro', id: c.id, fx: (q.x - c.p.x) / hw, fy: (q.y - c.p.y) / hd };
  }
  // 3. muri e travi: dall'estremo più vicino, sull'asse o su un filo
  let best: { a: DimAnchor; d: number } | null = null;
  for (const e of p.elements) {
    if ((e.kind !== 'wall' && e.kind !== 'beam') || e.levelId !== levelId) continue;
    const f = frameOf(p, e);
    if (f.L < 1e-6) continue;
    const s = dot(sub(q, e.a), f.d);
    const off = dot(sub(q, e.a), f.n);
    // gli spigoli delle giunzioni sporgono oltre gli estremi d'asse di al più uno spessore
    if (Math.abs(off) > f.half + EPS || s < -2 * f.half - EPS || s > f.L + 2 * f.half + EPS) continue;
    const dd = Math.abs(off) - f.half;
    const end: 'a' | 'b' = s <= f.L / 2 ? 'a' : 'b';
    const a: DimAnchor = { k: 'muro', id: e.id, end, u: end === 'a' ? s : s - f.L, ...across(off, f.half) };
    if (!best || dd < best.d) best = { a, d: dd };
  }
  if (best) return best.a;
  // 4. vertici di solai e coperture
  for (const s of p.elements) {
    if ((s.kind !== 'slab' && s.kind !== 'roof') || s.levelId !== levelId) continue;
    const i = s.points.findIndex((v) => dist(v, q) < EPS);
    if (i >= 0) return { k: 'vertice', id: s.id, index: i };
  }
  return null;
}

/** Posizione attuale del punto legato, o null se l'elemento non c'è più */
export function anchorPoint(p: Project, a: DimAnchor): Vec2 | null {
  const e = p.elements.find((x) => x.id === a.id);
  if (!e) return null;
  if (a.k === 'muro') {
    if (e.kind !== 'wall' && e.kind !== 'beam') return null;
    const f = frameOf(p, e);
    const base = a.end === 'a' ? e.a : e.b;
    return add(add(base, mul(f.d, a.u)), mul(f.n, a.face ? a.face * f.half : a.v));
  }
  if (a.k === 'apertura') {
    if (e.kind !== 'opening') return null;
    const w = p.elements.find((x): x is Wall => x.kind === 'wall' && x.id === e.wallId);
    const t = byId(p.catalog.opening, e.typeId);
    if (!w || !t) return null;
    const f = frameOf(p, w);
    const s = e.offset + a.side * (t.width / 2) + a.u;
    if (s < -EPS || s > wallLength(w) + EPS) return null;
    return add(add(w.a, mul(f.d, s)), mul(f.n, a.face ? a.face * f.half : a.v));
  }
  if (a.k === 'pilastro') {
    if (e.kind !== 'column') return null;
    const t = byId(p.catalog.column, e.typeId);
    return { x: e.p.x + a.fx * ((t?.width ?? 0.3) / 2), y: e.p.y + a.fy * ((t?.depth ?? 0.3) / 2) };
  }
  if (e.kind !== 'slab' && e.kind !== 'roof') return null;
  const v = e.points[a.index];
  return v ? { ...v } : null;
}

/**
 * Le quote legate seguono gli elementi (sulla bozza d). Se l'elemento non c'è più la quota resta
 * dov'è e il legame si scioglie. Restituisce true se ha cambiato qualcosa.
 */
export function followAnchors(d: Project): boolean {
  let changed = false;
  for (const n of d.annotations ?? []) {
    if (n.kind !== 'quota') continue;
    for (const [end, key] of [
      ['a', 'aRef'],
      ['b', 'bRef'],
    ] as const) {
      const ref = n[key];
      if (!ref) continue;
      const q = anchorPoint(d, ref);
      if (!q) {
        delete n[key];
        changed = true;
      } else if (dist(q, n[end]) > 1e-9) {
        n[end] = q;
        changed = true;
      }
    }
  }
  return changed;
}

/** Le quote legate a qualche elemento, per sapere se serve ricalcolarle */
export const hasAnchors = (p: Project) => (p.annotations ?? []).some((n) => n.kind === 'quota' && (n.aRef || n.bRef));

/** Descrizione breve di un legame, per l'ispettore */
export function anchorLabel(a: DimAnchor): string {
  const face = (f: -1 | 0 | 1, v: number) => (f ? 'sul filo' : Math.abs(v) < EPS ? 'sull’asse' : 'nello spessore');
  switch (a.k) {
    case 'muro':
      return `${a.end === 'a' ? 'inizio' : 'fine'} del muro, ${face(a.face, a.v)}`;
    case 'apertura':
      return a.side ? `stipite ${a.side < 0 ? 'iniziale' : 'finale'} dell’apertura` : 'apertura';
    case 'pilastro':
      return Math.abs(Math.abs(a.fx) - 1) < EPS || Math.abs(Math.abs(a.fy) - 1) < EPS ? 'faccia del pilastro' : 'pilastro';
    default:
      return 'vertice del solaio';
  }
}
