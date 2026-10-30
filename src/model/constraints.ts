// Vincoli tra elementi: i lati di solai e coperture che giacciono sull'asse di un muro
// seguono quel muro quando viene spostato, allungato o ruotato.
//
// Dopo ogni modifica si confronta il modello precedente con il nuovo: per ogni muro cambiato
// si cercano (nel modello precedente) i lati di solai e coperture appoggiati sul suo asse;
// i vertici vengono poi ricalcolati come intersezione dei lati adiacenti.

import { produce } from 'immer';
import type { Project, Vec2, Wall } from './types';
import { add, dot, mul, norm, sortedLevels, sub } from './geometry';

const TOL = 0.02;
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

export function followWalls(prev: Project, next: Project): Project {
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
  if (!updates.size) return next;
  return produce(next, (d) => {
    for (const e of d.elements) {
      const u = updates.get(e.id);
      if (u && (e.kind === 'slab' || e.kind === 'roof')) e.points = u;
    }
  });
}
