// Quote associative: catene di quote calcolate dal modello e modifiche guidate dalle quote.
//
// Muri perimetrali: due catene sul lato esterno (parziali: aperture e tramezzi; totale).
// Muri interni: una catena con aperture e muri che vi si innestano.
// Scrivendo una nuova misura si sposta l'elemento all'estremità destra del segmento.

import type { Project, Vec2, Wall } from './types';
import { add, byId, columnQuad, dist, dot, JOIN_TOL, mul, norm, openingSpans, projectOnSegment, sub, wallThickness } from './geometry';
import { fitWallOpenings, wallFreeSpan } from './openingFit';
import { endAt, faceOffset, levelCenter, startAt, wallGeom, wallsNear, type WallGeom } from './walls';

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
  /** Lo stesso per l'estremo iniziale */
  startFixed?: boolean;
}

export function isExteriorWall(p: Project, w: Wall) {
  const t = byId(p.catalog.wall, w.typeId);
  return !!t?.layers.some((l) => l.role === 'isolante') || wallThickness(t) >= 0.25;
}

/** Muri che si innestano a T sull'asse del muro g, con la loro posizione s */
/** Seno minimo dell'angolo tra due muri perché uno si innesti a T nell'altro (circa 15°) */
const MIN_T_SIN = 0.26;

function junctions(p: Project, g: WallGeom) {
  const out: { wall: Wall; s: number; half: number }[] = [];
  for (const o of wallsNear(p, g.wall.levelId, g.wall.a, g.wall.b)) {
    if (o.id === g.wall.id) continue;
    for (const P of [o.a, o.b]) {
      const pr = projectOnSegment(P, g.wall.a, g.wall.b);
      if (pr.d < JOIN_TOL && pr.t > 1e-3 && pr.t < 1 - 1e-3) {
        const dO = norm(sub(o.b, o.a));
        const sin = Math.abs(dot(dO, g.n));
        // un muro collineare (sovrapposto) o quasi parallelo non è un innesto a T
        if (sin < MIN_T_SIN) continue;
        const h = wallThickness(byId(p.catalog.wall, o.typeId)) / 2 / sin;
        // l'innesto non va oltre le estremità del muro
        const lo = Math.max(0, pr.t * g.L - h);
        const hi = Math.min(g.L, pr.t * g.L + h);
        if (hi - lo < 1e-3) continue;
        out.push({ wall: o, s: (lo + hi) / 2, half: (hi - lo) / 2 });
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
    for (const j of junctions(p, g)) {
      inner.push({ s: j.s - j.half, ref: { k: 'giunto', wallId: j.wall.id, face: 0 } });
      inner.push({ s: j.s + j.half, ref: { k: 'giunto', wallId: j.wall.id, face: 1 } });
    }
    inner.sort((x, y) => x.s - y.s);
    const base = { wallId: w.id, origin, dir: g.d, out, endFixed: g.b.kind === 'T', startFixed: g.a.kind === 'T' };
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
      // estremi: dove il tratto parte da un muro, la quota parte dal suo filo esterno (punto fisso)
      const faceAt = (t: number, toward: 1 | -1) => {
        const J = add(a, mul(d, t));
        const host = [...walls, ...below].find((w) => {
          const wd = norm(sub(w.b, w.a));
          return Math.abs(dot(wd, d)) < 0.05 && projectOnSegment(J, w.a, w.b).d < JOIN_TOL;
        });
        return host ? t + toward * (wallThickness(byId(p.catalog.wall, host.typeId)) / 2) : null;
      };
      const f0 = faceAt(t0, 1);
      const f1 = faceAt(t1, -1);
      const marks: DimMark[] = [
        f0 !== null ? { s: f0, ref: { k: 'punto' } } : { s: t0, ref: t0 < 1e-6 ? { k: 'vertice', slabId: s.id, index: i } : { k: 'punto' } },
        f1 !== null ? { s: f1, ref: { k: 'punto' } } : { s: t1, ref: t1 > L - 1e-6 ? { k: 'vertice', slabId: s.id, index: j } : { k: 'punto' } },
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
      const id = `${s.id}:e${i}${fi ? '-' + fi : ''}`;
      if (clean[0].ref.k === 'vertice' && clean[clean.length - 1].ref.k === 'punto') {
        // il vertice libero va in fondo alla catena (la quota sposta l'ultimo segno): si rovescia il verso
        // nel verso opposto le facce del pilastro si scambiano: edge 0 resta la faccia che si incontra per prima
        const rev = clean
          .map((m) => ({ s: L - m.s, ref: m.ref.k === 'pilastro' ? { ...m.ref, edge: (1 - m.ref.edge) as 0 | 1 } : m.ref }))
          .reverse();
        out.push({ id, wallId: s.id, origin: b, dir: mul(d, -1), out: nOut, row: 1, marks: rev, endFixed: false });
      } else out.push({ id, wallId: s.id, origin: a, dir: d, out: nOut, row: 1, marks: clean, endFixed: false });
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
    if (off(a) > JOIN_TOL || off(b) > JOIN_TOL) continue;
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

/** Da quale lato del segmento sta l'elemento che si sposta scrivendo la misura */
export type DimSide = 'inizio' | 'fine';

/** Che cosa si sposta se il segno è l'estremo finale (fine) o iniziale (inizio) del segmento */
function markEdit(chain: DimChain, ref: MarkRef, side: DimSide): string | null {
  // all'estremo finale del segmento si sposta l'elemento che comincia lì, all'iniziale quello che finisce lì
  const near = side === 'fine' ? 0 : 1;
  if (ref.k === 'apertura' && ref.edge === near) return 'l’apertura';
  if (ref.k === 'vertice') return 'il bordo del solaio';
  if (ref.k === 'pilastro' && ref.edge === near) return 'il pilastro';
  if (ref.k === 'giunto' && ref.face === near) return 'il muro innestato';
  if (side === 'fine' && ref.k === 'fine' && !chain.endFixed) return 'la fine del muro';
  if (side === 'inizio' && ref.k === 'inizio' && !chain.startFixed) return 'l’inizio del muro';
  return null; // larghezza di un’apertura o spessore di un muro: si cambiano dalla tipologia; punti fissi
}

/** Elementi che si possono spostare scrivendo la misura del segmento k, da ciascun lato */
export function segmentEdits(chain: DimChain, k: number): Record<DimSide, string | null> {
  const a = chain.marks[k]?.ref;
  const b = chain.marks[k + 1]?.ref;
  if (!a || !b) return { inizio: null, fine: null };
  return { inizio: markEdit(chain, a, 'inizio'), fine: markEdit(chain, b, 'fine') };
}

/** Lato che si sposta se non si sceglie: quello finale, se si può, altrimenti l'iniziale */
export function defaultSide(chain: DimChain, k: number): DimSide | null {
  const e = segmentEdits(chain, k);
  return e.fine ? 'fine' : e.inizio ? 'inizio' : null;
}

/** Il segmento k (tra i segni k e k+1) è modificabile? Restituisce una descrizione */
export function segmentEdit(chain: DimChain, k: number): string | null {
  const e = segmentEdits(chain, k);
  if (e.fine && e.inizio) return `sposta ${e.fine} (o ${e.inizio})`;
  return e.fine ? `sposta ${e.fine}` : e.inizio ? `sposta ${e.inizio}` : null;
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
    if (dist(o.a, P) < JOIN_TOL) setWallEnd(d, o, 'a', add(o.a, delta));
    else if (dist(o.b, P) < JOIN_TOL) setWallEnd(d, o, 'b', add(o.b, delta));
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
      if (pr.d < JOIN_TOL && pr.t > 1e-3 && pr.t < 1 - 1e-3) setWallEnd(d, o, end, add(o[end], shiftN));
    }
  }
}

const fmt = (v: number) => v.toFixed(2).replace('.', ',');

/**
 * Controlla una nuova misura prima di applicarla. Restituisce il motivo del rifiuto, o null se va bene.
 * Un'apertura deve restare intera nel tratto libero del muro (tra le facce dei muri d'angolo),
 * senza sovrapporsi ad altre aperture o ai muri innestati a T.
 */
export function dimensionError(p: Project, chain: DimChain, k: number, value: number, side: DimSide | null = defaultSide(chain, k)): string | null {
  if (!(value > 0) || !Number.isFinite(value)) return 'La misura deve essere un numero maggiore di zero.';
  return openingError(p, chain, k, value, side);
}

/** Allungando o accorciando un muro le sue aperture devono restarci dentro */
function lengthError(p: Project, chain: DimChain, cur: number, value: number, side: DimSide): string | null {
  const host = p.elements.find((e): e is Wall => e.kind === 'wall' && e.id === chain.wallId);
  if (!host) return null;
  const g = wallGeom(p, host);
  const { s0, s1 } = wallFreeSpan(g);
  const cuts = s0 + (g.L - s1);
  const need = openingSpans(p, host).reduce((t, x) => t + x.type.width, 0);
  const minL = Math.max(cuts + need, 0.05);
  // dalla fine il muro si allunga con la misura; dall'inizio si accorcia
  const along = dot(chain.dir, g.d) || 1;
  const newL = g.L + (side === 'fine' ? value - cur : cur - value) * along;
  if (newL >= minL - 1e-6) return null;
  const vLim = side === 'fine' ? cur + (minL - g.L) / along : cur - (minL - g.L) / along;
  const what = side === 'fine' ? 'minima' : 'massima';
  return need > 0
    ? `Il muro diventerebbe troppo corto per le sue aperture: misura ${what} ${fmt(vLim)} m.`
    : `Il muro diventerebbe troppo corto: misura ${what} ${fmt(vLim)} m.`;
}

/** Riporta le aperture del muro dentro il suo tratto libero, senza sovrapporle (sulla bozza d) */
function refitOpenings(d: Project, host: Wall) {
  const fit = fitWallOpenings(d, host, { separate: true });
  if (!fit.ok) return;
  for (const e of d.elements) if (e.kind === 'opening' && fit.offsets.has(e.id)) e.offset = fit.offsets.get(e.id)!;
}

function openingError(p: Project, chain: DimChain, k: number, value: number, side: DimSide | null): string | null {
  const a = chain.marks[k];
  const b = chain.marks[k + 1];
  if (!a || !b || !side) return null;
  const cur = b.s - a.s;
  const ref = side === 'fine' ? b.ref : a.ref;
  if (ref.k === 'fine' || ref.k === 'inizio') return lengthError(p, chain, cur, value, side);
  if (ref.k !== 'apertura') return null;
  const host = p.elements.find((e): e is Wall => e.kind === 'wall' && e.id === chain.wallId);
  const sp = host && openingSpans(p, host).find((x) => x.opening.id === ref.id);
  if (!host || !sp) return null;
  const g = wallGeom(p, host);
  // ostacoli lungo il muro: altre aperture e muri innestati
  const obstacles: [number, number][] = [
    ...openingSpans(p, host)
      .filter((x) => x.opening.id !== ref.id)
      .map((x) => [x.start, x.end] as [number, number]),
    ...junctions(p, g).map((j) => [j.s - j.half, j.s + j.half] as [number, number]),
  ];
  let lo = Math.max(startAt(g, g.half), startAt(g, -g.half), 0);
  let hi = Math.min(endAt(g, g.half), endAt(g, -g.half), g.L);
  for (const [o0, o1] of obstacles) {
    if (o1 <= sp.start + 1e-6) lo = Math.max(lo, o1);
    else if (o0 >= sp.end - 1e-6) hi = Math.min(hi, o0);
  }
  // spostamento ammesso lungo il muro, poi in misura del segmento
  const mMin = lo - sp.start;
  const mMax = hi - sp.type.width - sp.start;
  const along = dot(chain.dir, g.d) || 1;
  const toValue = (m: number) => (side === 'fine' ? cur + m / along : cur - m / along);
  const v1 = toValue(mMin);
  const v2 = toValue(mMax);
  const vMin = Math.min(v1, v2);
  const vMax = Math.max(v1, v2);
  if (value < vMin - 1e-4 || value > vMax + 1e-4)
    return mMax < mMin
      ? 'L’apertura non ha spazio per spostarsi: modifica annullata.'
      : `L’apertura uscirebbe dal tratto libero del muro o si sovrapporrebbe ad altri elementi: misura ammessa da ${fmt(Math.max(0, vMin))} a ${fmt(vMax)} m.`;
  return null;
}

/** Sposta l'elemento indicato dal segno lungo la catena di m (metri, verso chain.dir) */
function moveMark(d: Project, chain: DimChain, ref: MarkRef, other: MarkRef, m: number) {
  const shift = mul(chain.dir, m);
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
    // l'altro estremo del segmento resta fermo
    if (other.k === 'vertice' && other.slabId === ref.slabId) moved.delete(other.index);
    for (const i of moved) s.points[i] = add(s.points[i], shift);
    return;
  }
  if (ref.k === 'pilastro') {
    const c = d.elements.find((e) => e.id === ref.id);
    if (!c || c.kind !== 'column') return;
    const old = c.p;
    c.p = add(c.p, shift);
    // le travi appoggiate sul pilastro lo seguono
    for (const b of d.elements)
      if (b.kind === 'beam' && b.levelId === c.levelId) {
        if (dist(b.a, old) < JOIN_TOL) b.a = add(b.a, shift);
        if (dist(b.b, old) < JOIN_TOL) b.b = add(b.b, shift);
      }
    return;
  }
  const host = d.elements.find((e): e is Wall => e.kind === 'wall' && e.id === chain.wallId);
  if (!host) return;
  if (ref.k === 'apertura') {
    const o = d.elements.find((e) => e.id === ref.id);
    if (o && o.kind === 'opening') o.offset += m * (dot(chain.dir, norm(sub(host.b, host.a))) || 1);
    return;
  }
  if (ref.k === 'giunto') {
    const w = d.elements.find((e) => e.id === ref.wallId);
    if (w && w.kind === 'wall') translateWall(d, w, shift, new Set([host.id]));
    return;
  }
  if (ref.k === 'fine' || ref.k === 'inizio') {
    // l'estremo si sposta; un muro d'angolo collegato trasla insieme (o, se allineato, segue l'estremo)
    const end = ref.k === 'fine' ? 'b' : 'a';
    const P0 = host[end];
    const corner = d.elements.find(
      (e): e is Wall => e.kind === 'wall' && e.id !== host.id && e.levelId === host.levelId && (dist(e.a, P0) < JOIN_TOL || dist(e.b, P0) < JOIN_TOL),
    );
    setWallEnd(d, host, end, add(P0, shift));
    if (corner) {
      const cd = norm(sub(corner.b, corner.a));
      if (Math.abs(dot(cd, chain.dir)) < 0.98) translateWall(d, corner, shift, new Set([host.id]));
      else setWallEnd(d, corner, dist(corner.a, P0) < JOIN_TOL ? 'a' : 'b', host[end]);
    }
    refitOpenings(d, host);
  }
}

/**
 * Scrive la misura del segmento k. side dice quale elemento si sposta: quello alla fine del segmento
 * (predefinito, se si può) o quello all'inizio; l'altro resta fermo.
 */
export function applyDimension(d: Project, chain: DimChain, k: number, value: number, side: DimSide | null = defaultSide(chain, k)) {
  if (!side || !segmentEdits(chain, k)[side]) return;
  if (openingError(d, chain, k, value, side)) return;
  const cur = chain.marks[k + 1].s - chain.marks[k].s;
  const delta = value - cur;
  if (Math.abs(delta) < 1e-6) return;
  if (side === 'fine') moveMark(d, chain, chain.marks[k + 1].ref, chain.marks[k].ref, delta);
  else moveMark(d, chain, chain.marks[k].ref, chain.marks[k + 1].ref, -delta);
}

// ───────── Disposizione delle catene in pianta ─────────

/** Distanza della prima linea di quota dal suo elemento e passo tra linee successive (mm di carta) */
export const DIM_FIRST = 6;
export const DIM_STEP = 7;

export interface PlacedChain {
  chain: DimChain;
  /** distanza della linea di quota dall'elemento quotato, in mm di carta */
  offset: number;
}

/**
 * Dispone le catene perché non si sovrappongano: due catene parallele, rivolte dallo stesso lato,
 * che cadrebbero sulla stessa linea in tratti che si sovrappongono vanno su linee successive.
 * Una catena con le stesse misure di una già disposta, vicina e dallo stesso lato, si omette.
 * unit = metri per mm di carta (comprende l'ingrandimento dei testi a schermo).
 */
export function layoutDimensions(chains: DimChain[], unit: number, fixed: Record<string, number> = {}): PlacedChain[] {
  type Line = { d: Vec2; out: Vec2; perp: number; t0: number; t1: number; feature: number; marks: string };
  const placed: Line[] = [];
  const result: PlacedChain[] = [];
  const canon = (d: Vec2) => (d.x < -1e-9 || (Math.abs(d.x) < 1e-9 && d.y < 0) ? { x: -d.x, y: -d.y } : d);
  // prima le catene parziali (vicine all'edificio), poi i totali; a parità le più lunghe
  // prima quelle spostate a mano (la loro posizione è decisa), poi le altre
  const order = [...chains].sort((a, b) => Number(b.id in fixed) - Number(a.id in fixed) || a.row - b.row || Math.abs(b.marks[b.marks.length - 1].s - b.marks[0].s) - Math.abs(a.marks[a.marks.length - 1].s - a.marks[0].s));
  for (const c of order) {
    const d = canon(c.dir);
    const at = (s: number) => add(c.origin, mul(c.dir, s));
    const ts = c.marks.map((m) => dot(at(m.s), d));
    const t0 = Math.min(...ts);
    const t1 = Math.max(...ts);
    const feature = dot(c.origin, c.out);
    const marks = ts
      .map((t) => Math.round(t * 100))
      .sort((x, y) => x - y)
      .join(',');
    const same = (l: Line) => Math.abs(l.d.x * d.y - l.d.y * d.x) < 0.01 && dot(l.out, c.out) > 0.9;
    // stesse misure, stesso lato, a meno di un metro: è la stessa informazione
    if (placed.some((l) => same(l) && l.marks === marks && Math.abs(l.feature - feature) < 1)) continue;
    let offset = fixed[c.id];
    if (offset === undefined) {
      // posizione automatica: la prima linea libera
      let k = c.row === 1 ? 0 : 1;
      for (; k < 8; k++) {
        const perp = feature + (DIM_FIRST + DIM_STEP * k) * unit;
        const clash = placed.some((l) => same(l) && Math.abs(l.perp - perp) < 4 * unit && l.t0 < t1 - 0.01 && l.t1 > t0 + 0.01);
        if (!clash) break;
      }
      offset = DIM_FIRST + DIM_STEP * k;
    }
    placed.push({ d, out: c.out, perp: feature + offset * unit, t0, t1, feature, marks });
    result.push({ chain: c, offset });
  }
  return result;
}

// ───────── Allineamento delle linee di quota ─────────

/** Linea di quota in pianta: un suo punto e la direzione */
export interface DimLine {
  id: string;
  q: Vec2;
  d: Vec2;
}

/** Linee di quota del livello: catene automatiche (dove sono disposte) e quote disegnate a mano */
export function dimLines(placed: PlacedChain[], annotations: Project['annotations'], levelId: string, unit: number): DimLine[] {
  const out: DimLine[] = placed.map(({ chain: c, offset }) => ({ id: c.id, q: add(c.origin, mul(c.out, offset * unit)), d: c.dir }));
  for (const n of annotations ?? []) {
    if (n.kind !== 'quota' || n.levelId !== levelId) continue;
    const d = norm(sub(n.b, n.a));
    out.push({ id: n.id, q: add(n.a, mul({ x: -d.y, y: d.x }, n.offset)), d });
  }
  return out;
}

/**
 * Distanza di una linea di quota (lungo la normale nrm, dal punto base) aggancia­ta alle linee
 * parallele vicine: entro tol si allinea. Restituisce la distanza e la linea a cui si è allineata.
 */
export function snapDimLine(raw: number, base: Vec2, dir: Vec2, nrm: Vec2, lines: DimLine[], skip: string, tol: number): { value: number; to: string | null } {
  let best: { value: number; to: string; err: number } | null = null;
  for (const l of lines) {
    if (l.id === skip || Math.abs(l.d.x * dir.y - l.d.y * dir.x) > 0.01) continue;
    const v = dot(sub(l.q, base), nrm);
    const err = Math.abs(v - raw);
    if (err < tol && (!best || err < best.err)) best = { value: v, to: l.id, err };
  }
  return best ? { value: best.value, to: best.to } : { value: raw, to: null };
}

// ───────── Quote nascoste e spostate: riferimenti che seguono il modello ─────────

/** Elemento da cui nasce una catena (la parte del codice prima dei due punti) */
const chainOwner = (id: string) => id.split(':')[0];

/** Livello di un elemento (le aperture stanno sul livello del loro muro) */
function ownerLevel(p: Project, id: string): string | null {
  const e = p.elements.find((x) => x.id === id);
  return e && 'levelId' in e ? e.levelId : null;
}

/** Ingombro di una catena lungo la sua direzione, in coordinate canoniche, per riconoscerla dopo una modifica */
function chainSpan(c: DimChain) {
  const d = c.dir.x < -1e-9 || (Math.abs(c.dir.x) < 1e-9 && c.dir.y < 0) ? mul(c.dir, -1) : c.dir;
  const ts = c.marks.map((m) => dot(add(c.origin, mul(c.dir, m.s)), d));
  return { d, out: c.out, t0: Math.min(...ts), t1: Math.max(...ts), perp: dot(c.origin, c.out) };
}

/**
 * Tiene in ordine i riferimenti alle catene nascoste (hiddenDims) e spostate (dimOffsets):
 * - quelli di elementi che non esistono più si tolgono;
 * - se una catena cambia codice (un lato di solaio diviso o riunito da un muro), il riferimento passa
 *   alla catena dello stesso elemento che le somiglia di più (stesso lato, tratto che si sovrappone).
 * Lavora sulla bozza d; prev è il progetto prima della modifica.
 */
export function followDimRefs(prev: Project, d: Project): boolean {
  const hidden = d.hiddenDims ?? [];
  const offsets = d.dimOffsets ?? {};
  const ids = [...new Set([...hidden, ...Object.keys(offsets)])];
  if (!ids.length) return false;
  /** codice → codici che lo sostituiscono (vuoto = da togliere) */
  const rename = new Map<string, string[]>();
  const chainsOf = new Map<string, { prev: DimChain[]; next: DimChain[] }>();
  const levelChains = (lv: string) => {
    let c = chainsOf.get(lv);
    if (!c) chainsOf.set(lv, (c = { prev: computeDimensions(prev, lv), next: computeDimensions(d, lv) }));
    return c;
  };
  for (const id of ids) {
    const owner = chainOwner(id);
    const lv = ownerLevel(d, owner);
    // elemento eliminato: il riferimento non serve più
    if (!lv) {
      rename.set(id, []);
      continue;
    }
    // muri e pilastri hanno codici stabili (:1 parziali, :2 totale, :x/:y): solo i lati dei solai cambiano
    if (d.elements.find((e) => e.id === owner)?.kind !== 'slab') continue;
    const { prev: before, next: after } = levelChains(lv);
    const old = before.find((c) => c.id === id);
    if (!old) {
      if (!after.some((c) => c.id === id)) rename.set(id, []);
      continue;
    }
    // catene dello stesso lato che coprono il tratto di prima (un tratto diviso in due: entrambe)
    const o = chainSpan(old);
    const matches = after
      .filter((c) => {
        if (chainOwner(c.id) !== owner || c.row !== old.row) return false;
        const sp = chainSpan(c);
        if (Math.abs(sp.d.x * o.d.y - sp.d.y * o.d.x) > 0.01 || dot(sp.out, o.out) < 0.9 || Math.abs(sp.perp - o.perp) > 0.05) return false;
        return Math.min(sp.t1, o.t1) - Math.max(sp.t0, o.t0) > 0.01;
      })
      .map((c) => c.id);
    if (matches.length !== 1 || matches[0] !== id) rename.set(id, matches);
  }
  if (!rename.size) return false;
  const map = (id: string) => (rename.has(id) ? rename.get(id)! : [id]);
  if (d.hiddenDims) d.hiddenDims = [...new Set(d.hiddenDims.flatMap(map))];
  if (d.dimOffsets) {
    const next: Record<string, number> = {};
    for (const [k, v] of Object.entries(d.dimOffsets)) for (const nk of map(k)) if (!(nk in next)) next[nk] = v;
    d.dimOffsets = next;
  }
  return true;
}

/** Riferimenti a catene di elementi che non esistono (per la pulizia all'apertura dei file) */
export function pruneDimRefs(p: Project): { hiddenDims: string[]; dimOffsets: Record<string, number> } {
  const exists = (id: string) => p.elements.some((e) => e.id === chainOwner(id));
  return {
    hiddenDims: (p.hiddenDims ?? []).filter(exists),
    dimOffsets: Object.fromEntries(Object.entries(p.dimOffsets ?? {}).filter(([k]) => exists(k))),
  };
}
