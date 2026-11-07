import type {
  BuildingElement,
  Column,
  ColumnType,
  Level,
  Opening,
  OpeningType,
  Project,
  Slab,
  Vec2,
  Wall,
  WallType,
} from './types';

export const v = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
export const len = (a: Vec2) => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
export const norm = (a: Vec2): Vec2 => {
  const l = len(a) || 1;
  return { x: a.x / l, y: a.y / l };
};
/** Normale sinistra */
export const perp = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x });
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const round = (n: number, step = 0.001) => Math.round(n / step) * step;

export function polygonArea(pts: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

export function polygonPerimeter(pts: Vec2[], closed = true): number {
  let s = 0;
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) s += dist(pts[i], pts[(i + 1) % pts.length]);
  return s;
}

export function centroid(pts: Vec2[]): Vec2 {
  if (!pts.length) return v(0, 0);
  const c = pts.reduce((acc, p) => add(acc, p), v(0, 0));
  return mul(c, 1 / pts.length);
}

export function bbox(pts: Vec2[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

export function pointInPolygon(p: Vec2, pts: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Proiezione di p sul segmento ab: parametro t in [0,1] e distanza */
export function projectOnSegment(p: Vec2, a: Vec2, b: Vec2) {
  const ab = sub(b, a);
  const l2 = dot(ab, ab) || 1e-9;
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
  const q = lerp(a, b, t);
  return { t, q, d: dist(p, q) };
}

export function distToPolyline(p: Vec2, pts: Vec2[], closed: boolean) {
  let best = Infinity;
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) best = Math.min(best, projectOnSegment(p, pts[i], pts[(i + 1) % pts.length]).d);
  return best;
}

// ───────────── Accessori sul modello ─────────────

export const byId = <T extends { id: string }>(list: T[], id: string | undefined) =>
  id ? list.find((x) => x.id === id) : undefined;

export function sortedLevels(p: Project): Level[] {
  return [...p.levels].sort((a, b) => a.elevation - b.elevation);
}

export function levelAbove(p: Project, levelId: string): Level | undefined {
  const ls = sortedLevels(p);
  const i = ls.findIndex((l) => l.id === levelId);
  return i >= 0 ? ls[i + 1] : undefined;
}

export const wallThickness = (t: WallType | undefined) => (t ? t.layers.reduce((s, l) => s + l.thickness, 0) : 0.3);

export function wallHeight(p: Project, w: Wall): number {
  if (w.height) return w.height;
  return byId(p.levels, w.levelId)?.height ?? 3;
}

export const wallLength = (w: { a: Vec2; b: Vec2 }) => dist(w.a, w.b);

export function wallOpenings(p: Project, wallId: string) {
  return p.elements.filter((e): e is Opening => e.kind === 'opening' && e.wallId === wallId);
}

export interface OpeningSpan {
  opening: Opening;
  type: OpeningType;
  start: number; // distanza da a
  end: number;
}

/** Aperture del muro ordinate lungo l'asse, con estremi limitati alla lunghezza del muro */
export function openingSpans(p: Project, w: Wall): OpeningSpan[] {
  const L = wallLength(w);
  const spans: OpeningSpan[] = [];
  for (const o of wallOpenings(p, w.id)) {
    const type = byId(p.catalog.opening, o.typeId);
    if (!type) continue;
    const start = Math.max(0, o.offset - type.width / 2);
    const end = Math.min(L, o.offset + type.width / 2);
    if (end > start) spans.push({ opening: o, type, start, end });
  }
  return spans.sort((a, b) => a.start - b.start);
}

/**
 * Estensioni alle estremità del muro per chiudere gli angoli con i muri collegati
 * (giunzione a L o a T sullo stesso livello).
 */
export function wallEndExtensions(p: Project, w: Wall): { a: number; b: number } {
  const tol = 0.02;
  let ea = 0;
  let eb = 0;
  const dir = norm(sub(w.b, w.a));
  for (const o of p.elements) {
    if (o.kind !== 'wall' || o.id === w.id || o.levelId !== w.levelId) continue;
    const oDir = norm(sub(o.b, o.a));
    if (Math.abs(dot(dir, oDir)) > 0.98) continue; // collineari: nessuna estensione
    const half = wallThickness(byId(p.catalog.wall, o.typeId)) / 2;
    const touches = (pt: Vec2) =>
      dist(pt, o.a) < tol || dist(pt, o.b) < tol || projectOnSegment(pt, o.a, o.b).d < tol;
    if (touches(w.a)) ea = Math.max(ea, half);
    if (touches(w.b)) eb = Math.max(eb, half);
  }
  return { a: ea, b: eb };
}

/** Rettangolo (4 vertici) di un tratto di muro tra le distanze s0 ed s1 da a */
export function wallSegmentQuad(w: Wall, thickness: number, s0: number, s1: number): Vec2[] {
  const d = norm(sub(w.b, w.a));
  const n = mul(perp(d), thickness / 2);
  const p0 = add(w.a, mul(d, s0));
  const p1 = add(w.a, mul(d, s1));
  return [add(p0, n), add(p1, n), sub(p1, n), sub(p0, n)];
}

export function columnQuad(c: Column, t: ColumnType | undefined): Vec2[] {
  const w = (t?.width ?? 0.3) / 2;
  const d = (t?.depth ?? 0.3) / 2;
  return [v(c.p.x - w, c.p.y - d), v(c.p.x + w, c.p.y - d), v(c.p.x + w, c.p.y + d), v(c.p.x - w, c.p.y + d)];
}

/** Impronta dell'edificio a un dato livello (vertici di muri, solai e pilastri) */
export function footprintPoints(p: Project, levelId?: string): Vec2[] {
  const pts: Vec2[] = [];
  for (const e of p.elements) {
    if (levelId && 'levelId' in e && e.levelId !== levelId) continue;
    if (e.kind === 'wall') {
      const t = wallThickness(byId(p.catalog.wall, e.typeId));
      pts.push(...wallSegmentQuad(e, t, 0, wallLength(e)));
    } else if (e.kind === 'slab' || e.kind === 'roof') pts.push(...e.points);
    else if (e.kind === 'column') pts.push(e.p);
  }
  return pts;
}

/** Contorno convesso (monotone chain) */
export function convexHull(points: Vec2[]): Vec2[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Vec2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/** Quota massima dell'edificio (estradosso copertura o ultimo livello) */
export function buildingHeight(p: Project): number {
  let top = 0;
  for (const e of p.elements) {
    const lvl = 'levelId' in e ? byId(p.levels, e.levelId) : undefined;
    if (!lvl) continue;
    if (e.kind === 'wall') top = Math.max(top, lvl.elevation + wallHeight(p, e));
    if (e.kind === 'roof') {
      const t = byId(p.catalog.roof, e.typeId)?.thickness ?? 0.3;
      top = Math.max(top, lvl.elevation + lvl.height + t + (e.shape === 'falde' ? roofRidgeRise(e.points, e.pitch) : 0));
    }
    if (e.kind === 'slab') top = Math.max(top, lvl.elevation);
  }
  return top;
}

/** Quota d'imposta di una copertura: piano del livello su cui poggia */
export function roofBase(p: Project, r: { levelId: string }) {
  const lvl = byId(p.levels, r.levelId);
  return (lvl?.elevation ?? 0) + (lvl?.height ?? 0);
}

/**
 * Intradosso delle coperture sopra il punto X, per i muri che vi arrivano (timpani):
 * solo coperture impostate alla quota `zTop` (cima del muro), entro 5 cm.
 */
/**
 * Profilo della sommità di un muro sotto le falde (timpano), tra s0 e s1 lungo l'asse:
 * campioni {s, z} dove z è l'intradosso della copertura, o la cima del muro se non c'è tetto sopra.
 * Restituisce null se il muro non sale da nessuna parte.
 */
export function wallTopProfile(p: Project, w: Wall, zTop: number, s0: number, s1: number) {
  const L = wallLength(w) || 1;
  const d = { x: (w.b.x - w.a.x) / L, y: (w.b.y - w.a.y) / L };
  const n = 48;
  const out: { s: number; z: number }[] = [];
  let rises = false;
  for (let i = 0; i <= n; i++) {
    const s = s0 + ((s1 - s0) * i) / n;
    const z = roofUndersideAt(p, { x: w.a.x + d.x * s, y: w.a.y + d.y * s }, zTop) ?? zTop;
    if (z > zTop + 1e-3) rises = true;
    out.push({ s, z: Math.max(zTop, z) });
  }
  if (!rises) return null;
  // toglie i punti allineati
  return out.filter((q, i) => {
    if (i === 0 || i === out.length - 1) return true;
    const a = out[i - 1];
    const b = out[i + 1];
    return Math.abs((q.z - a.z) * (b.s - a.s) - (b.z - a.z) * (q.s - a.s)) > 1e-6;
  });
}

export function roofUndersideAt(p: Project, X: Vec2, zTop: number): number | null {
  let best: number | null = null;
  for (const e of p.elements) {
    if (e.kind !== 'roof' || e.points.length < 3) continue;
    const base = roofBase(p, e);
    if (Math.abs(base - zTop) > 0.05) continue;
    const b = bbox(e.points);
    // l'ingombro comprende lo sporto: i muri sotto la gronda vi rientrano per tutto lo spessore
    const m = e.overhang + 1e-3;
    if (X.x < b.minX - m || X.x > b.maxX + m || X.y < b.minY - m || X.y > b.maxY + m) continue;
    let z = base;
    if (e.shape === 'falde') {
      const alongX = b.w >= b.h;
      const half = (alongX ? b.h : b.w) / 2;
      const rise = roofRidgeRise(e.points, e.pitch);
      const across = alongX ? X.y - (b.minY + b.h / 2) : X.x - (b.minX + b.w / 2);
      z = base + rise - (rise / (half || 1)) * Math.abs(across);
    }
    best = best === null ? z : Math.max(best, z);
  }
  return best;
}

/**
 * Poligono scostato verso l'esterno di «d» con spigoli vivi (raccordo a spigolo tra lati adiacenti).
 * Per un rettangolo l'area vale A + P·d + 4·d².
 */
export function offsetPolygon(points: Vec2[], d: number | number[]): Vec2[] {
  const n = points.length;
  const dd = (i: number) => (Array.isArray(d) ? d[i] ?? 0 : d);
  if (n < 3 || (!Array.isArray(d) && Math.abs(d) < 1e-9)) return points;
  // orientamento: antiorario → normale esterna a destra del lato
  let s = 0;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    s += a.x * b.y - b.x * a.y;
  }
  const sign = s >= 0 ? 1 : -1;
  const lines = points.map((a, i) => {
    const b = points[(i + 1) % n];
    const dir = norm(sub(b, a));
    const out = { x: dir.y * sign, y: -dir.x * sign };
    return { p: add(a, mul(out, dd(i))), dir };
  });
  return points.map((_v, i) => {
    const l0 = lines[(i - 1 + n) % n];
    const l1 = lines[i];
    const den = l0.dir.x * l1.dir.y - l0.dir.y * l1.dir.x;
    if (Math.abs(den) < 1e-9) return l1.p; // lati allineati
    const t = ((l1.p.x - l0.p.x) * l1.dir.y - (l1.p.y - l0.p.y) * l1.dir.x) / den;
    return add(l0.p, mul(l0.dir, t));
  });
}

/** Contorno in pianta di una copertura comprensivo dello sporto di gronda */
export function roofOutline(r: { points: Vec2[]; shape: 'piana' | 'falde'; overhang: number }): Vec2[] {
  if (r.shape === 'piana') return offsetPolygon(r.points, r.overhang);
  const b = bbox(r.points);
  const o = r.overhang;
  return [
    { x: b.minX - o, y: b.minY - o },
    { x: b.maxX + o, y: b.minY - o },
    { x: b.maxX + o, y: b.maxY + o },
    { x: b.minX - o, y: b.maxY + o },
  ];
}

export function roofRidgeRise(points: Vec2[], pitch: number) {
  const b = bbox(points);
  const half = Math.min(b.w, b.h) / 2;
  return Math.tan((pitch * Math.PI) / 180) * half;
}

export function elementLabel(e: BuildingElement): string {
  switch (e.kind) {
    case 'wall':
      return 'Muro';
    case 'opening':
      return 'Apertura';
    case 'slab':
      return 'Solaio';
    case 'column':
      return 'Pilastro';
    case 'beam':
      return 'Trave';
    case 'stair':
      return 'Scala';
    case 'roof':
      return 'Copertura';
  }
}

/** Codice breve leggibile, es. M-03 */
export function elementCode(p: Project, e: BuildingElement): string {
  const prefix: Record<string, string> = {
    wall: 'M',
    slab: 'S',
    column: 'P',
    beam: 'T',
    stair: 'SC',
    roof: 'C',
  };
  if (e.kind === 'opening') {
    const t = byId(p.catalog.opening, e.typeId);
    const same = p.elements.filter(
      (x) => x.kind === 'opening' && byId(p.catalog.opening, x.typeId)?.category === t?.category,
    );
    return `${t?.category === 'porta' ? 'PO' : 'FI'}-${String(same.indexOf(e) + 1).padStart(2, '0')}`;
  }
  const same = p.elements.filter((x) => x.kind === e.kind);
  return `${prefix[e.kind]}-${String(same.indexOf(e) + 1).padStart(2, '0')}`;
}

// ───────────── Sole ─────────────

/** Posizione solare approssimata (azimut da nord in senso orario, altezza) in gradi */
export function sunPosition(lat: number, lon: number, month: number, day: number, hour: number) {
  const rad = Math.PI / 180;
  const n = Math.floor(275 * month / 9) - 2 * Math.floor((month + 9) / 12) + day - 30;
  const decl = 23.44 * Math.sin(rad * (360 / 365) * (n - 81));
  // Ora solare: correzione semplificata rispetto al fuso CET (15°E)
  const B = rad * (360 / 365) * (n - 81);
  const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);
  const solarTime = hour + (4 * (lon - 15) + eot) / 60;
  const ha = 15 * (solarTime - 12);
  const sinAlt =
    Math.sin(lat * rad) * Math.sin(decl * rad) + Math.cos(lat * rad) * Math.cos(decl * rad) * Math.cos(ha * rad);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  const cosAz =
    (Math.sin(decl * rad) - Math.sin(alt) * Math.sin(lat * rad)) / (Math.cos(alt) * Math.cos(lat * rad) || 1e-9);
  let az = Math.acos(Math.max(-1, Math.min(1, cosAz))) / rad;
  if (ha > 0) az = 360 - az;
  return { azimuth: az, altitude: alt / rad };
}

// ───────────── Formattazione ─────────────

export const fmt = (n: number, digits = 2) =>
  n.toLocaleString('it-IT', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const fmtLevel = (n: number) => (n === 0 ? '±0.00' : `${n > 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}`);

export const fmtEuro = (n: number) =>
  n.toLocaleString('it-IT', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 });

export const uid = (prefix = 'e') => `${prefix}_${Math.random().toString(36).slice(2, 9)}`;

/** Ingombro del modello (per inquadrare viste 3D e assonometrie) */
export function sceneBounds(p: Project) {
  const pts: Vec2[] = [];
  for (const e of p.elements) {
    if (e.kind === 'wall' || e.kind === 'beam' || e.kind === 'stair') pts.push(e.a, e.b);
    else if (e.kind === 'slab' || e.kind === 'roof') pts.push(...e.points);
    else if (e.kind === 'column') pts.push(e.p);
  }
  const b = pts.length ? bbox(pts) : { minX: -5, minY: -5, maxX: 5, maxY: 5, w: 10, h: 10 };
  const top = Math.max(3, ...p.levels.map((l) => l.elevation + l.height)) + 2;
  return { ...b, top, cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2 };
}


/**
 * Ingombro reale di un solaio. I vertici si disegnano sugli assi dei muri; i lati appoggiati
 * a un muro (dello stesso livello o di quello sotto) si spostano secondo slab.edge.
 */
export function slabOutline(
  p: Project,
  s: { levelId: string; points: Vec2[]; edge?: 'auto' | 'asse' | 'interno' | 'esterno' | 'distanza'; edgeOffset?: number },
): Vec2[] {
  const pts = s.points;
  const mode = s.edge ?? 'auto';
  if (pts.length < 3 || mode === 'asse') return pts;
  const levels = sortedLevels(p);
  const li = levels.findIndex((l) => l.id === s.levelId);
  const lowest = li === 0;
  if (mode === 'auto' && !lowest) return pts;
  const sameLevel = p.elements.filter((e): e is Wall => e.kind === 'wall' && e.levelId === s.levelId);
  const below = li > 0 ? p.elements.filter((e): e is Wall => e.kind === 'wall' && e.levelId === levels[li - 1].id) : [];
  if (!sameLevel.length && !below.length) return pts;
  // verso esterno dei lati (come in offsetPolygon) e centro dell'edificio
  let area2 = 0;
  pts.forEach((a, i) => {
    const b = pts[(i + 1) % pts.length];
    area2 += a.x * b.y - b.x * a.y;
  });
  const sign = area2 >= 0 ? 1 : -1;
  const ends = (sameLevel.length ? sameLevel : below).flatMap((w) => [w.a, w.b]);
  const center = { x: ends.reduce((t, q) => t + q.x, 0) / ends.length, y: ends.reduce((t, q) => t + q.y, 0) / ends.length };
  /** metà spessore del muro su cui giace il lato a→b (0 se non appoggia a un muro) */
  const hostHalf = (a: Vec2, b: Vec2, walls: Wall[]) => {
    const ed = norm(sub(b, a));
    const L = dist(a, b);
    let best = 0;
    for (const w of walls) {
      const wd = norm(sub(w.b, w.a));
      if (Math.abs(ed.x * wd.y - ed.y * wd.x) > 0.01) continue;
      const off = (q: Vec2) => Math.abs((q.x - w.a.x) * wd.y - (q.y - w.a.y) * wd.x);
      if (off(a) > 0.02 || off(b) > 0.02) continue;
      const t = (q: Vec2) => (q.x - a.x) * ed.x + (q.y - a.y) * ed.y;
      const t0 = Math.min(t(w.a), t(w.b));
      const t1 = Math.max(t(w.a), t(w.b));
      if (Math.min(L, t1) - Math.max(0, t0) < 0.05) continue;
      best = Math.max(best, wallThickness(byId(p.catalog.wall, w.typeId)) / 2);
    }
    return best;
  };
  const ds = pts.map((a, i) => {
    const b = pts[(i + 1) % pts.length];
    const h = hostHalf(a, b, sameLevel) || hostHalf(a, b, below);
    if (!h) return 0;
    if (mode === 'auto') {
      // si allarga solo verso l'esterno dell'edificio (non una pavimentazione esterna addossata al muro)
      const ed = norm(sub(b, a));
      const out = { x: ed.y * sign, y: -ed.x * sign };
      return dot(out, sub({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, center)) > 0 ? h : 0;
    }
    if (mode === 'interno') return -h;
    if (mode === 'esterno') return h;
    return s.edgeOffset ?? 0;
  });
  return ds.some((d) => Math.abs(d) > 1e-9) ? offsetPolygon(pts, ds) : pts;
}

/** Area con segno (positiva se antioraria) */
function signedArea(pts: Vec2[]) {
  let s = 0;
  pts.forEach((a, i) => {
    const b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  });
  return s / 2;
}

/** Intersezione di un poligono qualsiasi con un poligono convesso (Sutherland–Hodgman) */
export function clipConvex(subject: Vec2[], clip: Vec2[]): Vec2[] {
  const c = signedArea(clip) >= 0 ? clip : [...clip].reverse();
  let out = subject;
  for (let i = 0; i < c.length && out.length; i++) {
    const A = c[i];
    const B = c[(i + 1) % c.length];
    const inside = (q: Vec2) => (B.x - A.x) * (q.y - A.y) - (B.y - A.y) * (q.x - A.x) >= -1e-9;
    const cut = (P: Vec2, Q: Vec2) => {
      const d1 = (B.x - A.x) * (P.y - A.y) - (B.y - A.y) * (P.x - A.x);
      const d2 = (B.x - A.x) * (Q.y - A.y) - (B.y - A.y) * (Q.x - A.x);
      const t = d1 / (d1 - d2);
      return { x: P.x + (Q.x - P.x) * t, y: P.y + (Q.y - P.y) * t };
    };
    const inp = out;
    out = [];
    inp.forEach((P, k) => {
      const Q = inp[(k + 1) % inp.length];
      const pin = inside(P);
      const qin = inside(Q);
      if (pin) out.push(P);
      if (pin !== qin) out.push(cut(P, Q));
    });
  }
  return out;
}

export const DEFAULT_HEADROOM = 2.1;

/**
 * Fori scala nel solaio: per ogni scala che arriva al livello del solaio, il tratto di rampa in cui
 * l'altezza libera sotto l'intradosso scende sotto il minimo, largo quanto la rampa e fino all'arrivo.
 * Restituisce i fori già ritagliati sull'ingombro del solaio.
 */
export function slabHoles(p: Project, s: { levelId: string; typeId: string; points: Vec2[]; edge?: Slab['edge']; edgeOffset?: number }): Vec2[][] {
  const outline = slabOutline(p, s);
  if (outline.length < 3) return [];
  const th = byId(p.catalog.slab, s.typeId)?.thickness ?? 0.3;
  const out: Vec2[][] = [];
  for (const e of p.elements) {
    if (e.kind !== 'stair' || e.hole === false) continue;
    const next = levelAbove(p, e.levelId);
    const lvl = byId(p.levels, e.levelId);
    if (!next || !lvl || next.id !== s.levelId) continue;
    if (dist(e.a, e.b) < 1e-6 || next.elevation - lvl.elevation <= 0) continue;
    const under = next.elevation - th;
    const whole = stairHole(p, e, under);
    // foro tutto dentro il solaio: si usa così com'è; altrimenti si ritaglia ogni rettangolo sul solaio
    const inside = whole.every((h) => h.every((q) => pointInPolygon(q, outline) || distToPolyline(q, outline, true) < 1e-6));
    const pieces = inside ? whole : stairHoleParts(p, e, under).map((r) => clipConvex(outline, r));
    for (const h of pieces) if (h.length >= 3 && Math.abs(signedArea(h)) > 1e-3) out.push(h);
  }
  return out;
}

/** Superficie netta del solaio (ingombro meno i fori scala) */
export function slabNetArea(p: Project, s: Parameters<typeof slabHoles>[1]) {
  return polygonArea(slabOutline(p, s)) - slabHoles(p, s).reduce((t, h) => t + polygonArea(h), 0);
}

/** Alzata massima usata quando il numero di alzate non è fissato */
export const MAX_RISER = 0.18;

type StairLike = {
  levelId: string;
  a: Vec2;
  b: Vec2;
  width: number;
  risers?: number;
  shape?: 'dritta' | 'L' | 'U';
  turn?: 'sinistra' | 'destra';
  firstRisers?: number;
  gap?: number;
};

/** Alzate della prima rampa (pianerottolo compreso) di una scala a L o a U */
export function stairFirstRisers(s: StairLike, n: number) {
  const k = s.firstRisers ?? Math.ceil(n / 2);
  return Math.max(2, Math.min(n - 1, Math.round(k)));
}

/** Dislivello, numero di alzate, alzata e pedata di una scala */
export function stairSteps(p: Project, s: StairLike) {
  const lvl = byId(p.levels, s.levelId);
  const next = levelAbove(p, s.levelId);
  const rise = next && lvl ? next.elevation - lvl.elevation : lvl?.height ?? 3;
  const n = s.risers && s.risers >= 2 ? Math.round(s.risers) : Math.max(2, Math.ceil(rise / MAX_RISER - 1e-9));
  const L = dist(s.a, s.b);
  const shape = s.shape ?? 'dritta';
  // dritta: a→b contiene n pedate; a L/U: a→b contiene le pedate della prima rampa fino al pianerottolo
  const k1 = shape === 'dritta' ? n : stairFirstRisers(s, n);
  const tread = shape === 'dritta' ? L / n : L / (k1 - 1);
  return { rise, n, h: rise / n, tread, L, k1, shape };
}

/** Lunghezza a→b che dà la pedata voluta con n alzate (e prima rampa k1 per L/U) */
export function stairAxisLength(s: StairLike, n: number, tread: number) {
  return (s.shape ?? 'dritta') === 'dritta' ? n * tread : (stairFirstRisers(s, n) - 1) * tread;
}

/** Una rampa: gradino j con fronte a j·tread dall'inizio e piano a base + (j+1)·h */
export interface StairFlight {
  a: Vec2;
  d: Vec2;
  /** normale a sinistra della direzione di salita */
  n: Vec2;
  len: number;
  steps: number;
  base: number;
  /** indice globale (da 0) del primo gradino della rampa */
  first: number;
}

export interface StairLanding {
  poly: Vec2[];
  z: number;
  /** indice globale del gradino che il pianerottolo rappresenta */
  step: number;
}

export interface StairLayout {
  flights: StairFlight[];
  landings: StairLanding[];
  h: number;
  tread: number;
  n: number;
  rise: number;
  width: number;
  /** linea d'asse per la freccia di salita */
  axis: Vec2[];
}

/** Geometria derivata di una scala: rampe e pianerottoli in pianta, con le quote */
export function stairLayout(p: Project, s: StairLike): StairLayout {
  const { rise, n, h, tread, k1, shape } = stairSteps(p, s);
  const z0 = byId(p.levels, s.levelId)?.elevation ?? 0;
  const W = s.width;
  const d = norm(sub(s.b, s.a));
  const nl = perp(d);
  const base = { h, tread, n, rise, width: W };
  if (shape === 'dritta') {
    const L = n * tread;
    return {
      ...base,
      flights: [{ a: s.a, d, n: nl, len: L, steps: n, base: z0, first: 0 }],
      landings: [],
      axis: [s.a, add(s.a, mul(d, L))],
    };
  }
  const sg = s.turn === 'destra' ? -1 : 1;
  const side = mul(nl, sg); // verso della seconda rampa
  const L1 = (k1 - 1) * tread;
  const k2 = n - k1;
  const f1: StairFlight = { a: s.a, d, n: nl, len: L1, steps: k1 - 1, base: z0, first: 0 };
  const zl = z0 + k1 * h;
  const b = add(s.a, mul(d, L1)); // bordo del pianerottolo sull'asse
  const P = (along: number, lat: number) => add(add(s.a, mul(d, along)), mul(side, lat));
  if (shape === 'L') {
    // pianerottolo quadrato; la seconda rampa parte dal suo lato
    const landing = [P(L1, -W / 2), P(L1 + W, -W / 2), P(L1 + W, W / 2), P(L1, W / 2)];
    const a2 = P(L1 + W / 2, W / 2);
    const f2: StairFlight = { a: a2, d: side, n: perp(side), len: k2 * tread, steps: k2, base: zl, first: k1 };
    const c = P(L1 + W / 2, 0);
    return { ...base, flights: [f1, f2], landings: [{ poly: landing, z: zl, step: k1 - 1 }], axis: [s.a, c, add(a2, mul(side, k2 * tread))] };
  }
  // U: pianerottolo su entrambe le rampe; la seconda torna indietro accanto alla prima
  const gap = Math.max(0, s.gap ?? 0.1);
  const off = W + gap;
  const landing = [P(L1, -W / 2), P(L1 + W, -W / 2), P(L1 + W, off + W / 2), P(L1, off + W / 2)];
  const a2 = P(L1, off);
  const back = mul(d, -1);
  const f2: StairFlight = { a: a2, d: back, n: perp(back), len: k2 * tread, steps: k2, base: zl, first: k1 };
  const c1 = P(L1 + W / 2, 0);
  const c2 = P(L1 + W / 2, off);
  void b;
  return { ...base, flights: [f1, f2], landings: [{ poly: landing, z: zl, step: k1 - 1 }], axis: [s.a, c1, c2, add(a2, mul(back, k2 * tread))] };
}

/** Rettangolo in pianta di una rampa (o di un suo tratto [s0, s1]) */
export function flightQuad(f: StairFlight, width: number, s0 = 0, s1 = f.len): Vec2[] {
  const m = mul(f.n, width / 2);
  const A = add(f.a, mul(f.d, s0));
  const B = add(f.a, mul(f.d, s1));
  return [add(A, m), add(B, m), sub(B, m), sub(A, m)];
}

/** Ingombro in pianta di una scala: rampe e pianerottoli */
export function stairFootprints(p: Project, s: StairLike): Vec2[][] {
  const lay = stairLayout(p, s);
  return [...lay.flights.map((f) => flightQuad(f, lay.width)), ...lay.landings.map((l) => l.poly)];
}

/**
 * Unione di rettangoli allineati a una terna (u, v): restituisce un unico contorno se l'unione è
 * connessa e senza buchi, altrimenti null.
 */
function unionAligned(rects: Vec2[][], o: Vec2, u: Vec2, v: Vec2): Vec2[] | null {
  const loc = (q: Vec2) => ({ x: dot(sub(q, o), u), y: dot(sub(q, o), v) });
  const boxes = rects.map((r) => {
    const l = r.map(loc);
    return { x0: Math.min(...l.map((q) => q.x)), x1: Math.max(...l.map((q) => q.x)), y0: Math.min(...l.map((q) => q.y)), y1: Math.max(...l.map((q) => q.y)) };
  });
  const uniq = (a: number[]) => [...new Set(a.map((x) => +x.toFixed(5)))].sort((p, q) => p - q);
  const xs = uniq(boxes.flatMap((b) => [b.x0, b.x1]));
  const ys = uniq(boxes.flatMap((b) => [b.y0, b.y1]));
  const inside = (i: number, j: number) => {
    if (i < 0 || j < 0 || i >= xs.length - 1 || j >= ys.length - 1) return false;
    const cx = (xs[i] + xs[i + 1]) / 2;
    const cy = (ys[j] + ys[j + 1]) / 2;
    return boxes.some((b) => cx > b.x0 && cx < b.x1 && cy > b.y0 && cy < b.y1);
  };
  // lati di confine orientati in senso antiorario
  const edges: [string, string][] = [];
  const key = (i: number, j: number) => `${i},${j}`;
  for (let i = 0; i < xs.length - 1; i++)
    for (let j = 0; j < ys.length - 1; j++) {
      if (!inside(i, j)) continue;
      if (!inside(i, j - 1)) edges.push([key(i, j), key(i + 1, j)]);
      if (!inside(i + 1, j)) edges.push([key(i + 1, j), key(i + 1, j + 1)]);
      if (!inside(i, j + 1)) edges.push([key(i + 1, j + 1), key(i, j + 1)]);
      if (!inside(i - 1, j)) edges.push([key(i, j + 1), key(i, j)]);
    }
  if (!edges.length) return null;
  const next = new Map<string, string>();
  for (const [a, b] of edges) {
    if (next.has(a)) return null; // contorno che si tocca in un vertice: si rinuncia
    next.set(a, b);
  }
  const start = edges[0][0];
  const loop: string[] = [start];
  let cur = next.get(start)!;
  while (cur !== start) {
    loop.push(cur);
    cur = next.get(cur)!;
    if (!cur || loop.length > edges.length) return null;
  }
  if (loop.length !== edges.length) return null; // più contorni
  const pts = loop.map((k) => {
    const [i, j] = k.split(',').map(Number);
    return { x: xs[i], y: ys[j] };
  });
  // vertici allineati
  const out = pts.filter((q, i) => {
    const a = pts[(i - 1 + pts.length) % pts.length];
    const b = pts[(i + 1) % pts.length];
    return Math.abs((q.x - a.x) * (b.y - q.y) - (q.y - a.y) * (b.x - q.x)) > 1e-9;
  });
  return out.map((q) => add(o, add(mul(u, q.x), mul(v, q.y))));
}

/** Parti della scala sotto cui l'altezza libera manca: rettangoli in pianta */
export function stairHoleParts(p: Project, s: StairLike & { headroom?: number }, underside: number): Vec2[][] {
  const lay = stairLayout(p, s);
  const H = (s as { headroom?: number }).headroom ?? DEFAULT_HEADROOM;
  const lim = underside - H;
  const parts: Vec2[][] = [];
  for (const f of lay.flights) {
    // piano del gradino j: base + (j+1)·h; serve il foro dal primo gradino che supera il limite
    const j0 = Math.max(0, Math.ceil((lim - f.base) / lay.h - 1 - 1e-9));
    if (j0 >= f.steps) continue;
    parts.push(flightQuad(f, lay.width, j0 * lay.tread, f.len));
  }
  for (const l of lay.landings) if (l.z > lim) parts.push(l.poly);
  return parts;
}

/** Foro scala (contorno unico se possibile) per un solaio di intradosso dato */
export function stairHole(p: Project, s: StairLike & { headroom?: number }, underside: number): Vec2[][] {
  const parts = stairHoleParts(p, s, underside);
  if (parts.length < 2) return parts;
  const d = norm(sub(s.b, s.a));
  const u = unionAligned(parts, s.a, d, perp(d));
  return u ? [u] : parts;
}
