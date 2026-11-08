// Quote associative: catene di quote calcolate dal modello e modifiche guidate dalle quote.
//
// Muri perimetrali: due catene sul lato esterno (parziali: aperture e tramezzi; totale).
// Muri interni: una catena con aperture e muri che vi si innestano.
// Scrivendo una nuova misura si sposta l'elemento all'estremità destra del segmento.

import type { Project, Vec2, Wall } from './types';
import { add, byId, columnQuad, dist, dot, mul, norm, openingSpans, projectOnSegment, sub, wallThickness } from './geometry';
import { endAt, faceOffset, levelCenter, startAt, wallGeom, type WallGeom } from './walls';

export type MarkRef =
  | { k: 'inizio' | 'fine'; wallId: string }
  | { k: 'apertura'; id: string; edge: 0 | 1 }
  | { k: 'giunto'; wallId: string; face: 0 | 1 }
  /** vertice di un solaio (catene sui bordi liberi) */
  | { k: 'vertice'; slabId: string; index: number }
  /** faccia di un pilastro lungo la catena */
  | { k: 'pilastro'; id: string; edge: 0 | 1 }
  /** punto fisso (fine di un muro, faccia di riferimento): non si sposta dalla quota */
  | { k: 'punto' };

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
  return [...dropDuplicates(p, walls, chains), ...freeEdgeChains(p, levelId, walls)];
}

/**
 * Catene sui bordi liberi dei solai del livello (balconi, pensiline, pavimentazioni esterne):
 * lunghezza del bordo e pilastri vicini, sul lato esterno del solaio.
 */
function freeEdgeChains(p: Project, levelId: string, walls: Wall[]): DimChain[] {
  const out: DimChain[] = [];
  const below = (() => {
    const lv = p.levels.find((l) => l.id === levelId);
    const lower = p.levels.filter((l) => lv && l.elevation < lv.elevation - 1e-6).sort((a, b) => b.elevation - a.elevation)[0];
    return lower ? p.elements.filter((e): e is Wall => e.kind === 'wall' && e.levelId === lower.id) : [];
  })();
  const columns = p.elements.filter((e) => e.kind === 'column' && e.levelId === levelId);
  const placed = new Set<string>();
  for (const s of p.elements) {
    if (s.kind !== 'slab' || s.levelId !== levelId || s.points.length < 3) continue;
    const pts = s.points;
    let area2 = 0;
    pts.forEach((a, i) => {
      const b = pts[(i + 1) % pts.length];
      area2 += a.x * b.y - b.x * a.y;
    });
    const sign = area2 >= 0 ? 1 : -1;
    pts.forEach((a, i) => {
      const j = (i + 1) % pts.length;
      const b = pts[j];
      const L = dist(a, b);
      if (L < 0.3) return;
      const d = norm(sub(b, a));
      // tratti del lato che non poggiano su un muro (tutto il lato, o la parte che sporge)
      const free = freeIntervals(a, b, [...walls, ...below]);
      free.forEach(([t0, t1], fi) => {
      if (t1 - t0 < 0.3) return;
      const nOut = { x: d.y * sign, y: -d.x * sign };
      const marks: DimMark[] = [
        { s: t0, ref: t0 < 1e-6 ? { k: 'vertice', slabId: s.id, index: i } : { k: 'punto' } },
        { s: t1, ref: t1 > L - 1e-6 ? { k: 'vertice', slabId: s.id, index: j } : { k: 'punto' } },
      ];
      // pilastri a ridosso del bordo
      for (const c of columns) {
        if (c.kind !== 'column') continue;
        const q = columnQuad(c, byId(p.catalog.column, c.typeId));
        const off = q.map((v) => dot(sub(v, a), nOut));
        if (Math.min(...off) > 0.05 || Math.max(...off) < -0.8) continue;
        const ss = q.map((v) => dot(sub(v, a), d));
        const s0 = Math.min(...ss);
        const s1 = Math.max(...ss);
        if (s1 < t0 - 0.05 || s0 > t1 + 0.05) continue;
        placed.add(c.id);
        marks.push({ s: Math.max(t0, s0), ref: { k: 'pilastro', id: c.id, edge: 0 } }, { s: Math.min(t1, s1), ref: { k: 'pilastro', id: c.id, edge: 1 } });
      }
      marks.sort((x, y) => x.s - y.s);
      // segni coincidenti (pilastro a filo dello spigolo): si tiene il vertice
      const clean = marks.filter((m, k) => k === 0 || Math.abs(m.s - marks[k - 1].s) > 1e-3 || m.ref.k !== 'pilastro');
      out.push({ id: `${s.id}:e${i}${fi ? '-' + fi : ''}`, wallId: s.id, origin: a, dir: d, out: nOut, row: 1, marks: clean, endFixed: false });
      });
    });
  }
  out.push(...isolatedColumnChains(p, levelId, walls, placed));
  return out;
}

/** Parti del segmento a→b (in ascissa 0..L) che non giacciono sull'asse di alcun muro */
function freeIntervals(a: Vec2, b: Vec2, walls: Wall[]): [number, number][] {
  const ed = norm(sub(b, a));
  const L = dist(a, b);
  let segs: [number, number][] = [[0, L]];
  for (const w of walls) {
    const wd = norm(sub(w.b, w.a));
    if (Math.abs(ed.x * wd.y - ed.y * wd.x) > 0.01) continue;
    const off = (q: Vec2) => Math.abs((q.x - w.a.x) * wd.y - (q.y - w.a.y) * wd.x);
    if (off(a) > 0.02 || off(b) > 0.02) continue;
    const t = (q: Vec2) => dot(sub(q, a), ed);
    const w0 = Math.min(t(w.a), t(w.b));
    const w1 = Math.max(t(w.a), t(w.b));
    segs = segs.flatMap(([x, y]) => (w1 <= x || w0 >= y ? [[x, y] as [number, number]] : ([[x, w0], [w1, y]] as [number, number][]).filter(([m, n]) => n - m > 1e-3)));
  }
  return segs;
}

/**
 * Pilastri isolati (non in un muro né lungo il bordo di un solaio): quote in x e in y dalla faccia
 * del muro parallelo più vicino; la prima quota sposta il pilastro.
 */
function isolatedColumnChains(p: Project, levelId: string, walls: Wall[], placed: Set<string>): DimChain[] {
  const out: DimChain[] = [];
  for (const c of p.elements) {
    if (c.kind !== 'column' || c.levelId !== levelId || placed.has(c.id)) continue;
    const t = byId(p.catalog.column, c.typeId);
    const q = columnQuad(c, t);
    // dentro un muro: le sue quote sono quelle del muro
    const inWall = walls.some((w) => projectOnSegment(c.p, w.a, w.b).d < wallThickness(byId(p.catalog.wall, w.typeId)) / 2 + 0.01);
    if (inWall) continue;
    for (const dir of [{ x: 1, y: 0 }, { x: 0, y: 1 }]) {
      const across = { x: -dir.y, y: dir.x };
      const ss = q.map((v) => dot(v, dir));
      const c0 = Math.min(...ss);
      const c1 = Math.max(...ss);
      const cc = dot(c.p, across);
      // facce dei muri perpendicolari a dir che "vedono" il pilastro
      let best: { face: number; sign: number; dist: number } | null = null;
      for (const w of walls) {
        const wd = norm(sub(w.b, w.a));
        if (Math.abs(dot(wd, dir)) > 0.02) continue;
        const span = [dot(w.a, across), dot(w.b, across)].sort((x, y) => x - y);
        if (cc < span[0] - 1 || cc > span[1] + 1) continue;
        const half = wallThickness(byId(p.catalog.wall, w.typeId)) / 2;
        const ax = dot(w.a, dir);
        for (const face of [ax - half, ax + half]) {
          const sign = face <= c0 ? 1 : face >= c1 ? -1 : 0;
          if (!sign) continue;
          const dd = sign > 0 ? c0 - face : face - c1;
          if (!best || dd < best.dist) best = { face, sign, dist: dd };
        }
      }
      if (!best || best.dist > 15) continue;
      const d = { x: dir.x * best.sign, y: dir.y * best.sign };
      const origin = { x: dir.x * best.face + across.x * cc, y: dir.y * best.face + across.y * cc };
      const near = best.sign > 0 ? c0 : c1;
      const far = best.sign > 0 ? c1 : c0;
      const sNear = Math.abs(near - best.face);
      const sFar = Math.abs(far - best.face);
      out.push({
        id: `${c.id}:${dir.x ? 'x' : 'y'}`,
        wallId: c.id,
        origin,
        dir: d,
        out: { x: -d.y, y: d.x },
        row: 1,
        marks: [
          { s: 0, ref: { k: 'punto' } },
          { s: sNear, ref: { k: 'pilastro', id: c.id, edge: 0 } },
          { s: sFar, ref: { k: 'pilastro', id: c.id, edge: 1 } },
        ],
        endFixed: false,
      });
    }
  }
  return out;
}

/**
 * Un muro interno quotato con la sola lunghezza è superfluo se la stessa misura, sullo stesso
 * tratto, compare già in una catena parallela (tipico: due muri opposti dello stesso vano).
 */
const TOL_SPAN = 0.3;

function dropDuplicates(p: Project, walls: Wall[], chains: DimChain[]): DimChain[] {
  const byWall = new Map(walls.map((w) => [w.id, w]));
  const single = (c: DimChain) => c.marks.length === 2 && byWall.has(c.wallId) && !isExteriorWall(p, byWall.get(c.wallId)!);
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
  if (b.k === 'vertice') return 'sposta il bordo del solaio';
  if (b.k === 'pilastro' && b.edge === 0) return 'sposta il pilastro';
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
  const shift = mul(chain.dir, delta);
  if (ref.k === 'vertice') {
    // il vertice si sposta lungo la catena; i vertici dei lati perpendicolari lo seguono (forma conservata)
    const s = d.elements.find((e) => e.id === ref.slabId);
    if (!s || s.kind !== 'slab') return;
    const n = s.points.length;
    const moved = new Set<number>([ref.index]);
    for (const step of [1, -1]) {
      const nb = (ref.index + step + n) % n;
      const e = norm(sub(s.points[nb], s.points[ref.index]));
      if (Math.abs(dot(e, chain.dir)) < 0.02 && !(nb === (ref.index - step + n) % n)) moved.add(nb);
    }
    // non spostare l'altro estremo della catena
    const startIdx = chain.marks[k].ref.k === 'vertice' ? (chain.marks[k].ref as { index: number }).index : -1;
    moved.delete(startIdx);
    for (const i of moved) s.points[i] = add(s.points[i], shift);
    return;
  }
  if (ref.k === 'pilastro' && ref.edge === 0) {
    const c = d.elements.find((e) => e.id === ref.id);
    if (!c || c.kind !== 'column') return;
    const old = c.p;
    c.p = add(c.p, shift);
    // le travi appoggiate sul pilastro lo seguono
    for (const b of d.elements)
      if (b.kind === 'beam') {
        if (dist(b.a, old) < 0.02) b.a = add(b.a, shift);
        if (dist(b.b, old) < 0.02) b.b = add(b.b, shift);
      }
    return;
  }
  const host = d.elements.find((e) => e.id === chain.wallId);
  if (!host || host.kind !== 'wall') return;

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
