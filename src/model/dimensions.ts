// Quote associative: catene di quote calcolate dal modello e modifiche guidate dalle quote.
//
// Muri perimetrali: due catene sul lato esterno (parziali: aperture e tramezzi; totale).
// Muri interni: una catena con aperture e muri che vi si innestano.
// Scrivendo una nuova misura si sposta l'elemento all'estremità destra del segmento.

import type { Project, Vec2, Wall } from './types';
import { add, byId, dist, dot, mul, norm, openingSpans, projectOnSegment, sub, wallThickness } from './geometry';
import { endAt, faceOffset, levelCenter, startAt, wallGeom, type WallGeom } from './walls';

export type MarkRef =
  | { k: 'inizio' | 'fine'; wallId: string }
  | { k: 'apertura'; id: string; edge: 0 | 1 }
  | { k: 'giunto'; wallId: string; face: 0 | 1 };

export interface DimMark {
  s: number;
  ref: MarkRef;
}

export interface DimChain {
  id: string;
  wallId: string;
  /** Punto della faccia quotata a s = 0 */
  origin: Vec2;
  dir: Vec2;
  /** Verso dalla faccia alla linea di quota */
  out: Vec2;
  /** Ordine della catena: 1 = parziali, 2 = totale */
  row: 1 | 2;
  marks: DimMark[];
  /** L'estremo finale è innestato a T: la lunghezza non si cambia da qui */
  endFixed: boolean;
}

export function isExteriorWall(p: Project, w: Wall) {
  const t = byId(p.catalog.wall, w.typeId);
  return !!t?.layers.some((l) => l.role === 'isolante') || wallThickness(t) >= 0.25;
}

/** Muri che si innestano a T sull'asse del muro g, con la loro posizione s */
function junctions(p: Project, g: WallGeom, walls: Wall[]) {
  const out: { wall: Wall; s: number; half: number }[] = [];
  for (const o of walls) {
    if (o.id === g.wall.id) continue;
    for (const P of [o.a, o.b]) {
      const pr = projectOnSegment(P, g.wall.a, g.wall.b);
      if (pr.d < 0.02 && pr.t > 1e-3 && pr.t < 1 - 1e-3) {
        const dO = norm(sub(o.b, o.a));
        const sin = Math.abs(dot(dO, g.n)) || 1;
        out.push({ wall: o, s: pr.t * g.L, half: wallThickness(byId(p.catalog.wall, o.typeId)) / 2 / sin });
      }
    }
  }
  return out;
}

export function computeDimensions(p: Project, levelId: string): DimChain[] {
  const walls = p.elements.filter((e): e is Wall => e.kind === 'wall' && e.levelId === levelId);
  const center = levelCenter(p, levelId);
  const chains: DimChain[] = [];
  for (const w of walls) {
    const g = wallGeom(p, w, center);
    const ext = isExteriorWall(p, w);
    const o = ext ? faceOffset(g, 'esterno') : g.half;
    const out = mul(g.n, Math.sign(o) || 1);
    const origin = add(w.a, mul(g.n, o));
    const start: DimMark = { s: startAt(g, o), ref: { k: 'inizio', wallId: w.id } };
    const end: DimMark = { s: endAt(g, o), ref: { k: 'fine', wallId: w.id } };
    const inner: DimMark[] = [];
    for (const sp of openingSpans(p, w)) {
      inner.push({ s: sp.start, ref: { k: 'apertura', id: sp.opening.id, edge: 0 } });
      inner.push({ s: sp.end, ref: { k: 'apertura', id: sp.opening.id, edge: 1 } });
    }
    for (const j of junctions(p, g, walls)) {
      inner.push({ s: j.s - j.half, ref: { k: 'giunto', wallId: j.wall.id, face: 0 } });
      inner.push({ s: j.s + j.half, ref: { k: 'giunto', wallId: j.wall.id, face: 1 } });
    }
    inner.sort((x, y) => x.s - y.s);
    const base = { wallId: w.id, origin, dir: g.d, out, endFixed: g.b.kind === 'T' };
    if (inner.length) chains.push({ ...base, id: `${w.id}:1`, row: 1, marks: [start, ...inner, end] });
    chains.push({ ...base, id: `${w.id}:2`, row: inner.length ? 2 : 1, marks: [start, end] });
  }
  return dropDuplicates(p, walls, chains);
}

/**
 * Un muro interno quotato con la sola lunghezza è superfluo se la stessa misura, sullo stesso
 * tratto, compare già in una catena parallela (tipico: due muri opposti dello stesso vano).
 */
const TOL_SPAN = 0.3;

function dropDuplicates(p: Project, walls: Wall[], chains: DimChain[]): DimChain[] {
  const byWall = new Map(walls.map((w) => [w.id, w]));
  const single = (c: DimChain) => c.marks.length === 2 && !isExteriorWall(p, byWall.get(c.wallId)!);
  const kept = chains.filter((c) => !single(c));
  const along = (c: DimChain, ref: DimChain, s: number) => dot(sub(add(c.origin, mul(c.dir, s)), ref.origin), ref.dir);
  const dup = (c: DimChain) => {
    const c0 = along(c, c, c.marks[0].s);
    const c1 = along(c, c, c.marks[1].s);
    return kept.some((d) => {
      if (d.wallId === c.wallId || Math.abs(d.dir.x * c.dir.y - d.dir.y * c.dir.x) > 0.01) return false;
      // distanza tra le due linee: entro un vano
      const off = Math.abs(dot(sub(d.origin, c.origin), { x: -c.dir.y, y: c.dir.x }));
      if (off > 8) return false;
      // un segmento che copre lo stesso intervallo, a meno degli spessori dei muri
      for (let i = 0; i + 1 < d.marks.length; i++)
        for (let j = i + 1; j <= i + 1; j++) {
          const t0 = along(d, c, d.marks[i].s);
          const t1 = along(d, c, d.marks[j].s);
          if (Math.abs(Math.min(t0, t1) - Math.min(c0, c1)) < TOL_SPAN && Math.abs(Math.max(t0, t1) - Math.max(c0, c1)) < TOL_SPAN) return true;
        }
      return false;
    });
  };
  const out = [...kept];
  for (const c of chains) {
    if (!single(c)) continue;
    if (dup(c)) continue;
    kept.push(c);
    out.push(c);
  }
  // ordine originale
  const order = new Map(chains.map((c, i) => [c.id, i]));
  return out.sort((x, y) => order.get(x.id)! - order.get(y.id)!);
}

/** Il segmento k (tra i segni k e k+1) è modificabile? Restituisce una descrizione */
export function segmentEdit(chain: DimChain, k: number): string | null {
  const a = chain.marks[k]?.ref;
  const b = chain.marks[k + 1]?.ref;
  if (!a || !b) return null;
  if (b.k === 'apertura' && b.edge === 0) return 'sposta l’apertura';
  if (b.k === 'giunto' && b.face === 0) return 'sposta il muro';
  if (b.k === 'fine' && !chain.endFixed) return 'allunga o accorcia il muro';
  return null; // larghezza di un’apertura o spessore di un muro: si cambiano dalla tipologia
}

// ───────── Applicazione delle modifiche ─────────

/** Sposta un estremo del muro mantenendo ferme in pianta le sue aperture */
function setWallEnd(d: Project, w: Wall, end: 'a' | 'b', P: Vec2) {
  if (end === 'a') {
    const dir = norm(sub(w.b, w.a));
    const shift = dot(sub(P, w.a), dir);
    for (const e of d.elements) if (e.kind === 'opening' && e.wallId === w.id) e.offset -= shift;
    w.a = P;
  } else w.b = P;
}

/** Muri il cui estremo coincide con P: l'estremo segue lo spostamento */
function followEndpoints(d: Project, levelId: string, skip: Set<string>, P: Vec2, delta: Vec2) {
  for (const o of d.elements) {
    if (o.kind !== 'wall' || o.levelId !== levelId || skip.has(o.id)) continue;
    if (dist(o.a, P) < 0.02) setWallEnd(d, o, 'a', add(o.a, delta));
    else if (dist(o.b, P) < 0.02) setWallEnd(d, o, 'b', add(o.b, delta));
  }
}

/** Trasla un muro intero; gli estremi collegati degli altri muri lo seguono */
function translateWall(d: Project, w: Wall, delta: Vec2, skip: Set<string>) {
  const a0 = w.a;
  const b0 = w.b;
  w.a = add(w.a, delta);
  w.b = add(w.b, delta);
  const s = new Set([...skip, w.id]);
  followEndpoints(d, w.levelId, s, a0, delta);
  followEndpoints(d, w.levelId, s, b0, delta);
  // i muri innestati a T sul muro spostato restano attaccati: l'estremo segue in direzione normale
  const n = { x: -(b0.y - a0.y), y: b0.x - a0.x };
  const nl = Math.hypot(n.x, n.y) || 1;
  const nn = { x: n.x / nl, y: n.y / nl };
  const shiftN = mul(nn, dot(delta, nn));
  for (const o of d.elements) {
    if (o.kind !== 'wall' || s.has(o.id) || o.levelId !== w.levelId) continue;
    for (const end of ['a', 'b'] as const) {
      const pr = projectOnSegment(o[end], a0, b0);
      if (pr.d < 0.02 && pr.t > 1e-3 && pr.t < 1 - 1e-3) setWallEnd(d, o, end, add(o[end], shiftN));
    }
  }
}

export function applyDimension(d: Project, chain: DimChain, k: number, value: number) {
  const cur = chain.marks[k + 1].s - chain.marks[k].s;
  const delta = value - cur;
  if (Math.abs(delta) < 1e-6) return;
  const ref = chain.marks[k + 1].ref;
  const host = d.elements.find((e) => e.id === chain.wallId);
  if (!host || host.kind !== 'wall') return;
  const shift = mul(chain.dir, delta);

  if (ref.k === 'apertura' && ref.edge === 0) {
    const o = d.elements.find((e) => e.id === ref.id);
    if (o && o.kind === 'opening') o.offset += delta;
    return;
  }
  if (ref.k === 'giunto' && ref.face === 0) {
    const w = d.elements.find((e) => e.id === ref.wallId);
    if (w && w.kind === 'wall') translateWall(d, w, shift, new Set([host.id]));
    return;
  }
  if (ref.k === 'fine') {
    // l'estremo finale si sposta; un muro d'angolo collegato trasla insieme
    const b0 = host.b;
    const corner = d.elements.find(
      (e): e is Wall =>
        e.kind === 'wall' && e.id !== host.id && e.levelId === host.levelId && (dist(e.a, b0) < 0.02 || dist(e.b, b0) < 0.02),
    );
    host.b = add(host.b, shift);
    if (corner) {
      const cd = norm(sub(corner.b, corner.a));
      if (Math.abs(dot(cd, chain.dir)) < 0.98) translateWall(d, corner, shift, new Set([host.id]));
      else setWallEnd(d, corner, dist(corner.a, b0) < 0.02 ? 'a' : 'b', host.b);
    }
  }
}
