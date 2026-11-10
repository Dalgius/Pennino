// Trascinamenti nell'editor del modello: dato il progetto all'inizio del trascinamento e la
// posizione del cursore, calcolano dove va ciò che si trascina. Funzioni pure (niente stato
// dell'interfaccia), così il comportamento di agganci e ortogonale si può verificare con i test.

import type { BuildingElement, Project, Vec2 } from './types';
import { add, dist, dot, mul, norm, sub } from './geometry';
import { columnUnder, getHandles, setHandle, snapModel, snapPoint, translate, type Snap, type SnapCandidate, type SnapSegment } from './edit';

/** Agganci disponibili durante un trascinamento (fissati al suo inizio) e impostazioni di disegno */
export interface DragContext {
  candidates: SnapCandidate[];
  segments: SnapSegment[];
  /** raggio di aggancio (m) */
  tol: number;
  /** passo della griglia (m), 0 se spenta */
  grid: number;
  ortho: boolean;
  /** Alt premuto: niente aggancio agli oggetti */
  alt: boolean;
}

const onObject = (s: Snap | null): s is Snap => !!s && s.kind !== 'libero' && s.kind !== 'griglia';

/**
 * Lato di un solaio o di una copertura trascinato dal suo punto medio: si sposta parallelo a sé
 * stesso. Vicino a un oggetto il lato passa per il punto agganciato, altrimenti segue la griglia.
 */
export function dragEdge(orig: Project, id: string, edge: number, start: Vec2, world: Vec2, c: DragContext): { points: [number, Vec2][]; snap: Snap } | null {
  const el = orig.elements.find((x) => x.id === id);
  if (!el || (el.kind !== 'slab' && el.kind !== 'roof')) return null;
  const i = edge;
  const j = (i + 1) % el.points.length;
  const dE = norm(sub(el.points[j], el.points[i]));
  const nn = { x: -dE.y, y: dE.x };
  let off = dot(sub(world, start), nn);
  const sp = c.alt
    ? null
    : snapModel(world, {
        candidates: c.candidates.filter((k) => !el.points.some((q) => dist(q, k.p) < 1e-6)),
        segments: c.segments.filter((g) => g.id !== id),
        tol: c.tol,
        grid: 0,
        ortho: false,
      });
  if (onObject(sp)) off = dot(sub(sp.p, el.points[i]), nn);
  else if (c.grid > 0) off = Math.round(off / c.grid) * c.grid;
  return {
    points: [
      [i, add(el.points[i], mul(nn, off))],
      [j, add(el.points[j], mul(nn, off))],
    ],
    snap: onObject(sp) ? sp : { p: world, kind: 'libero' },
  };
}

/**
 * Maniglia di un elemento (estremo di muro, trave o scala; vertice di solaio o copertura).
 * Muri e travi si agganciano agli assi e ai pilastri (centro se il cursore è dentro, lato se è
 * vicino); i vertici dei solai anche a facce e spigoli. In ortogonale i segmenti restano allineati
 * all'altro estremo, i vertici alla posizione di partenza.
 */
export function dragHandle(orig: Project, id: string, handle: number, world: Vec2, c: DragContext & { columnLevels: string[] }): { snap: Snap; from: Vec2; element: BuildingElement } | null {
  const el = orig.elements.find((x) => x.id === id);
  if (!el || el.kind === 'opening') return null;
  const from = getHandles(el)[handle];
  if (!from) return null;
  const linear = el.kind === 'wall' || el.kind === 'beam' || el.kind === 'stair';
  const other = linear ? getHandles(el)[handle === 0 ? 1 : 0] : el.kind === 'slab' || el.kind === 'roof' ? from : undefined;
  const opts = {
    candidates: c.candidates.filter((k) => dist(k.p, from) > 1e-6 && !(linear && k.kind === 'spigolo')),
    // esclusi l'elemento trascinato e i muri che si muovono con il suo estremo
    segments: c.segments.filter((g) => g.id !== id && !(linear && g.face && !g.column) && dist(g.a, from) > 1e-6 && dist(g.b, from) > 1e-6),
    tol: c.tol,
    grid: c.grid,
    from: other,
    ortho: other ? c.ortho : false,
  };
  const onColumn = linear && !c.alt ? columnUnder(orig, c.columnLevels, world) : null;
  const snap = onColumn ?? (c.alt ? snapPoint(world, opts) : snapModel(world, opts));
  return { snap, from, element: el };
}

/** Applica alla bozza la nuova posizione della maniglia */
export function applyHandle(draft: Project, id: string, handle: number, p: Vec2) {
  const x = draft.elements.find((q) => q.id === id);
  if (x && x.kind !== 'opening') setHandle(x, handle, p);
}

/**
 * Spostamento di uno o più elementi presi nel punto start: il cursore si aggancia ai punti degli
 * altri elementi (non a quelli che si muovono); in ortogonale conta solo l'asse prevalente.
 */
export function dragMove(start: Vec2, world: Vec2, movingIds: string[], c: DragContext): Vec2 {
  const target = snapPoint(world, {
    // non i punti di ciò che si muove, né il punto di presa (agganciarlo darebbe uno spostamento nullo)
    candidates: c.alt ? [] : c.candidates.filter((k) => (!k.id || !movingIds.includes(k.id)) && dist(k.p, start) > 1e-6),
    tol: c.tol,
    grid: c.grid,
    ortho: false,
  }).p;
  const raw = sub(target, start);
  if (!c.ortho) return raw;
  return Math.abs(raw.x) >= Math.abs(raw.y) ? { x: raw.x, y: 0 } : { x: 0, y: raw.y };
}

/** Copia traslata di un elemento (l'originale non viene toccato) */
export function translated(src: BuildingElement, delta: Vec2): BuildingElement {
  const copy = JSON.parse(JSON.stringify(src)) as BuildingElement;
  if (copy.kind !== 'opening') translate(copy, delta);
  return copy;
}

/** Livello di un elemento del progetto */
export function elementLevel(p: Project, id: string): string | null {
  const e = p.elements.find((x) => x.id === id);
  return e && 'levelId' in e ? e.levelId : null;
}

/** Trascinando un estremo di un muro, segue anche l'estremo dei muri collegati */
export function moveJoined(d: Project, orig: Project, levelId: string, selfId: string, points: Vec2[], delta: Vec2) {
  for (const src of orig.elements) {
    if (src.kind !== 'wall' || src.id === selfId || src.levelId !== levelId) continue;
    const tgt = d.elements.find((x) => x.id === src.id);
    if (!tgt || tgt.kind !== 'wall') continue;
    for (const p of points) {
      if (dist(src.a, p) < 0.01) tgt.a = add(src.a, delta);
      if (dist(src.b, p) < 0.01) tgt.b = add(src.b, delta);
    }
  }
}
