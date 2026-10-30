import type {
  BuildingElement,
  Column,
  ColumnType,
  Level,
  Opening,
  OpeningType,
  Project,
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
      top = Math.max(top, lvl.elevation + t + (e.shape === 'falde' ? roofRidgeRise(e.points, e.pitch) : 0));
    }
    if (e.kind === 'slab') top = Math.max(top, lvl.elevation);
  }
  return top;
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
