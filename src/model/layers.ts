// Categorie di ciò che si disegna in pianta: ognuna può essere visibile, bloccata (si vede e ci si
// aggancia, ma non si seleziona) o nascosta.

import type { Annotation, BuildingElement, Project, Room, Vec2 } from './types';
import { cached } from './cache';
import { add, dist, mul, norm, projectOnSegment, sub } from './geometry';

export type LayerKey = 'muri' | 'solai' | 'strutture' | 'scale' | 'coperture' | 'locali' | 'annotazioni' | 'quote';
export type LayerMode = 'visibile' | 'bloccato' | 'nascosto';
export type Layers = Record<LayerKey, LayerMode>;

export const LAYER_LABEL: Record<LayerKey, string> = {
  muri: 'Muri e aperture',
  solai: 'Solai',
  strutture: 'Pilastri e travi',
  scale: 'Scale',
  coperture: 'Coperture',
  locali: 'Locali',
  annotazioni: 'Annotazioni',
  quote: 'Quote automatiche',
};
export const LAYER_KEYS = Object.keys(LAYER_LABEL) as LayerKey[];
export const ALL_VISIBLE: Layers = Object.fromEntries(LAYER_KEYS.map((k) => [k, 'visibile'])) as Layers;

export function layerOf(e: BuildingElement): LayerKey {
  switch (e.kind) {
    case 'wall':
    case 'opening':
      return 'muri';
    case 'slab':
      return 'solai';
    case 'column':
    case 'beam':
      return 'strutture';
    case 'stair':
      return 'scale';
    default:
      return 'coperture';
  }
}

/** Progetto senza le categorie indicate (elementi, locali, annotazioni) */
export function withoutLayers(p: Project, off: LayerKey[]): Project {
  if (!off.length) return p;
  const key = [...off].sort().join(',');
  return cached(p, `layers:${key}`, () => {
    const s = new Set(off);
    return Object.freeze({
      ...p,
      elements: p.elements.filter((e) => !s.has(layerOf(e))),
      rooms: s.has('locali') ? [] : p.rooms,
      annotations: s.has('annotazioni') ? [] : p.annotations,
    });
  });
}

export const layersWith = (l: Layers, modes: LayerMode[]) => LAYER_KEYS.filter((k) => modes.includes(l[k]));

/** Locale o annotazione sotto il cursore (i locali si prendono dalla loro etichetta) */
export function hitExtras(p: Project, levelId: string, w: Vec2, tol: number): string | null {
  for (const n of p.annotations ?? []) {
    if (n.levelId !== levelId) continue;
    if (n.kind === 'quota') {
      const d = norm(sub(n.b, n.a));
      const out = { x: -d.y, y: d.x };
      if (projectOnSegment(w, add(n.a, mul(out, n.offset)), add(n.b, mul(out, n.offset))).d < tol) return n.id;
    } else if (n.kind === 'testo') {
      // riquadro approssimato del testo: a destra e sotto il punto d'inserimento
      const lines = n.text.split('\n');
      const wide = Math.max(...lines.map((l) => l.length), 1) * tol * 0.55;
      if (w.x > n.p.x - tol && w.x < n.p.x + wide + tol && w.y < n.p.y + tol * 1.2 && w.y > n.p.y - lines.length * tol * 1.2) return n.id;
      if (n.leader && dist(w, n.leader) < tol) return n.id;
    } else if (dist(w, add(n.p, { x: tol, y: tol * 0.5 })) < tol * 1.8) return n.id;
  }
  for (const r of p.rooms ?? []) if (r.levelId === levelId && Math.abs(w.x - r.p.x) < tol * 3 && w.y < r.p.y + tol * 1.2 && w.y > r.p.y - tol * 1.6) return r.id;
  return null;
}

export const findRoom = (p: Project, id: string): Room | undefined => (p.rooms ?? []).find((r) => r.id === id);
export const findAnnotation = (p: Project, id: string): Annotation | undefined => (p.annotations ?? []).find((n) => n.id === id);

/** Sposta locali e annotazioni con gli id dati (sulla bozza) partendo dal progetto di origine */
export function translateExtras(d: Project, orig: Project, ids: string[], delta: Vec2) {
  for (const id of ids) {
    const r0 = findRoom(orig, id);
    const r = findRoom(d, id);
    if (r0 && r) r.p = add(r0.p, delta);
    const n0 = findAnnotation(orig, id);
    const n = findAnnotation(d, id);
    if (!n0 || !n) continue;
    if (n0.kind === 'quota' && n.kind === 'quota') {
      n.a = add(n0.a, delta);
      n.b = add(n0.b, delta);
    } else if (n0.kind === 'testo' && n.kind === 'testo') n.p = add(n0.p, delta);
    else if (n0.kind === 'altimetrica' && n.kind === 'altimetrica') n.p = add(n0.p, delta);
  }
}

/** Elimina locali e annotazioni con gli id dati (sulla bozza) */
export function deleteExtras(d: Project, ids: string[]) {
  if (d.rooms) d.rooms = d.rooms.filter((r) => !ids.includes(r.id));
  if (d.annotations) d.annotations = d.annotations.filter((n) => !ids.includes(n.id));
}

/** Elementi dello stesso tipo sul livello: stessa categoria e stessa tipologia */
export function similarElements(p: Project, id: string): string[] {
  const e = p.elements.find((x) => x.id === id);
  if (!e) return [];
  const level = (x: BuildingElement) => {
    if (x.kind !== 'opening') return x.levelId;
    const w = p.elements.find((q) => q.id === x.wallId);
    return w && w.kind === 'wall' ? w.levelId : null;
  };
  const type = (x: BuildingElement) => ('typeId' in x ? x.typeId : '');
  return p.elements.filter((x) => x.kind === e.kind && type(x) === type(e) && level(x) === level(e)).map((x) => x.id);
}
