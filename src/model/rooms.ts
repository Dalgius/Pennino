// Locali: il contorno di un vano si ricava dagli assi dei muri che lo chiudono attorno a un punto.
// Dal contorno d'asse si ottiene la superficie netta arretrando ogni lato di mezzo spessore del muro.

import type { Project, Room, Vec2, Wall } from './types';
import { cached } from './cache';
import { byId, dist, JOIN_TOL, levelAbove, offsetPolygon, pointInPolygon, polygonArea, polygonPerimeter, projectOnSegment, slabOutline, wallThickness } from './geometry';

export interface RoomShape {
  /** contorno sugli assi dei muri, antiorario */
  axis: Vec2[];
  /** muro di ciascun lato del contorno d'asse */
  wallIds: string[];
  /** contorno netto (filo interno dei muri) */
  net: Vec2[];
}

interface Face {
  pts: Vec2[];
  wallIds: string[];
  area: number;
}

/** Vani chiusi di un livello: facce del grafo formato dagli assi dei muri */
function levelFaces(p: Project, levelId: string): Face[] {
  return cached(p, `roomFaces:${levelId}`, () => {
    const walls = p.elements.filter((e): e is Wall => e.kind === 'wall' && e.levelId === levelId && dist(e.a, e.b) > 1e-6);
    // nodi: estremi, innesti a T e incroci, fusi entro la tolleranza
    const nodes: Vec2[] = [];
    const nodeOf = (q: Vec2) => {
      const i = nodes.findIndex((n) => dist(n, q) < JOIN_TOL);
      if (i >= 0) return i;
      nodes.push(q);
      return nodes.length - 1;
    };
    const cross = (a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2 | null => {
      const r = { x: b.x - a.x, y: b.y - a.y };
      const s = { x: d.x - c.x, y: d.y - c.y };
      const den = r.x * s.y - r.y * s.x;
      if (Math.abs(den) < 1e-9) return null;
      const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / den;
      const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / den;
      return t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6 ? { x: a.x + r.x * t, y: a.y + r.y * t } : null;
    };
    const edges: { u: number; v: number; wallId: string }[] = [];
    for (const w of walls) {
      const L = dist(w.a, w.b);
      const cuts: { t: number; q: Vec2 }[] = [
        { t: 0, q: w.a },
        { t: 1, q: w.b },
      ];
      for (const o of walls) {
        if (o.id === w.id) continue;
        for (const q of [o.a, o.b]) {
          const pr = projectOnSegment(q, w.a, w.b);
          if (pr.d < JOIN_TOL && pr.t > JOIN_TOL / L && pr.t < 1 - JOIN_TOL / L) cuts.push({ t: pr.t, q });
        }
        const x = cross(w.a, w.b, o.a, o.b);
        if (x) cuts.push({ t: projectOnSegment(x, w.a, w.b).t, q: x });
      }
      cuts.sort((m, n) => m.t - n.t);
      for (let i = 0; i + 1 < cuts.length; i++) {
        const u = nodeOf(cuts[i].q);
        const v = nodeOf(cuts[i + 1].q);
        if (u !== v && !edges.some((e) => (e.u === u && e.v === v) || (e.u === v && e.v === u))) edges.push({ u, v, wallId: w.id });
      }
    }
    // i muri che finiscono nel vuoto non chiudono nulla: si tolgono finché restano solo cicli
    let live = edges;
    for (;;) {
      const deg = new Map<number, number>();
      for (const e of live) {
        deg.set(e.u, (deg.get(e.u) ?? 0) + 1);
        deg.set(e.v, (deg.get(e.v) ?? 0) + 1);
      }
      const next = live.filter((e) => deg.get(e.u)! > 1 && deg.get(e.v)! > 1);
      if (next.length === live.length) break;
      live = next;
    }
    // semilati uscenti da ogni nodo, ordinati per angolo
    type Half = { from: number; to: number; wallId: string; ang: number };
    const out = new Map<number, Half[]>();
    for (const e of live)
      for (const [from, to] of [
        [e.u, e.v],
        [e.v, e.u],
      ]) {
        const h: Half = { from, to, wallId: e.wallId, ang: Math.atan2(nodes[to].y - nodes[from].y, nodes[to].x - nodes[from].x) };
        const list = out.get(from);
        if (list) list.push(h);
        else out.set(from, [h]);
      }
    for (const list of out.values()) list.sort((a, b) => a.ang - b.ang);
    const faces: Face[] = [];
    const seen = new Set<string>();
    const key = (h: Half) => `${h.from}>${h.to}`;
    for (const list of out.values())
      for (const start of list) {
        if (seen.has(key(start))) continue;
        const pts: Vec2[] = [];
        const ids: string[] = [];
        let h = start;
        for (let guard = 0; guard < live.length * 2 + 2; guard++) {
          seen.add(key(h));
          pts.push(nodes[h.from]);
          ids.push(h.wallId);
          // al nodo d'arrivo si prende il lato subito in senso orario rispetto a quello da cui si arriva
          const around = out.get(h.to)!;
          const back = around.findIndex((x) => x.to === h.from);
          h = around[(back - 1 + around.length) % around.length];
          if (h === start) break;
        }
        let a2 = 0;
        pts.forEach((q, i) => {
          const r = pts[(i + 1) % pts.length];
          a2 += q.x * r.y - r.x * q.y;
        });
        // area positiva = vano (percorso antiorario); quella negativa è il contorno esterno
        if (a2 > 1e-6) faces.push({ pts, wallIds: ids, area: a2 / 2 });
      }
    return faces;
  });
}

/** Contorno del vano che contiene il punto, o null se i muri attorno non lo chiudono */
export function roomShape(p: Project, levelId: string, seed: Vec2): RoomShape | null {
  const face = levelFaces(p, levelId)
    .filter((f) => pointInPolygon(seed, f.pts))
    .sort((a, b) => a.area - b.area)[0];
  if (!face) return null;
  // lati consecutivi allineati (un muro spezzato da un innesto dall'altra parte) diventano un lato solo
  const axis: Vec2[] = [];
  const wallIds: string[] = [];
  const n = face.pts.length;
  for (let i = 0; i < n; i++) {
    const prev = face.pts[(i - 1 + n) % n];
    const q = face.pts[i];
    const next = face.pts[(i + 1) % n];
    const turn = (q.x - prev.x) * (next.y - q.y) - (q.y - prev.y) * (next.x - q.x);
    if (Math.abs(turn) < 1e-6 && face.wallIds[(i - 1 + n) % n] === face.wallIds[i]) continue;
    axis.push(q);
    wallIds.push(face.wallIds[i]);
  }
  const half = wallIds.map((id) => {
    const w = p.elements.find((e) => e.id === id);
    return w && w.kind === 'wall' ? wallThickness(byId(p.catalog.wall, w.typeId)) / 2 : 0;
  });
  return { axis, wallIds, net: offsetPolygon(axis, half.map((h) => -h)) };
}

export interface RoomInfo {
  room: Room;
  shape: RoomShape | null;
  /** superficie netta (m²) */
  area: number;
  perimeter: number;
  /** altezza netta: interpiano meno il solaio soprastante */
  height: number;
  /** superficie delle finestre sui muri del locale (m²) */
  windowArea: number;
  /** rapporto aeroilluminante: finestre / pavimento */
  ratio: number;
}

/** Rapporto aeroilluminante minimo per i locali abitabili (1/8) */
export const MIN_LIGHT_RATIO = 1 / 8;
/** Altezza minima dei locali abitabili (m) */
export const MIN_ROOM_HEIGHT = 2.7;
/** Destinazioni per cui valgono rapporto aeroilluminante e altezza minima dei locali abitabili */
export const HABITABLE_USES = ['Soggiorno', 'Cucina', 'Camera', 'Studio', 'Pranzo'];
export const ROOM_USES = [...HABITABLE_USES, 'Bagno', 'Disimpegno', 'Ripostiglio', 'Ingresso', 'Lavanderia', 'Locale tecnico', 'Autorimessa', 'Altro'];

export function roomInfo(p: Project, room: Room): RoomInfo {
  const shape = roomShape(p, room.levelId, room.p);
  const lvl = byId(p.levels, room.levelId);
  // solaio soprastante sopra il punto del locale
  const next = levelAbove(p, room.levelId);
  let slab = 0;
  if (next)
    for (const e of p.elements)
      if (e.kind === 'slab' && e.levelId === next.id && pointInPolygon(room.p, slabOutline(p, e))) slab = byId(p.catalog.slab, e.typeId)?.thickness ?? slab;
  const height = Math.max(0, (lvl?.height ?? 0) - slab);
  if (!shape) return { room, shape, area: 0, perimeter: 0, height, windowArea: 0, ratio: 0 };
  const area = Math.abs(polygonArea(shape.net));
  // finestre: quelle dei muri del contorno il cui centro cade sul tratto che affaccia sul locale
  let windowArea = 0;
  const n = shape.axis.length;
  for (const o of p.elements) {
    if (o.kind !== 'opening') continue;
    const t = byId(p.catalog.opening, o.typeId);
    const w = p.elements.find((e) => e.id === o.wallId);
    if (!t || t.category !== 'finestra' || !w || w.kind !== 'wall') continue;
    const L = dist(w.a, w.b) || 1;
    const c = { x: w.a.x + ((w.b.x - w.a.x) * o.offset) / L, y: w.a.y + ((w.b.y - w.a.y) * o.offset) / L };
    for (let i = 0; i < n; i++) {
      if (shape.wallIds[i] !== w.id) continue;
      const pr = projectOnSegment(c, shape.axis[i], shape.axis[(i + 1) % n]);
      if (pr.d < JOIN_TOL && pr.t > 0 && pr.t < 1) {
        windowArea += t.width * t.height;
        break;
      }
    }
  }
  return { room, shape, area, perimeter: polygonPerimeter(shape.net), height, windowArea, ratio: area > 0 ? windowArea / area : 0 };
}

export const isHabitable = (r: Room) => HABITABLE_USES.includes(r.use);

/** Locali del progetto con le loro misure */
export function roomSchedule(p: Project): RoomInfo[] {
  return (p.rooms ?? []).map((r) => roomInfo(p, r));
}
