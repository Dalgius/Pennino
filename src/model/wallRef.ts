// Linea di riferimento dei muri: si disegna sull'asse o su uno dei due fili, e il filo scelto resta
// fermo quando cambia lo spessore della tipologia. Nel modello a e b restano sempre sull'asse
// (lo usano giunzioni, quote, computo e viste); il riferimento dice solo da quale parte sta il filo.

import type { Project, Vec2, Wall, WallRef } from './types';
import { add, byId, dist, dot, JOIN_TOL, mul, norm, perp, projectOnSegment, sub, wallThickness } from './geometry';

export const WALL_REF_LABEL: Record<WallRef, string> = {
  asse: 'Asse',
  sinistra: 'Filo sinistro',
  destra: 'Filo destro',
};

/** Lato del filo di riferimento lungo la normale sinistra n = perp(b − a): +1, −1 o 0 (asse) */
export const refSide = (r: WallRef | undefined) => (r === 'sinistra' ? 1 : r === 'destra' ? -1 : 0);

/** Intersezione delle rette p + u·s e q + v·t (null se parallele) */
function meet(p: Vec2, u: Vec2, q: Vec2, v: Vec2): Vec2 | null {
  const den = u.x * v.y - u.y * v.x;
  if (Math.abs(den) < 1e-9) return null;
  const s = ((q.x - p.x) * v.y - (q.y - p.y) * v.x) / den;
  return add(p, mul(u, s));
}

/**
 * Assi di una spezzata di muri disegnata sul filo di riferimento. Ogni lato si sposta verso il lato
 * opposto al filo di mezzo spessore; nei vertici gli assi si incontrano. Chiusa: anche l'ultimo
 * vertice con il primo. Restituisce un punto d'asse per ogni punto disegnato.
 */
export function axisPolyline(pts: Vec2[], half: number, ref: WallRef, closed = false): Vec2[] {
  const s = refSide(ref);
  if (!s || pts.length < 2 || half <= 0) return pts.map((q) => ({ ...q }));
  const n = pts.length;
  const segs = (closed ? pts : pts.slice(0, -1)).map((a, i) => {
    const b = pts[(i + 1) % n];
    const d = norm(sub(b, a));
    // il filo sta dal lato s: l'asse dalla parte opposta
    return { p: add(a, mul(perp(d), -s * half)), d };
  });
  const m = segs.length;
  return pts.map((q, i) => {
    const before = closed ? segs[(i - 1 + m) % m] : segs[i - 1];
    const after = closed ? segs[i % m] : segs[i];
    if (before && after) {
      const x = meet(before.p, before.d, after.p, after.d);
      if (x) return x;
    }
    const g = after ?? before!;
    return add(q, mul(perp(g.d), -s * half));
  });
}

/**
 * Un estremo che finisce su un altro muro (sul filo o dentro lo spessore) si allunga fino al suo
 * asse, lungo la direzione del muro: così nasce la giunzione a T anche disegnando su un filo.
 */
export function extendToHost(p: Project, levelId: string, end: Vec2, dir: Vec2, skip: string[] = []): Vec2 {
  let best: { q: Vec2; d: number } | null = null;
  for (const o of p.elements) {
    if (o.kind !== 'wall' || o.levelId !== levelId || skip.includes(o.id)) continue;
    const od = norm(sub(o.b, o.a));
    if (Math.abs(od.x * dir.y - od.y * dir.x) < 0.2) continue; // quasi parallelo: non è un innesto
    const half = wallThickness(byId(p.catalog.wall, o.typeId)) / 2;
    const pr = projectOnSegment(end, o.a, o.b);
    if (pr.d > half + JOIN_TOL || pr.t <= 1e-3 || pr.t >= 1 - 1e-3) continue;
    const x = meet(end, dir, o.a, od);
    if (!x || dist(x, end) > half + JOIN_TOL) continue;
    if (!best || pr.d < best.d) best = { q: x, d: pr.d };
  }
  return best ? best.q : end;
}

/**
 * Muri con un filo di riferimento il cui spessore è cambiato: l'asse si sposta perché il filo resti
 * fermo, e gli estremi collegati (angoli e innesti a T) seguono le nuove rette. Restituisce il
 * progetto aggiornato sulla bozza d; prev è lo stato prima della modifica.
 */
export function keepReferenceFaces(prev: Project, d: Project): boolean {
  const half = (p: Project, w: Wall) => wallThickness(byId(p.catalog.wall, w.typeId)) / 2;
  const before = new Map(prev.elements.filter((e): e is Wall => e.kind === 'wall').map((w) => [w.id, w]));
  const shift = new Map<string, Vec2>();
  for (const w of d.elements) {
    if (w.kind !== 'wall' || !refSide(w.ref)) continue;
    const o = before.get(w.id);
    if (!o) continue;
    const dh = half(prev, o) - half(d, w);
    // solo se cambia lo spessore e il muro non è stato spostato in questa stessa modifica
    if (Math.abs(dh) < 1e-6 || dist(o.a, w.a) > 1e-9 || dist(o.b, w.b) > 1e-9) continue;
    const n = perp(norm(sub(w.b, w.a)));
    shift.set(w.id, mul(n, refSide(w.ref) * dh));
  }
  if (!shift.size) return false;
  const walls = d.elements.filter((e): e is Wall => e.kind === 'wall');
  const old = new Map(walls.map((w) => [w.id, { a: { ...w.a }, b: { ...w.b } }]));
  const lineOf = (id: string) => {
    const o = old.get(id)!;
    const s = shift.get(id) ?? { x: 0, y: 0 };
    return { p: add(o.a, s), d: norm(sub(o.b, o.a)) };
  };
  for (const w of walls) {
    const o = old.get(w.id)!;
    const own = lineOf(w.id);
    const moved = shift.has(w.id);
    for (const end of ['a', 'b'] as const) {
      const P = o[end];
      // altri muri allo stesso estremo (angolo) o su cui questo estremo si innesta (T)
      let partner: string | null = null;
      for (const x of walls) {
        if (x.id === w.id || x.levelId !== w.levelId) continue;
        const xo = old.get(x.id)!;
        const onEnd = dist(xo.a, P) < JOIN_TOL || dist(xo.b, P) < JOIN_TOL;
        const pr = projectOnSegment(P, xo.a, xo.b);
        if (onEnd || pr.d < JOIN_TOL) {
          const xd = norm(sub(xo.b, xo.a));
          if (Math.abs(xd.x * own.d.y - xd.y * own.d.x) < 0.2) continue; // prosecuzione rettilinea
          if (moved || shift.has(x.id)) partner = x.id;
          if (shift.has(x.id)) break;
        }
      }
      let Q: Vec2 | null = null;
      if (partner) {
        const pl = lineOf(partner);
        Q = meet(own.p, own.d, pl.p, pl.d);
      }
      if (!Q && moved) Q = add(P, shift.get(w.id)!);
      if (!Q) continue;
      if (end === 'a') {
        // le aperture restano ferme in pianta: l'ascissa si misura dal nuovo inizio
        const delta = dot(sub(Q, add(P, shift.get(w.id) ?? { x: 0, y: 0 })), own.d);
        for (const e of d.elements) if (e.kind === 'opening' && e.wallId === w.id) e.offset -= delta;
      }
      w[end] = Q;
    }
  }
  return true;
}
