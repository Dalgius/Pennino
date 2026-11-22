// Geometria delle coperture a falde.
//
// Una copertura a falde è l'insieme di falde piane. L'intradosso di una falda è un piano che passa
// per un lato di gronda alla quota d'imposta e sale verso l'interno con la pendenza della copertura:
//   U(q) = base + slope · (q·n − c)        n = direzione di salita (in pianta), c = q·n sul lato di gronda
// Ogni "pezzo" convesso della copertura (la pianta, o un suo rettangolo) prende in ogni punto la falda
// più bassa (min dei piani): nascono colmi e displuvi. Più pezzi si sommano prendendo il più alto
// (max): nascono i compluvi, come nei tetti di edifici a L, a T o a U.
// Il manto (estradosso) sta th più in alto dell'intradosso, in verticale.

import type { Project, Roof, Vec2 } from './types';
import { cached } from './cache';
import { add, bbox, byId, convexHull, dist, mul, offsetPolygon, pointInPolygon, polygonArea, roofBase, roofEave } from './geometry';

export type RoofShape = Roof['shape'];

export const ROOF_SHAPE_LABEL: Record<RoofShape, string> = {
  falde: 'A capanna (due falde)',
  padiglione: 'A padiglione',
  falda: 'A una falda',
  piana: 'Piana',
};

export interface RoofPlane {
  /** direzione di salita in pianta (unitaria) */
  n: Vec2;
  /** n·q sul lato di gronda (dove l'intradosso è alla quota d'imposta) */
  c: number;
  base: number;
  slope: number;
}

export interface RoofPiece {
  /** pianta del pezzo sugli assi dei muri (convessa) */
  poly: Vec2[];
  /** pianta con lo sporto (convessa) */
  ext: Vec2[];
  planes: RoofPlane[];
}

/** Parte visibile di una falda (poligono convesso in pianta, con lo sporto) */
export interface RoofFragment {
  plane: RoofPlane;
  poly: Vec2[];
}

export type RoofLineKind = 'colmo' | 'displuvio' | 'compluvio';

export interface RoofLine {
  a: Vec2;
  b: Vec2;
  kind: RoofLineKind;
}

export interface RoofGeom {
  base: number;
  /** spessore del pacchetto */
  th: number;
  slope: number;
  /** contorno con lo sporto */
  outline: Vec2[];
  pieces: RoofPiece[];
  fragments: RoofFragment[];
  lines: RoofLine[];
  /** quota dell'intradosso al punto più alto, sopra l'imposta */
  rise: number;
  /** superficie di falda (inclinata), sporto compreso */
  area: number;
}

/** Intradosso di un piano in un punto */
export const planeAt = (pl: RoofPlane, q: Vec2) => pl.base + pl.slope * (q.x * pl.n.x + q.y * pl.n.y - pl.c);

const signedArea = (pts: Vec2[]) => {
  let s = 0;
  pts.forEach((a, i) => {
    const b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  });
  return s / 2;
};

const ccw = (pts: Vec2[]) => (signedArea(pts) >= 0 ? pts : [...pts].reverse());

export function isOrthogonal(pts: Vec2[]) {
  return pts.length >= 4 && pts.every((a, i) => {
    const b = pts[(i + 1) % pts.length];
    return Math.abs(a.x - b.x) < 1e-6 || Math.abs(a.y - b.y) < 1e-6;
  });
}

export function isConvexPolygon(pts: Vec2[]) {
  if (pts.length < 3) return false;
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const c = pts[(i + 2) % pts.length];
    const z = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(z) < 1e-9) continue;
    if (sign && Math.sign(z) !== sign) return false;
    sign = Math.sign(z);
  }
  return true;
}

/**
 * Rettangoli massimi di un poligono ortogonale: quelli che non si possono allargare in nessuna
 * direzione restando dentro. Per una L sono i due bracci per intero, per una T la barra e il gambo.
 */
export function maximalRectangles(pts: Vec2[]): Vec2[][] {
  const uniq = (a: number[]) => [...new Set(a.map((x) => +x.toFixed(6)))].sort((p, q) => p - q);
  const xs = uniq(pts.map((q) => q.x));
  const ys = uniq(pts.map((q) => q.y));
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  const inside: boolean[][] = [];
  for (let i = 0; i < nx; i++) {
    inside[i] = [];
    for (let j = 0; j < ny; j++) inside[i][j] = pointInPolygon({ x: (xs[i] + xs[i + 1]) / 2, y: (ys[j] + ys[j + 1]) / 2 }, pts);
  }
  const full = (i0: number, i1: number, j0: number, j1: number) => {
    if (i0 < 0 || j0 < 0 || i1 >= nx || j1 >= ny) return false;
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) if (!inside[i][j]) return false;
    return true;
  };
  const out: Vec2[][] = [];
  for (let i0 = 0; i0 < nx; i0++)
    for (let i1 = i0; i1 < nx; i1++)
      for (let j0 = 0; j0 < ny; j0++)
        for (let j1 = j0; j1 < ny; j1++) {
          if (!full(i0, i1, j0, j1)) continue;
          const grows = full(i0 - 1, i1, j0, j1) || full(i0, i1 + 1, j0, j1) || full(i0, i1, j0 - 1, j1) || full(i0, i1, j0, j1 + 1);
          if (grows) continue;
          out.push([
            { x: xs[i0], y: ys[j0] },
            { x: xs[i1 + 1], y: ys[j0] },
            { x: xs[i1 + 1], y: ys[j1 + 1] },
            { x: xs[i0], y: ys[j1 + 1] },
          ]);
        }
  return out;
}

/** Piano di falda dal lato a→b di un poligono antiorario: sale verso l'interno */
function eavePlane(a: Vec2, b: Vec2, base: number, slope: number): RoofPlane {
  const l = dist(a, b) || 1;
  const n = { x: -(b.y - a.y) / l, y: (b.x - a.x) / l }; // a sinistra del lato = interno (antiorario)
  return { n, c: a.x * n.x + a.y * n.y, base, slope };
}

const rectFrom = (b: { minX: number; minY: number; maxX: number; maxY: number }): Vec2[] => [
  { x: b.minX, y: b.minY },
  { x: b.maxX, y: b.minY },
  { x: b.maxX, y: b.maxY },
  { x: b.minX, y: b.maxY },
];

/** Pianta su cui si costruisce la copertura: quella disegnata, l'involucro convesso, o il rettangolo */
function footprintOf(r: Pick<Roof, 'points' | 'shape'>): { poly: Vec2[]; parts: Vec2[][] } {
  const pts = ccw(r.points);
  if (r.shape === 'falda') return { poly: pts, parts: [pts] };
  if (isOrthogonal(pts)) return { poly: pts, parts: isConvexPolygon(pts) ? [pts] : maximalRectangles(pts).map(ccw) };
  // capanna su pianta non ortogonale: sul rettangolo che la contiene (come le versioni precedenti)
  if (r.shape === 'falde') {
    const rect = rectFrom(bbox(pts));
    return { poly: rect, parts: [rect] };
  }
  const hull = isConvexPolygon(pts) ? pts : ccw(convexHull(pts));
  return { poly: hull, parts: [hull] };
}

/** Contorno della copertura con lo sporto di gronda */
export function roofOutlineOf(r: Pick<Roof, 'points' | 'shape'>, eave: number): Vec2[] {
  if (r.shape === 'piana') return offsetPolygon(r.points, eave);
  return offsetPolygon(footprintOf(r).poly, eave);
}

function piecesOf(r: Roof, base: number, eave: number): RoofPiece[] {
  const slope = Math.tan((Math.max(0, Math.min(80, r.pitch)) * Math.PI) / 180);
  const { poly, parts } = footprintOf(r);
  if (r.shape === 'falda') {
    // un solo piano che sale dal lato più basso
    const b = bbox(poly);
    const dir = r.slopeTo ?? 'sud';
    const n = dir === 'sud' ? { x: 0, y: 1 } : dir === 'nord' ? { x: 0, y: -1 } : dir === 'est' ? { x: -1, y: 0 } : { x: 1, y: 0 };
    const c = dir === 'sud' ? b.minY : dir === 'nord' ? -b.maxY : dir === 'est' ? -b.maxX : b.minX;
    return [{ poly, ext: offsetPolygon(poly, eave), planes: [{ n, c, base, slope }] }];
  }
  return parts.map((part) => {
    const edges = part.map((a, i) => [a, part[(i + 1) % part.length]] as const);
    let eaves = edges;
    if (r.shape === 'falde') {
      // capanna: gronde sui lati paralleli al colmo
      const b = bbox(part);
      const alongX = r.ridge === 'x' ? true : r.ridge === 'y' ? false : b.w >= b.h;
      eaves = edges.filter(([a, c]) => (alongX ? Math.abs(a.y - c.y) < 1e-6 : Math.abs(a.x - c.x) < 1e-6));
    }
    return { poly: part, ext: offsetPolygon(part, eave), planes: eaves.map(([a, c]) => eavePlane(a, c, base, slope)) };
  });
}

// ───────── Ritaglio di poligoni convessi ─────────

/** Parte di poly dove k0 + k·q ≥ 0 */
export function clipHalf(poly: Vec2[], k: Vec2, k0: number): Vec2[] {
  const f = (q: Vec2) => k0 + k.x * q.x + k.y * q.y;
  const out: Vec2[] = [];
  poly.forEach((P, i) => {
    const Q = poly[(i + 1) % poly.length];
    const fp = f(P);
    const fq = f(Q);
    if (fp >= -1e-9) out.push(P);
    if ((fp >= -1e-9) !== (fq >= -1e-9)) {
      const t = fp / (fp - fq);
      out.push({ x: P.x + (Q.x - P.x) * t, y: P.y + (Q.y - P.y) * t });
    }
  });
  // vertici doppi (il taglio passa per un vertice): lati nulli confonderebbero i ritagli successivi
  const clean = out.filter((q, i) => {
    const prev = out[(i - 1 + out.length) % out.length];
    return i === 0 ? dist(q, out[out.length - 1]) > 1e-9 || out.length === 1 : dist(q, prev) > 1e-9;
  });
  return clean.length >= 3 && Math.abs(signedArea(clean)) > 1e-7 ? clean : [];
}

/** Semipiano dove il piano A sta sotto (o alla pari di) il piano B: U_B − U_A ≥ 0 */
function belowHalf(A: RoofPlane, B: RoofPlane): { k: Vec2; k0: number } {
  return {
    k: { x: B.slope * B.n.x - A.slope * A.n.x, y: B.slope * B.n.y - A.slope * A.n.y },
    k0: B.base - A.base - B.slope * B.c + A.slope * A.c,
  };
}

const coplanar = (A: RoofPlane, B: RoofPlane) => {
  const h = belowHalf(A, B);
  return Math.abs(h.k.x) < 1e-9 && Math.abs(h.k.y) < 1e-9 && Math.abs(h.k0) < 1e-9;
};

/** poly (convesso) meno il convesso K: unione di pezzi convessi */
export function subtractConvex(poly: Vec2[], K: Vec2[]): Vec2[][] {
  if (!K.length) return [poly];
  const k = ccw(K);
  const out: Vec2[][] = [];
  let rest = poly;
  for (let i = 0; i < k.length && rest.length; i++) {
    const A = k[i];
    const B = k[(i + 1) % k.length];
    if (dist(A, B) < 1e-9) continue;
    // interno di K a sinistra di A→B: (B−A)×(q−A) ≥ 0
    const kk = { x: -(B.y - A.y), y: B.x - A.x };
    const k0 = -(kk.x * A.x + kk.y * A.y);
    const outside = clipHalf(rest, { x: -kk.x, y: -kk.y }, -k0);
    if (outside.length) out.push(outside);
    rest = clipHalf(rest, kk, k0);
  }
  return out;
}

const onOrInside = (q: Vec2, poly: Vec2[]) => {
  if (pointInPolygon(q, poly)) return true;
  return poly.some((a, i) => {
    const b = poly[(i + 1) % poly.length];
    const l = dist(a, b) || 1;
    const t = Math.max(0, Math.min(1, ((q.x - a.x) * (b.x - a.x) + (q.y - a.y) * (b.y - a.y)) / (l * l)));
    return Math.hypot(q.x - a.x - (b.x - a.x) * t, q.y - a.y - (b.y - a.y) * t) < 1e-7;
  });
};

/** Falda più alta in q tra i pezzi dati (per ogni pezzo la più bassa delle sue falde) */
function topPlane(pieces: RoofPiece[], q: Vec2): { plane: RoofPlane; z: number } | null {
  let best: { plane: RoofPlane; z: number } | null = null;
  for (const pc of pieces) {
    if (!onOrInside(q, pc.ext) || !pc.planes.length) continue;
    let low: { plane: RoofPlane; z: number } | null = null;
    for (const pl of pc.planes) {
      const z = planeAt(pl, q);
      if (!low || z < low.z) low = { plane: pl, z };
    }
    if (low && (!best || low.z > best.z + 1e-9)) best = low;
  }
  return best;
}

// ───────── Geometria di tutte le coperture ─────────

/** Coperture a falde del progetto, con falde visibili e linee: una volta per progetto */
export function roofGeometries(p: Project): Map<string, RoofGeom> {
  return cached(p, 'roofs', () => {
    const roofs = p.elements.filter((e): e is Roof => e.kind === 'roof' && e.points.length >= 3);
    const info = roofs.map((r) => {
      const base = roofBase(p, r);
      const eave = roofEave(p, r);
      return { r, base, eave, pieces: r.shape === 'piana' ? [] : piecesOf(r, base, eave) };
    });
    const out = new Map<string, RoofGeom>();
    for (const it of info) {
      const th = byId(p.catalog.roof, it.r.typeId)?.thickness ?? 0.3;
      const slope = Math.tan((Math.max(0, Math.min(80, it.r.pitch)) * Math.PI) / 180);
      const outline = roofOutlineOf(it.r, it.eave);
      if (it.r.shape === 'piana') {
        out.set(it.r.id, { base: it.base, th, slope: 0, outline, pieces: [], fragments: [], lines: [], rise: 0, area: polygonArea(outline) });
        continue;
      }
      // pezzi delle coperture alla stessa imposta: si sommano tra loro
      const peers = info.filter((x) => x.r.shape !== 'piana' && Math.abs(x.base - it.base) < 0.05);
      const order = peers.flatMap((x) => x.pieces.map((pc) => ({ owner: x.r.id, pc })));
      const fragments: RoofFragment[] = [];
      it.pieces.forEach((pc) => {
        const myIndex = order.findIndex((o) => o.pc === pc);
        pc.planes.forEach((pl, k) => {
          // la falda vale dove è la più bassa del suo pezzo
          let poly = ccw(pc.ext);
          pc.planes.forEach((other, j) => {
            if (j === k || !poly.length) return;
            if (coplanar(pl, other)) {
              if (j < k) poly = [];
              return;
            }
            const h = belowHalf(pl, other);
            poly = clipHalf(poly, h.k, h.k0);
          });
          if (!poly.length) return;
          // e dove nessun altro pezzo è più alto
          let parts: Vec2[][] = [poly];
          order.forEach((o, oi) => {
            if (o.pc === pc || !parts.length) return;
            let K = ccw(o.pc.ext);
            for (const m of o.pc.planes) {
              if (!K.length) break;
              if (coplanar(m, pl)) {
                // alla pari: vale il pezzo che viene prima
                if (oi > myIndex) K = [];
                continue;
              }
              const h = belowHalf(pl, m); // U_m − U_pl ≥ 0: qui l'altro pezzo è più alto
              K = clipHalf(K, h.k, h.k0);
            }
            if (K.length) parts = parts.flatMap((x) => subtractConvex(x, K));
          });
          for (const x of parts) if (Math.abs(signedArea(x)) > 1e-5) fragments.push({ plane: pl, poly: x });
        });
      });
      // linee tra falde diverse: colmi, displuvi, compluvi
      const allPieces = order.map((o) => o.pc);
      const lines: RoofLine[] = [];
      const seen = new Set<string>();
      for (const fr of fragments) {
        const poly = ccw(fr.poly);
        poly.forEach((a, i) => {
          const b = poly[(i + 1) % poly.length];
          const L = dist(a, b);
          if (L < 1e-4) return;
          const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          const out = { x: (b.y - a.y) / L, y: -(b.x - a.x) / L }; // fuori dal frammento (a destra)
          const q = { x: m.x + out.x * 1e-3, y: m.y + out.y * 1e-3 };
          const other = topPlane(allPieces, q);
          if (!other || coplanar(other.plane, fr.plane)) return;
          const key = [a, b]
            .map((v) => `${v.x.toFixed(3)},${v.y.toFixed(3)}`)
            .sort()
            .join('|');
          if (seen.has(key)) return;
          seen.add(key);
          const convex = planeAt(fr.plane, q) > other.z + 1e-9;
          const flat = Math.abs(planeAt(fr.plane, a) - planeAt(fr.plane, b)) < 1e-3;
          lines.push({ a, b, kind: convex ? (flat ? 'colmo' : 'displuvio') : 'compluvio' });
        });
      }
      const merged = mergeLines(lines);
      let rise = 0;
      let area = 0;
      for (const fr of fragments) {
        for (const v of fr.poly) rise = Math.max(rise, planeAt(fr.plane, v) - it.base);
        area += Math.abs(signedArea(fr.poly)) * Math.sqrt(1 + fr.plane.slope ** 2);
      }
      out.set(it.r.id, { base: it.base, th, slope, outline, pieces: it.pieces, fragments, lines: merged, rise, area });
    }
    return out;
  });
}

/** Unisce i tratti allineati e sovrapposti della stessa specie (i frammenti spezzano le linee) */
function mergeLines(lines: RoofLine[]): RoofLine[] {
  const groups = new Map<string, { d: Vec2; o: Vec2; kind: RoofLineKind; iv: [number, number][] }>();
  for (const l of lines) {
    let d = { x: l.b.x - l.a.x, y: l.b.y - l.a.y };
    const L = Math.hypot(d.x, d.y) || 1;
    d = { x: d.x / L, y: d.y / L };
    if (d.x < -1e-9 || (Math.abs(d.x) < 1e-9 && d.y < 0)) d = { x: -d.x, y: -d.y };
    const off = l.a.x * -d.y + l.a.y * d.x;
    const key = `${l.kind}|${d.x.toFixed(4)},${d.y.toFixed(4)}|${off.toFixed(4)}`;
    const t0 = l.a.x * d.x + l.a.y * d.y;
    const t1 = l.b.x * d.x + l.b.y * d.y;
    const g = groups.get(key) ?? { d, o: { x: -d.y * off, y: d.x * off }, kind: l.kind, iv: [] };
    g.iv.push([Math.min(t0, t1), Math.max(t0, t1)]);
    groups.set(key, g);
  }
  const out: RoofLine[] = [];
  for (const g of groups.values()) {
    g.iv.sort((x, y) => x[0] - y[0]);
    let cur: [number, number] | null = null;
    const flush = () => cur && out.push({ a: add(g.o, mul(g.d, cur[0])), b: add(g.o, mul(g.d, cur[1])), kind: g.kind });
    for (const iv of g.iv) {
      if (cur && iv[0] <= cur[1] + 1e-6) cur[1] = Math.max(cur[1], iv[1]);
      else {
        flush();
        cur = [iv[0], iv[1]];
      }
    }
    flush();
  }
  return out;
}

export function roofGeom(p: Project, r: Roof): RoofGeom | undefined {
  return roofGeometries(p).get(r.id);
}

/** Quota dell'estradosso (manto) al punto più alto della copertura */
export function roofTop(p: Project, r: Roof): number {
  const g = roofGeom(p, r);
  return g ? g.base + g.rise + g.th : roofBase(p, r);
}

/**
 * Intradosso delle coperture impostate alla quota zTop nel punto X (sporto compreso), o null se
 * lì non c'è copertura. È la quota a cui salgono i muri sotto le falde (timpani).
 */
export function roofSurfaceAt(p: Project, X: Vec2, zTop: number): number | null {
  let best: number | null = null;
  const all = roofGeometries(p);
  const pieces: RoofPiece[] = [];
  for (const [, g] of all) {
    if (Math.abs(g.base - zTop) > 0.05) continue;
    if (!g.pieces.length) {
      if (onOrInside(X, g.outline)) best = best === null ? g.base : Math.max(best, g.base);
    } else pieces.push(...g.pieces);
  }
  const t = topPlane(pieces, X);
  if (t) best = best === null ? t.z : Math.max(best, t.z);
  return best;
}

/** Falde con la loro direzione di discesa e il frammento più grande (per le frecce di pendenza) */
export function roofSlopeArrows(g: RoofGeom): { at: Vec2; down: Vec2; size: number; slope: number }[] {
  const groups: { plane: RoofPlane; best: Vec2[]; area: number }[] = [];
  for (const fr of g.fragments) {
    const A = Math.abs(signedArea(fr.poly));
    const grp = groups.find((x) => coplanar(x.plane, fr.plane));
    if (!grp) groups.push({ plane: fr.plane, best: fr.poly, area: A });
    else if (A > polygonArea(grp.best)) grp.best = fr.poly;
  }
  return groups
    .filter((x) => x.plane.slope > 1e-6 && polygonArea(x.best) > 0.3)
    .map((x) => {
      const c = x.best.reduce((s, q) => ({ x: s.x + q.x / x.best.length, y: s.y + q.y / x.best.length }), { x: 0, y: 0 });
      return { at: c, down: { x: -x.plane.n.x, y: -x.plane.n.y }, size: Math.max(0.6, Math.min(2.5, Math.sqrt(polygonArea(x.best)) * 0.35)), slope: x.plane.slope };
    });
}

/** Quote d'imposta delle coperture del progetto (una per quota) */
export function roofBases(p: Project): number[] {
  return cached(p, 'roofBases', () => {
    const out: number[] = [];
    for (const g of roofGeometries(p).values()) if (!out.some((b) => Math.abs(b - g.base) < 0.05)) out.push(g.base);
    return out;
  });
}
