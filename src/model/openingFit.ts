// Porte e finestre dentro il loro muro: un'unica regola, usata dai vincoli (quando un muro o
// un'apertura cambiano) e dalle quote (quando si allunga o si accorcia un muro).

import type { Opening, Project, Wall } from './types';
import { byId } from './geometry';
import { endAt, startAt, wallGeom, type WallGeom } from './walls';

/** Tratto libero del muro (tra i tagli delle giunzioni d'estremità), in ascissa lungo il muro */
export function wallFreeSpan(g: WallGeom) {
  return {
    s0: Math.max(startAt(g, g.half), startAt(g, -g.half), 0),
    s1: Math.min(endAt(g, g.half), endAt(g, -g.half), g.L),
  };
}

export type OpeningFit = { ok: true; offsets: Map<string, number> } | { ok: false; error: string };

/**
 * Posizioni delle aperture del muro perché restino intere nel suo tratto libero.
 * Restituisce solo quelle da correggere, oppure il motivo per cui non ci stanno.
 * Con `separate` le aperture vengono anche distanziate tra loro, mantenendo l'ordine: serve quando
 * è il muro a cambiare; spostando una singola apertura le altre non vanno toccate.
 */
export function fitWallOpenings(p: Project, w: Wall, opts: { separate: boolean }): OpeningFit {
  const ops = p.elements
    .filter((e): e is Opening => e.kind === 'opening' && e.wallId === w.id)
    .map((o) => ({ id: o.id, offset: o.offset, w: byId(p.catalog.opening, o.typeId)?.width ?? 0.8 }))
    .sort((x, y) => x.offset - y.offset);
  const offsets = new Map<string, number>();
  if (!ops.length) return { ok: true, offsets };
  const { s0, s1 } = wallFreeSpan(wallGeom(p, w));
  const span = s1 - s0;
  const widest = Math.max(...ops.map((o) => o.w));
  if (span < widest - 1e-6) return { ok: false, error: `Il muro diventerebbe troppo corto per l’apertura da ${Math.round(widest * 100)} cm: modifica annullata.` };
  if (ops.reduce((t, o) => t + o.w, 0) > span + 1e-6) return { ok: false, error: 'Il muro diventerebbe troppo corto per contenere le sue aperture: modifica annullata.' };
  const pos = ops.map((o) => o.offset);
  if (opts.separate) {
    // da destra: ciascuna entro il limite lasciato dalla successiva; poi da sinistra
    let limit = s1;
    for (let i = ops.length - 1; i >= 0; i--) {
      pos[i] = Math.min(pos[i], limit - ops[i].w / 2);
      limit = pos[i] - ops[i].w / 2;
    }
    let from = s0;
    for (let i = 0; i < ops.length; i++) {
      pos[i] = Math.max(pos[i], from + ops[i].w / 2);
      from = pos[i] + ops[i].w / 2;
    }
  } else for (let i = 0; i < ops.length; i++) pos[i] = Math.min(s1 - ops[i].w / 2, Math.max(s0 + ops[i].w / 2, pos[i]));
  ops.forEach((o, i) => {
    if (Math.abs(pos[i] - o.offset) > 1e-6) offsets.set(o.id, +pos[i].toFixed(4));
  });
  return { ok: true, offsets };
}
