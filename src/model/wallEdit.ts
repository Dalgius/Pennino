// Comandi di modifica da CAD: dividere, tagliare ed estendere i muri; spostare e copiare una
// selezione di un vettore. Le funzioni lavorano sulla bozza (d) e restituiscono un messaggio
// quando l'operazione non si può fare.

import type { Opening, Project, Vec2, Wall } from './types';
import { add, byId, dist, dot, mul, norm, sub, uid, wallLength } from './geometry';
import { copyElementsToLevel } from './edit';
import { translated, moveJoined } from './dragging';
import { translateExtras } from './layers';

const MIN_PIECE = 0.05; // tratto minimo di muro (m)

const wallOf = (p: Project, id: string) => p.elements.find((e): e is Wall => e.kind === 'wall' && e.id === id);
const openingsOf = (p: Project, wallId: string) => p.elements.filter((e): e is Opening => e.kind === 'opening' && e.wallId === wallId);
const pointAt = (w: Wall, s: number) => add(w.a, mul(norm(sub(w.b, w.a)), s));

/** Ascissa lungo l'asse del muro del punto q (proiezione) */
export function wallStation(w: Wall, q: Vec2): number {
  const L = wallLength(w) || 1;
  return Math.max(0, Math.min(L, dot(sub(q, w.a), norm(sub(w.b, w.a)))));
}

/** Aperture che il punto s del muro attraversa */
function openingAt(p: Project, w: Wall, s: number): Opening | undefined {
  return openingsOf(p, w.id).find((o) => {
    const t = byId(p.catalog.opening, o.typeId);
    return t && s > o.offset - t.width / 2 + 1e-6 && s < o.offset + t.width / 2 - 1e-6;
  });
}

/**
 * Divide il muro nel punto s: il primo tratto resta il muro di prima (stesso id), il secondo è un
 * muro nuovo con le aperture che gli appartengono. Le quote legate alla fine del muro passano al
 * tratto nuovo. Restituisce l'id del tratto nuovo o un messaggio.
 */
export function splitWall(d: Project, wallId: string, s: number): { id: string } | { error: string } {
  const w = wallOf(d, wallId);
  if (!w) return { error: 'Muro non trovato.' };
  const L = wallLength(w);
  if (s < MIN_PIECE || s > L - MIN_PIECE) return { error: 'Il punto è troppo vicino all’estremo del muro.' };
  if (openingAt(d, w, s)) return { error: 'Il punto cade dentro un’apertura: dividi il muro fuori dai vani.' };
  const q = pointAt(w, s);
  const nw: Wall = { ...JSON.parse(JSON.stringify(w)), id: uid('w'), a: q };
  w.b = { ...q };
  d.elements.push(nw);
  for (const o of openingsOf(d, wallId))
    if (o.offset > s) {
      o.wallId = nw.id;
      o.offset -= s;
    }
  // quote disegnate a mano legate alla fine del muro: ora è la fine del tratto nuovo
  for (const n of d.annotations ?? []) {
    if (n.kind !== 'quota') continue;
    for (const ref of [n.aRef, n.bRef]) if (ref && ref.k === 'muro' && ref.id === wallId && ref.end === 'b') ref.id = nw.id;
  }
  return { id: nw.id };
}

/** Intersezioni dell'asse del muro con gli assi degli altri muri del livello: ascisse lungo il muro */
export function wallCrossings(p: Project, w: Wall): number[] {
  const L = wallLength(w);
  const dir = norm(sub(w.b, w.a));
  const out: number[] = [];
  for (const o of p.elements) {
    if (o.kind !== 'wall' || o.id === w.id || o.levelId !== w.levelId) continue;
    const e = sub(o.b, o.a);
    const den = dir.x * e.y - dir.y * e.x;
    if (Math.abs(den) < 1e-9) continue; // paralleli
    const r = sub(o.a, w.a);
    const s = (r.x * e.y - r.y * e.x) / den;
    const t = (r.x * dir.y - r.y * dir.x) / den;
    if (t < -1e-6 || t > 1 + 1e-6) continue;
    if (s > 1e-6 && s < L - 1e-6) out.push(s);
  }
  return [...new Set(out.map((x) => +x.toFixed(6)))].sort((a, b) => a - b);
}

/** Tratto del muro tra le due intersezioni che racchiudono s (o gli estremi) */
export function trimPiece(p: Project, w: Wall, s: number): [number, number] | null {
  const xs = wallCrossings(p, w);
  if (!xs.length) return null;
  const L = wallLength(w);
  const cuts = [0, ...xs, L];
  for (let i = 0; i + 1 < cuts.length; i++) if (s >= cuts[i] && s <= cuts[i + 1]) return [cuts[i], cuts[i + 1]];
  return null;
}

/**
 * Taglia: toglie il tratto del muro su cui si è cliccato, tra i muri che lo attraversano. Un tratto
 * d'estremità accorcia il muro; un tratto interno lo divide in due. Le aperture del tratto tolto si
 * eliminano.
 */
export function trimWall(d: Project, wallId: string, s: number): { removed: number; openings: number } | { error: string } {
  const w = wallOf(d, wallId);
  if (!w) return { error: 'Muro non trovato.' };
  const piece = trimPiece(d, w, s);
  if (!piece) return { error: 'Nessun muro attraversa questo: non c’è un bordo a cui tagliarlo.' };
  const L = wallLength(w);
  const [s0, s1] = piece;
  if (s0 <= 1e-6 && s1 >= L - 1e-6) return { error: 'Il muro va tolto per intero: usa Elimina.' };
  // aperture nel tratto tolto
  const gone = openingsOf(d, wallId).filter((o) => {
    const t = byId(d.catalog.opening, o.typeId);
    const h = (t?.width ?? 0) / 2;
    return o.offset + h > s0 + 1e-6 && o.offset - h < s1 - 1e-6;
  });
  d.elements = d.elements.filter((e) => !gone.includes(e as Opening));
  if (s0 <= 1e-6) {
    // tratto iniziale: l'inizio del muro va all'intersezione
    const q = pointAt(w, s1);
    for (const o of openingsOf(d, wallId)) o.offset -= s1;
    w.a = q;
  } else if (s1 >= L - 1e-6) w.b = pointAt(w, s0);
  else {
    const q1 = pointAt(w, s1);
    const r = splitWall(d, wallId, s1);
    if ('error' in r) return r;
    const first = wallOf(d, wallId)!;
    first.b = pointAt(first, s0);
    const second = wallOf(d, r.id)!;
    second.a = q1;
  }
  return { removed: s1 - s0, openings: gone.length };
}

/**
 * Estendi: l'estremo del muro più vicino al punto q prosegue lungo l'asse fino all'asse del primo
 * muro che incontra. Restituisce la lunghezza aggiunta o un messaggio.
 */
export function extendWall(d: Project, wallId: string, q: Vec2): { added: number } | { error: string } {
  const w = wallOf(d, wallId);
  if (!w) return { error: 'Muro non trovato.' };
  const end: 'a' | 'b' = dist(q, w.a) <= dist(q, w.b) ? 'a' : 'b';
  const target = extendTarget(d, w, end);
  if (!target) return { error: 'Proseguendo, il muro non incontra altri muri.' };
  if (end === 'a') {
    const add0 = dist(w.a, target);
    for (const o of openingsOf(d, wallId)) o.offset += add0;
    w.a = target;
    return { added: add0 };
  }
  const added = dist(w.b, target);
  w.b = target;
  return { added };
}

/** Punto d'arrivo dell'estremo end prolungato: il primo asse di muro incontrato oltre l'estremo */
export function extendTarget(p: Project, w: Wall, end: 'a' | 'b'): Vec2 | null {
  const from = end === 'a' ? w.a : w.b;
  const dir = end === 'a' ? norm(sub(w.a, w.b)) : norm(sub(w.b, w.a));
  let best: { t: number; q: Vec2 } | null = null;
  for (const o of p.elements) {
    if (o.kind !== 'wall' || o.id === w.id || o.levelId !== w.levelId) continue;
    const e = sub(o.b, o.a);
    const den = dir.x * e.y - dir.y * e.x;
    if (Math.abs(den) < 1e-9) continue;
    const r = sub(o.a, from);
    const t = (r.x * e.y - r.y * e.x) / den;
    const u = (r.x * dir.y - r.y * dir.x) / den;
    if (u < -1e-6 || u > 1 + 1e-6 || t <= 1e-4) continue;
    if (!best || t < best.t) best = { t, q: add(from, mul(dir, t)) };
  }
  return best?.q ?? null;
}

/**
 * Sposta gli elementi di un vettore (sulla bozza, partendo dal progetto di origine). Un muro spostato
 * da solo si porta dietro gli estremi dei muri collegati, come trascinandolo.
 */
export function moveElements(d: Project, orig: Project, ids: string[], delta: Vec2) {
  for (const id of ids) {
    const src = orig.elements.find((q) => q.id === id);
    const x = d.elements.findIndex((q) => q.id === id);
    if (!src || x < 0 || src.kind === 'opening') continue;
    d.elements[x] = translated(src, delta);
    if (src.kind === 'wall' && ids.length === 1) moveJoined(d, orig, src.levelId, id, [src.a, src.b], delta);
  }
  translateExtras(d, orig, ids, delta);
}

/** Copie degli elementi spostate di un vettore, sullo stesso livello (con le aperture dei muri) */
export function copyElements(d: Project, ids: string[], levelId: string, delta: Vec2): string[] {
  const made = copyElementsToLevel(d, ids, levelId);
  const set = new Set(made);
  // anche le aperture copiate si spostano con il loro muro (stanno sull'ascissa del muro)
  for (const e of d.elements) if (set.has(e.id)) Object.assign(e, translated(e, delta));
  return made;
}
