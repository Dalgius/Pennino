// Geometria dei muri: lato esterno, giunzioni ad angolo (L) e a T, contorni per strati.
//
// Lungo un muro si misura con s (distanza dall'inizio a, verso b) e o (scostamento dall'asse
// lungo la normale sinistra n = perp(d)). Ogni estremità ha un taglio lineare t(o) = alpha + beta·o:
// la distanza, misurata verso l'interno del muro, a cui finisce il contorno allo scostamento o
// (negativa = il muro si allunga oltre il punto d'asse).

import type { Project, Vec2, Wall } from './types';
import { add, byId, centroid, dist, dot, mul, norm, perp, projectOnSegment, sub, wallLength, wallThickness } from './geometry';

export interface EndCut {
  alpha: number;
  beta: number;
  kind: 'libero' | 'angolo' | 'T' | 'continuo';
  /** Muro con cui si forma la giunzione */
  otherId?: string;
}

export interface WallGeom {
  wall: Wall;
  L: number;
  d: Vec2;
  n: Vec2;
  half: number;
  /** +1 se il primo strato (esterno) sta sul lato +n */
  extSign: 1 | -1;
  a: EndCut;
  b: EndCut;
}

const TOL = 0.02;
const cross = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x;
const free: EndCut = { alpha: 0, beta: 0, kind: 'libero' };

/** Intersezione delle rette p + u·s e q + v·r */
function intersect(p: Vec2, u: Vec2, q: Vec2, v: Vec2): Vec2 | null {
  const den = cross(u, v);
  if (Math.abs(den) < 1e-9) return null;
  const s = cross(sub(q, p), v) / den;
  return add(p, mul(u, s));
}

function levelWalls(p: Project, levelId: string) {
  return p.elements.filter((e): e is Wall => e.kind === 'wall' && e.levelId === levelId);
}

/** Centro dei muri del livello: serve a capire quale lato di un muro guarda fuori */
export function levelCenter(p: Project, levelId: string): Vec2 {
  const pts = levelWalls(p, levelId).flatMap((w) => [w.a, w.b]);
  return pts.length ? centroid(pts) : { x: 0, y: 0 };
}

export function exteriorSign(p: Project, w: Wall, center = levelCenter(p, w.levelId)): 1 | -1 {
  const n = perp(norm(sub(w.b, w.a)));
  const mid = centroid([w.a, w.b]);
  const outward: 1 | -1 = dot(n, sub(mid, center)) >= 0 ? 1 : -1;
  return (w.flip ? -outward : outward) as 1 | -1;
}

function endCut(p: Project, w: Wall, end: 'a' | 'b', walls: Wall[]): EndCut {
  const P = end === 'a' ? w.a : w.b;
  const d = norm(sub(w.b, w.a));
  const n = perp(d);
  const u = end === 'a' ? d : mul(d, -1); // verso l'interno del muro
  const h = wallThickness(byId(p.catalog.wall, w.typeId)) / 2;

  const atEnd: { wall: Wall; uO: Vec2 }[] = [];
  let host: Wall | null = null;
  for (const o of walls) {
    if (o.id === w.id) continue;
    if (dist(o.a, P) < TOL) atEnd.push({ wall: o, uO: norm(sub(o.b, o.a)) });
    else if (dist(o.b, P) < TOL) atEnd.push({ wall: o, uO: norm(sub(o.a, o.b)) });
    else {
      const pr = projectOnSegment(P, o.a, o.b);
      if (pr.d < TOL && pr.t > 1e-3 && pr.t < 1 - 1e-3) host = o;
    }
  }
  const collinear = atEnd.filter((x) => Math.abs(cross(d, x.uO)) < 0.2);
  const angled = atEnd.filter((x) => Math.abs(cross(d, x.uO)) >= 0.2);

  // Prosecuzione rettilinea: il muro continua, nessun taglio
  if (collinear.length) return { ...free, kind: 'continuo', otherId: collinear[0].wall.id };

  // Giunzione a T: il muro si ferma sulla faccia del muro passante
  const through = host ?? (angled.length >= 2 ? angled[0].wall : null);
  if (through) {
    const hB = wallThickness(byId(p.catalog.wall, through.typeId)) / 2;
    let nB = perp(norm(sub(through.b, through.a)));
    if (dot(u, nB) < 0) nB = mul(nB, -1);
    const du = dot(u, nB);
    if (Math.abs(du) < 1e-6) return free;
    return { alpha: hB / du, beta: -dot(n, nB) / du, kind: 'T', otherId: through.id };
  }

  // Giunzione ad angolo: taglio sulla retta che unisce spigolo interno ed esterno
  if (angled.length === 1) {
    const o = angled[0];
    const hB = wallThickness(byId(p.catalog.wall, o.wall.typeId)) / 2;
    const nB = perp(norm(sub(o.wall.b, o.wall.a)));
    const sideW = Math.sign(dot(n, o.uO)) || 1; // lato di w rivolto verso l'altro muro
    const sideB = Math.sign(dot(nB, u)) || 1; // lato dell'altro muro rivolto verso w
    const inner = intersect(add(P, mul(n, sideW * h)), u, add(P, mul(nB, sideB * hB)), o.uO);
    const outer = intersect(add(P, mul(n, -sideW * h)), u, add(P, mul(nB, -sideB * hB)), o.uO);
    if (!inner || !outer || h < 1e-6) return free;
    const tIn = dot(sub(inner, P), u);
    const tOut = dot(sub(outer, P), u);
    // t(o) lineare: o = sideW·h → tIn, o = −sideW·h → tOut
    const beta = (tIn - tOut) / (2 * sideW * h);
    const alpha = (tIn + tOut) / 2;
    return { alpha, beta, kind: 'angolo', otherId: o.wall.id };
  }
  return free;
}

export function wallGeom(p: Project, w: Wall, center?: Vec2): WallGeom {
  const walls = levelWalls(p, w.levelId);
  const d = norm(sub(w.b, w.a));
  return {
    wall: w,
    L: wallLength(w),
    d,
    n: perp(d),
    half: wallThickness(byId(p.catalog.wall, w.typeId)) / 2,
    extSign: exteriorSign(p, w, center),
    a: endCut(p, w, 'a', walls),
    b: endCut(p, w, 'b', walls),
  };
}

/** Posizione s lungo il muro dell'estremità iniziale/finale allo scostamento o */
export const startAt = (g: WallGeom, o: number) => g.a.alpha + g.a.beta * o;
export const endAt = (g: WallGeom, o: number) => g.L - (g.b.alpha + g.b.beta * o);

const pt = (g: WallGeom, s: number, o: number) => add(add(g.wall.a, mul(g.d, s)), mul(g.n, o));

/**
 * Contorno di una fascia del muro tra gli scostamenti o0 e o1 e tra s0 e s1.
 * 'inizio' e 'fine' applicano il taglio della giunzione.
 */
export function bandPolygon(g: WallGeom, o0: number, o1: number, s0: number | 'inizio', s1: number | 'fine'): Vec2[] {
  const sa = (o: number) => (s0 === 'inizio' ? startAt(g, o) : s0);
  const sb = (o: number) => (s1 === 'fine' ? endAt(g, o) : s1);
  return [pt(g, sa(o0), o0), pt(g, sb(o0), o0), pt(g, sb(o1), o1), pt(g, sa(o1), o1)];
}

/** Tratti pieni del muro (tra le aperture), con i tagli alle estremità */
export function wallPieces(g: WallGeom, spans: { start: number; end: number }[]) {
  const out: { s0: number | 'inizio'; s1: number | 'fine' }[] = [];
  let cur: number | 'inizio' = 'inizio';
  for (const sp of spans) {
    const curVal = cur === 'inizio' ? Math.min(startAt(g, g.half), startAt(g, -g.half)) : cur;
    if (sp.start > curVal + 1e-4) out.push({ s0: cur, s1: sp.start });
    cur = sp.end;
  }
  const curVal = cur === 'inizio' ? -Infinity : cur;
  if (Math.max(endAt(g, g.half), endAt(g, -g.half)) > curVal + 1e-4) out.push({ s0: cur, s1: 'fine' });
  return out;
}

/** Strati del tipo, dall'esterno all'interno, come intervalli di scostamento [oEst, oInt] */
export function layerBands(g: WallGeom, layers: { thickness: number }[]) {
  const total = layers.reduce((s, l) => s + l.thickness, 0) || 2 * g.half;
  let o = g.extSign * (total / 2);
  return layers.map((l) => {
    const o0 = o;
    o -= g.extSign * l.thickness;
    return { o0, o1: o };
  });
}

/** Contorno completo del muro (vista dall'alto, impronte) */
export function wallOutline(g: WallGeom) {
  return bandPolygon(g, g.half, -g.half, 'inizio', 'fine');
}

/** Posizione d'asse della faccia esterna/interna (per le quote) */
export function faceOffset(g: WallGeom, side: 'esterno' | 'interno') {
  return (side === 'esterno' ? g.extSign : -g.extSign) * g.half;
}
