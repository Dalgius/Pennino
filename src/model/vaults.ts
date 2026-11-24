// Volte a botte e a crociera su campi rettangolari. Geometria in coordinate locali del campo:
// a lungo il lato 0→1 (lunghezza L1), b lungo il lato 0→3 (lunghezza L2). L'intradosso parte
// dall'imposta e sale della freccia; gli archi sono archi di cerchio (a tutto sesto quando la
// freccia è metà della luce, ribassati se minore).

import type { Project, Vault, VaultShape, VaultType, Vec2 } from './types';
import { add, byId, dist, dot, mul, norm, sub } from './geometry';

export const VAULT_SHAPE_LABEL: Record<VaultShape, string> = { botte: 'Volta a botte', crociera: 'Volta a crociera' };

export interface VaultFrame {
  o: Vec2;
  e1: Vec2;
  e2: Vec2;
  L1: number;
  L2: number;
}

/** Sistema locale del campo: origine nel vertice 0, assi lungo i lati 0→1 e 0→3 */
export function vaultFrame(v: Pick<Vault, 'points'>): VaultFrame {
  const [p0, p1, , p3] = v.points;
  const e1 = norm(sub(p1, p0));
  // il secondo asse è perpendicolare al primo, dal lato del vertice 3
  let e2 = { x: -e1.y, y: e1.x };
  if (dot(e2, sub(p3, p0)) < 0) e2 = mul(e2, -1);
  return { o: p0, e1, e2, L1: dist(p0, p1), L2: Math.abs(dot(sub(p3, p0), e2)) };
}

export const vaultType = (p: Project, v: Vault): VaultType | undefined => byId(p.catalog.vault ?? [], v.typeId);
export const vaultThickness = (p: Project, v: Vault) => vaultType(p, v)?.thickness ?? 0.12;

/** Quota del piano del livello */
export const vaultFloor = (p: Project, v: Vault) => byId(p.levels, v.levelId)?.elevation ?? 0;

/** Altezza dell'arco di luce span e freccia f a distanza x dal centro (0 alle imposte, f in chiave) */
export function arcRise(x: number, span: number, f: number): number {
  const half = span / 2;
  if (f < 1e-6 || half < 1e-6) return 0;
  const ff = Math.min(f, half);
  const R = (half * half + ff * ff) / (2 * ff);
  const xx = Math.min(Math.abs(x), half);
  return Math.sqrt(Math.max(0, R * R - xx * xx)) - (R - ff);
}

/** Luce degli archi e loro direzione: per la botte il lato perpendicolare alle generatrici */
export function vaultSpans(v: Vault, fr = vaultFrame(v)) {
  const generatrix: 0 | 1 = v.axis ?? (fr.L1 >= fr.L2 ? 0 : 1);
  return { generatrix, span: generatrix === 0 ? fr.L2 : fr.L1 };
}

/** Freccia effettiva: mai oltre metà della luce più corta che la regge */
export function vaultRise(v: Vault, fr = vaultFrame(v)): number {
  const lim = v.shape === 'crociera' ? Math.min(fr.L1, fr.L2) / 2 : vaultSpans(v, fr).span / 2;
  return Math.max(0, Math.min(v.rise, lim));
}

/** Altezza dell'intradosso sopra l'imposta nel punto locale (a, b) del campo */
export function vaultHeightLocal(v: Vault, a: number, b: number, fr = vaultFrame(v)): number {
  const f = vaultRise(v, fr);
  if (v.shape === 'crociera') {
    // le due botti si compenetrano: l'arco del lato corto è di cerchio, quello del lato lungo lo
    // stesso arco stirato (ellittico), così i costoloni stanno sulle diagonali del campo
    const s = Math.min(fr.L1, fr.L2);
    return Math.max(arcRise(((b - fr.L2 / 2) * s) / fr.L2, s, f), arcRise(((a - fr.L1 / 2) * s) / fr.L1, s, f));
  }
  const across1 = arcRise(b - fr.L2 / 2, fr.L2, f); // arco sulla luce L2 (generatrici lungo e1)
  const across2 = arcRise(a - fr.L1 / 2, fr.L1, f); // arco sulla luce L1 (generatrici lungo e2)
  return vaultSpans(v, fr).generatrix === 0 ? across1 : across2;
}

/** Coordinate locali di un punto, o null se è fuori dal campo */
export function vaultLocal(v: Vault, q: Vec2, fr = vaultFrame(v), tol = 1e-9): { a: number; b: number } | null {
  const r = sub(q, fr.o);
  const a = dot(r, fr.e1);
  const b = dot(r, fr.e2);
  if (a < -tol || b < -tol || a > fr.L1 + tol || b > fr.L2 + tol) return null;
  return { a: Math.min(fr.L1, Math.max(0, a)), b: Math.min(fr.L2, Math.max(0, b)) };
}

/** Punto in pianta dalle coordinate locali */
export const vaultPoint = (fr: VaultFrame, a: number, b: number): Vec2 => add(add(fr.o, mul(fr.e1, a)), mul(fr.e2, b));

/** Quote assolute di imposta e chiave dell'intradosso */
export function vaultLevels(p: Project, v: Vault) {
  const zs = vaultFloor(p, v) + v.spring;
  const f = vaultRise(v);
  const th = vaultThickness(p, v);
  return { spring: zs, key: zs + f, top: zs + f + th, th, rise: f };
}

/** Quota dell'intradosso sopra il punto q, o null fuori dal campo */
export function vaultIntradosAt(p: Project, v: Vault, q: Vec2): number | null {
  const fr = vaultFrame(v);
  const l = vaultLocal(v, q, fr);
  if (!l) return null;
  return vaultFloor(p, v) + v.spring + vaultHeightLocal(v, l.a, l.b, fr);
}

/** Contorno del campo (rettangolo esatto ricostruito dal sistema locale) */
export function vaultOutline(v: Vault): Vec2[] {
  const fr = vaultFrame(v);
  return [vaultPoint(fr, 0, 0), vaultPoint(fr, fr.L1, 0), vaultPoint(fr, fr.L1, fr.L2), vaultPoint(fr, 0, fr.L2)];
}

/**
 * Linee caratteristiche della volta in 3D (x, y in pianta, z assoluta), per pianta e viste:
 * imposte, archi di testata, chiave (botte) o costoloni diagonali e archi sui lati (crociera).
 */
export function vaultEdges(p: Project, v: Vault, n = 24): { kind: 'imposta' | 'arco' | 'chiave' | 'unghia'; pts: { q: Vec2; z: number }[] }[] {
  const fr = vaultFrame(v);
  const z0 = vaultFloor(p, v) + v.spring;
  const P = (a: number, b: number) => ({ q: vaultPoint(fr, a, b), z: z0 + vaultHeightLocal(v, a, b, fr) });
  const line = (fn: (t: number) => [number, number]) => Array.from({ length: n + 1 }, (_, i) => P(...fn(i / n)));
  const out: ReturnType<typeof vaultEdges> = [];
  if (v.shape === 'crociera') {
    out.push({ kind: 'unghia', pts: line((t) => [t * fr.L1, t * fr.L2]) });
    out.push({ kind: 'unghia', pts: line((t) => [t * fr.L1, (1 - t) * fr.L2]) });
    // archi sui quattro lati (le lunette sui muri)
    out.push({ kind: 'arco', pts: line((t) => [t * fr.L1, 0]) }, { kind: 'arco', pts: line((t) => [t * fr.L1, fr.L2]) });
    out.push({ kind: 'arco', pts: line((t) => [0, t * fr.L2]) }, { kind: 'arco', pts: line((t) => [fr.L1, t * fr.L2]) });
    return out;
  }
  if (vaultSpans(v, fr).generatrix === 0) {
    out.push({ kind: 'imposta', pts: [P(0, 0), P(fr.L1, 0)] }, { kind: 'imposta', pts: [P(0, fr.L2), P(fr.L1, fr.L2)] });
    out.push({ kind: 'chiave', pts: [P(0, fr.L2 / 2), P(fr.L1, fr.L2 / 2)] });
    out.push({ kind: 'arco', pts: line((t) => [0, t * fr.L2]) }, { kind: 'arco', pts: line((t) => [fr.L1, t * fr.L2]) });
  } else {
    out.push({ kind: 'imposta', pts: [P(0, 0), P(0, fr.L2)] }, { kind: 'imposta', pts: [P(fr.L1, 0), P(fr.L1, fr.L2)] });
    out.push({ kind: 'chiave', pts: [P(fr.L1 / 2, 0), P(fr.L1 / 2, fr.L2)] });
    out.push({ kind: 'arco', pts: line((t) => [t * fr.L1, 0]) }, { kind: 'arco', pts: line((t) => [t * fr.L1, fr.L2]) });
  }
  return out;
}

/** Superficie d'intradosso (m², sviluppata) e volume del rinfianco fino all'estradosso in chiave (m³) */
export function vaultQuantities(p: Project, v: Vault, n = 64) {
  const fr = vaultFrame(v);
  const f = vaultRise(v, fr);
  // superficie: somma dei triangoli della griglia (converge anche dove l'intradosso è verticale)
  const node = (i: number, j: number) => {
    const a = (fr.L1 * i) / n;
    const b = (fr.L2 * j) / n;
    return [a, b, vaultHeightLocal(v, a, b, fr)];
  };
  const triArea = (P: number[], Q: number[], R: number[]) => {
    const u = [Q[0] - P[0], Q[1] - P[1], Q[2] - P[2]];
    const w = [R[0] - P[0], R[1] - P[1], R[2] - P[2]];
    return Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) / 2;
  };
  let area = 0;
  let fill = 0;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const A = node(i, j);
      const B = node(i + 1, j);
      const C = node(i + 1, j + 1);
      const D = node(i, j + 1);
      // diviso lungo la diagonale del campo più vicina, come nel modello 3D
      area += Math.abs(i - j) <= Math.abs(i + j - (n - 1)) ? triArea(A, B, C) + triArea(A, C, D) : triArea(A, B, D) + triArea(B, C, D);
      const a = (i + 0.5) * (fr.L1 / n);
      const b = (j + 0.5) * (fr.L2 / n);
      fill += (f - vaultHeightLocal(v, a, b, fr)) * (fr.L1 / n) * (fr.L2 / n);
    }
  const th = vaultThickness(p, v);
  return { plan: fr.L1 * fr.L2, area, fill, volume: area * th };
}

/** Proposta per una volta nuova su un campo: freccia e imposta con la chiave sotto il solaio sopra */
export function defaultVault(p: Project, levelId: string, points: Vec2[], shape: VaultShape, typeId: string): Pick<Vault, 'spring' | 'rise' | 'points' | 'shape'> {
  const fr = vaultFrame({ points });
  const lv = byId(p.levels, levelId);
  const H = lv?.height ?? 3;
  const th = byId(p.catalog.vault ?? [], typeId)?.thickness ?? 0.12;
  const span = shape === 'crociera' ? Math.min(fr.L1, fr.L2) : Math.min(fr.L1, fr.L2);
  // tutto sesto se ci sta con l'imposta ad almeno 2,20 m; altrimenti ribassata
  const room = H - th - 0.1; // chiave: spessore e 10 cm di riempimento sotto il solaio sopra
  const rise = Math.round(Math.max(0.1, Math.min(span / 2, room - 2.2)) * 100) / 100;
  return { points, shape, rise, spring: Math.round((room - rise) * 100) / 100 };
}
