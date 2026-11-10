// Vincoli tra elementi: i lati di solai e coperture che giacciono sull'asse di un muro
// seguono quel muro quando viene spostato, allungato o ruotato.
//
// Dopo ogni modifica si confronta il modello precedente con il nuovo: per ogni muro cambiato
// si cercano (nel modello precedente) i lati di solai e coperture appoggiati sul suo asse;
// i vertici vengono poi ricalcolati come intersezione dei lati adiacenti.

import { produce } from 'immer';
import type { Project, Vec2, Wall } from './types';
import { add, JOIN_TOL, dot, mul, norm, sortedLevels, sub } from './geometry';
import { fitWallOpenings } from './openingFit';

const TOL = JOIN_TOL;
const cross = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x;

interface Line {
  p: Vec2;
  d: Vec2;
}

function lineOf(a: Vec2, b: Vec2): Line {
  return { p: a, d: norm(sub(b, a)) };
}

const distToLine = (q: Vec2, l: Line) => Math.abs(cross(sub(q, l.p), l.d));

function intersect(l1: Line, l2: Line): Vec2 | null {
  const den = cross(l1.d, l2.d);
  if (Math.abs(den) < 1e-6) return null;
  const s = cross(sub(l2.p, l1.p), l2.d) / den;
  return add(l1.p, mul(l1.d, s));
}

/** Il lato a→b giace sull'asse del muro w (stessa retta, parallelo) */
function edgeOnWall(a: Vec2, b: Vec2, w: Wall) {
  const wl = lineOf(w.a, w.b);
  const ed = norm(sub(b, a));
  return Math.abs(cross(ed, wl.d)) < 0.01 && distToLine(a, wl) < TOL && distToLine(b, wl) < TOL;
}

/** Esito dei vincoli: il progetto risultante e, se la modifica è stata rifiutata, il motivo */
export interface Constrained {
  project: Project;
  refusal: string | null;
}

/**
 * Applica i vincoli a una modifica (prev → next): solai e coperture seguono i muri su cui poggiano;
 * porte e finestre restano intere dentro il tratto libero del loro muro. Se non ci stanno la
 * modifica è rifiutata: si restituisce prev con il motivo.
 */
export function constrain(prev: Project, next: Project): Constrained {
  const out = followWallsInner(prev, next);
  if (out === prev) return { project: out, refusal: null };
  const prevById = new Map(prev.elements.map((e) => [e.id, e]));
  // muri cambiati: le loro aperture si ridistribuiscono; aperture cambiate: solo riportate dentro
  const walls = new Set<string>();
  const hosts = new Set<string>();
  for (const e of out.elements) {
    if (e.kind === 'wall' && prevById.get(e.id) !== e) walls.add(e.id);
    if (e.kind === 'opening' && prevById.get(e.id) !== e) hosts.add(e.wallId);
  }
  if (!walls.size && !hosts.size) return { project: out, refusal: null };
  const fixes = new Map<string, number>();
  for (const id of new Set([...walls, ...hosts])) {
    const w = out.elements.find((e): e is Wall => e.kind === 'wall' && e.id === id);
    if (!w) continue;
    const fit = fitWallOpenings(out, w, { separate: walls.has(id) && !hosts.has(id) });
    if (!fit.ok) return { project: prev, refusal: fit.error };
    for (const [k, v] of fit.offsets) fixes.set(k, v);
  }
  if (!fixes.size) return { project: out, refusal: null };
  return {
    project: produce(out, (d) => {
      for (const e of d.elements) if (e.kind === 'opening' && fixes.has(e.id)) e.offset = fixes.get(e.id)!;
    }),
    refusal: null,
  };
}

/** Come constrain, restituendo solo il progetto */
export function followWalls(prev: Project, next: Project): Project {
  return constrain(prev, next).project;
}

function followWallsInner(prev: Project, next: Project): Project {
  if (prev === next) return next;
  // muri cambiati (stesso id, oggetto diverso)
  const prevById = new Map(prev.elements.map((e) => [e.id, e]));
  const changed = new Map<string, { before: Wall; after: Wall }>();
  for (const e of next.elements) {
    if (e.kind !== 'wall') continue;
    const before = prevById.get(e.id);
    if (before && before !== e && before.kind === 'wall') changed.set(e.id, { before, after: e });
  }
  if (!changed.size) return next;

  const levels = sortedLevels(next);
  const levelBelow = (id: string) => levels[levels.findIndex((l) => l.id === id) - 1]?.id;
  const updates = new Map<string, Vec2[]>();

  for (const e of next.elements) {
    if (e.kind !== 'slab' && e.kind !== 'roof') continue;
    const before = prevById.get(e.id);
    // se il solaio stesso è stato modificato in questa operazione, comanda l'utente
    if (before !== e || e.points.length < 3) continue;
    const below = levelBelow(e.levelId);
    if (![...changed.values()].some((c) => c.before.levelId === e.levelId || c.before.levelId === below)) continue;
    // muri di appoggio nel modello precedente: prima quelli dello stesso livello, poi quelli sotto
    const same = prev.elements.filter((w): w is Wall => w.kind === 'wall' && w.levelId === e.levelId);
    const under = prev.elements.filter((w): w is Wall => w.kind === 'wall' && w.levelId === below);
    const pts = e.points;
    const n = pts.length;
    // retta di ogni lato: quella del muro ospite aggiornato, oppure quella originale
    let hosted = false;
    const lines: { line: Line; hosted: boolean }[] = [];
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      const host = same.find((w) => edgeOnWall(a, b, w)) ?? under.find((w) => edgeOnWall(a, b, w));
      const moved = host && changed.get(host.id);
      if (moved) {
        hosted = true;
        lines.push({ line: lineOf(moved.after.a, moved.after.b), hosted: true });
      } else lines.push({ line: lineOf(a, b), hosted: false });
    }
    if (!hosted) continue;
    const out = pts.map((v, i) => {
      const l0 = lines[(i - 1 + n) % n];
      const l1 = lines[i];
      if (!l0.hosted && !l1.hosted) return v;
      const x = intersect(l0.line, l1.line);
      if (x) return { x: +x.x.toFixed(4), y: +x.y.toFixed(4) };
      // lati paralleli: il vertice si sposta perpendicolarmente sulla retta ospite
      const h = l1.hosted ? l1.line : l0.line;
      const nrm = { x: -h.d.y, y: h.d.x };
      return add(v, mul(nrm, dot(sub(h.p, v), nrm)));
    });
    updates.set(e.id, out);
  }
  // aperture: se cambia un estremo del muro ospite restano dove sono (l'offset si misura
  // dall'inizio del muro, che altrimenti le trascinerebbe); se il muro trasla tutto, lo seguono
  const offsets = new Map<string, number>();
  for (const e of next.elements) {
    if (e.kind !== 'opening') continue;
    const c = changed.get(e.wallId);
    if (!c || prevById.get(e.id) !== e) continue;
    const { before, after } = c;
    const ma = sub(after.a, before.a);
    const mb = sub(after.b, before.b);
    if (Math.hypot(ma.x - mb.x, ma.y - mb.y) < 1e-6) continue;
    const dB = norm(sub(before.b, before.a));
    const dA = norm(sub(after.b, after.a));
    const La = Math.hypot(after.b.x - after.a.x, after.b.y - after.a.y);
    const w = next.catalog.opening.find((t) => t.id === e.typeId)?.width ?? 0.8;
    const center = add(before.a, mul(dB, e.offset));
    let off = dot(sub(center, after.a), dA);
    off = La <= w ? La / 2 : Math.min(La - w / 2, Math.max(w / 2, off));
    if (Math.abs(off - e.offset) > 1e-6) offsets.set(e.id, +off.toFixed(4));
  }

  if (!updates.size && !offsets.size) return next;
  return produce(next, (d) => {
    for (const e of d.elements) {
      const u = updates.get(e.id);
      if (u && (e.kind === 'slab' || e.kind === 'roof')) e.points = u;
      const o = offsets.get(e.id);
      if (o !== undefined && e.kind === 'opening') e.offset = o;
    }
  });
}
