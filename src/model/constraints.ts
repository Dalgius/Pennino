// Vincoli tra elementi: i lati di solai e coperture che giacciono sull'asse di un muro
// seguono quel muro quando viene spostato, allungato o ruotato.
//
// Dopo ogni modifica si confronta il modello precedente con il nuovo: per ogni muro cambiato
// si cercano (nel modello precedente) i lati di solai e coperture appoggiati sul suo asse;
// i vertici vengono poi ricalcolati come intersezione dei lati adiacenti.

import { produce } from 'immer';
import type { Project, Vec2, Wall } from './types';
import { add, byId, JOIN_TOL, dot, mul, norm, sortedLevels, sub } from './geometry';
import { endAt, startAt, wallGeom } from './walls';

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

let refusal: string | null = null;

/** Motivo dell'ultima modifica rifiutata da followWalls (e lo azzera) */
export function takeRefusal() {
  const r = refusal;
  refusal = null;
  return r;
}

/**
 * Porte e finestre dei muri cambiati restano intere dentro il tratto libero del muro (tra le facce
 * dei muri a cui si innesta): se escono vengono riportate dentro; se non ci stanno la modifica
 * viene rifiutata.
 */
function fitOpenings(p: Project, wallIds: Set<string>): Project | null {
  const fixes = new Map<string, number>();
  for (const id of wallIds) {
    const w = p.elements.find((e): e is Wall => e.kind === 'wall' && e.id === id);
    if (!w) continue;
    const ops = p.elements.filter((e) => e.kind === 'opening' && e.wallId === id);
    if (!ops.length) continue;
    const g = wallGeom(p, w);
    const s0 = Math.max(startAt(g, g.half), startAt(g, -g.half), 0);
    const s1 = Math.min(endAt(g, g.half), endAt(g, -g.half), g.L);
    let need = 0;
    for (const o of ops) {
      if (o.kind !== 'opening') continue;
      const wd = byId(p.catalog.opening, o.typeId)?.width ?? 0.8;
      need += wd;
      if (s1 - s0 < wd - 1e-6) {
        refusal = `Il muro diventerebbe troppo corto per l’apertura da ${Math.round(wd * 100)} cm: modifica annullata.`;
        return null;
      }
      const off = Math.min(s1 - wd / 2, Math.max(s0 + wd / 2, o.offset));
      if (Math.abs(off - o.offset) > 1e-6) fixes.set(o.id, +off.toFixed(4));
    }
    if (need > s1 - s0 + 1e-6) {
      refusal = 'Il muro diventerebbe troppo corto per contenere le sue aperture: modifica annullata.';
      return null;
    }
  }
  if (!fixes.size) return p;
  return produce(p, (d) => {
    for (const e of d.elements) if (e.kind === 'opening' && fixes.has(e.id)) e.offset = fixes.get(e.id)!;
  });
}

export function followWalls(prev: Project, next: Project): Project {
  const out = followWallsInner(prev, next);
  if (out === prev) return out;
  const prevById = new Map(prev.elements.map((e) => [e.id, e]));
  const touched = new Set<string>();
  for (const e of out.elements) {
    if (e.kind === 'wall' && prevById.get(e.id) !== e) touched.add(e.id);
    // anche le aperture modificate direttamente (spostate o cambiate di tipologia)
    if (e.kind === 'opening' && prevById.get(e.id) !== e) touched.add(e.wallId);
  }
  if (!touched.size) return out;
  const fitted = fitOpenings(out, touched);
  return fitted ?? prev;
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
