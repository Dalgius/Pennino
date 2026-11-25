// Inquadratura delle assonometrie: direzione di vista e ingombro reale del modello proiettato sul
// piano dell'immagine (spaccato compreso). Lo usano il riquadro della tavola e il disegno 3D, così
// il riquadro è grande quanto il modello e l'immagine ci cade esattamente dentro.

import type { AxoCut, Project, Vec2 } from './types';
import { byId, norm, perp, sub } from './geometry';
import { getHandles } from './edit';
import { roofTop } from './roofs';

/** Vettore 3D nelle coordinate di three.js: (x, quota, −y) */
export type V3 = [number, number, number];

const unit = (v: V3): V3 => {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Direzione verso la telecamera: di norma da sud-ovest; con lo spaccato su una sezione dalla parte
 * tolta, di sbieco, così si vede la faccia tagliata
 */
export function axoDir(p: Project, cut?: AxoCut): V3 {
  const sec = cut?.kind === 'sezione' ? (p.sections ?? []).find((x) => x.id === cut.sectionId) : undefined;
  if (!sec) return unit([-1, 0.9, 1]);
  const a = sec.flip ? sec.b : sec.a;
  const b = sec.flip ? sec.a : sec.b;
  const u = norm(sub(b, a));
  const d = perp(u);
  const h = { x: -d.x - 0.75 * u.x, y: -d.y - 0.75 * u.y };
  return unit([h.x, 0.95, -h.y]);
}

/** Assi dell'immagine (destra e alto) per una direzione di vista, come li calcola lookAt di three.js */
export function axoBasis(dir: V3): { right: V3; up: V3 } {
  const right = unit(cross([0, 1, 0], dir));
  return { right, up: cross(dir, right) };
}

/** Punti dell'edificio (in coordinate three.js) che ne delimitano l'ingombro, tagliati dallo spaccato */
function modelPoints(p: Project, cut?: AxoCut): V3[] {
  const out: V3[] = [];
  const cutLevel = cut?.kind === 'piano' ? byId(p.levels, cut.levelId) : undefined;
  const zMax = cutLevel ? cutLevel.elevation + (cut as { height: number }).height : Infinity;
  const sec = cut?.kind === 'sezione' ? (p.sections ?? []).find((x) => x.id === cut.sectionId) : undefined;
  const a = sec ? (sec.flip ? sec.b : sec.a) : null;
  const d = sec && a ? perp(norm(sub(sec.flip ? sec.a : sec.b, a))) : null;
  // un punto davanti al piano della sezione si porta sul piano (lì il modello è tagliato)
  const onKept = (q: Vec2): Vec2 => {
    if (!d || !a) return q;
    const D = (q.x - a.x) * d.x + (q.y - a.y) * d.y;
    return D >= 0 ? q : { x: q.x - D * d.x, y: q.y - D * d.y };
  };
  for (const e of p.elements) {
    if (!('levelId' in e)) continue;
    const lv = byId(p.levels, e.levelId);
    if (!lv) continue;
    const z0 = e.kind === 'slab' ? lv.elevation - (byId(p.catalog.slab, e.typeId)?.thickness ?? 0.3) : lv.elevation;
    const z1 = e.kind === 'roof' ? roofTop(p, e) + 0.6 : e.kind === 'slab' ? lv.elevation : lv.elevation + lv.height;
    if (z0 > zMax) continue;
    for (const q0 of e.kind === 'roof' ? e.points.map((q) => q) : getHandles(e)) {
      const q = onKept(q0);
      for (const z of [z0, Math.min(z1, zMax)]) out.push([q.x, z, -q.y]);
    }
  }
  // le coperture sporgono oltre i vertici: un margine attorno a quelle in vista
  return out;
}

/**
 * Inquadratura dell'assonometria: direzione, assi, centro e semiampiezze (m) dell'ingombro proiettato,
 * con un margine. Se il modello è vuoto, un riquadro di 10 m.
 */
export function axoFraming(p: Project, cut?: AxoCut, margin = 0.8) {
  const dir = axoDir(p, cut);
  const { right, up } = axoBasis(dir);
  const pts = modelPoints(p, cut);
  if (!pts.length) return { dir, right, up, center: [0, 0, 0] as V3, halfW: 5, halfH: 5 };
  let r0 = Infinity;
  let r1 = -Infinity;
  let u0 = Infinity;
  let u1 = -Infinity;
  const c = pts.reduce<V3>((s, q) => [s[0] + q[0] / pts.length, s[1] + q[1] / pts.length, s[2] + q[2] / pts.length], [0, 0, 0]);
  for (const q of pts) {
    const v: V3 = [q[0] - c[0], q[1] - c[1], q[2] - c[2]];
    const r = dot3(v, right);
    const u = dot3(v, up);
    r0 = Math.min(r0, r);
    r1 = Math.max(r1, r);
    u0 = Math.min(u0, u);
    u1 = Math.max(u1, u);
  }
  // centro dell'immagine: c spostato al centro dell'intervallo lungo destra e alto
  const cr = (r0 + r1) / 2;
  const cu = (u0 + u1) / 2;
  const center: V3 = [c[0] + right[0] * cr + up[0] * cu, c[1] + right[1] * cr + up[1] * cu, c[2] + right[2] * cr + up[2] * cu];
  return { dir, right, up, center, halfW: (r1 - r0) / 2 + margin, halfH: (u1 - u0) / 2 + margin };
}

/** Riquadro dell'assonometria sul foglio (mm) alla scala data */
export function axoSheetSize(p: Project, scale: number, cut?: AxoCut) {
  const f = axoFraming(p, cut);
  const k = 1000 / scale;
  return { w: 2 * f.halfW * k, h: 2 * f.halfH * k };
}
