// Componenti dei serramenti: controtelaio, telaio fisso, ante, davanzale o soglia.
// Le misure sono convenzionali (sezioni tipiche di serramenti in legno-alluminio e porte interne)
// e servono al disegno; la luce dell'apertura è la larghezza della tipologia.

import type { Opening, OpeningType, Project, Wall } from './types';
import { byId } from './geometry';
import { isExteriorWall } from './dimensions';
import { layerBands, type WallGeom } from './walls';

export interface FixtureSpec {
  /** In un muro perimetrale */
  exterior: boolean;
  /** Scostamento dall'asse del centro del telaio */
  fc: number;
  /** Profondità del telaio (spessore nel muro) */
  fd: number;
  /** Controtelaio (lungo il muro) */
  ct: number;
  /** Telaio fisso in vista */
  tf: number;
  /** Spessore dell'anta */
  leafT: number;
  leaves: 1 | 2;
  /** Verso di apertura delle ante lungo la normale n del muro (+1 / −1) */
  openDir: 1 | -1;
  /** Cerniera della prima anta sull'inizio (false) o sulla fine (true) dell'apertura */
  mirror: boolean;
  hasSill: boolean;
  hasThreshold: boolean;
}

export function leavesOf(t: OpeningType): 1 | 2 {
  if (t.leaves) return t.leaves;
  return t.category === 'finestra' ? (t.width >= 1.0 ? 2 : 1) : t.width >= 1.4 ? 2 : 1;
}

export function fixtureSpec(p: Project, w: Wall, g: WallGeom, o: Opening, t: OpeningType): FixtureSpec {
  const exterior = isExteriorWall(p, w);
  const wt = byId(p.catalog.wall, w.typeId);
  const isDoor = t.category === 'porta';
  let fc = 0;
  let fd = 2 * g.half;
  if (exterior || !isDoor) {
    // telaio a filo esterno della muratura portante, subito dietro il cappotto
    fd = isDoor ? 0.09 : 0.07;
    const bands = wt ? layerBands(g, wt.layers) : [];
    const struct = bands.find((_, j) => wt!.layers[j].role === 'struttura');
    fc = (struct ? struct.o0 : 0) - g.extSign * (fd / 2);
  }
  // le ante aprono verso l'interno; «flip» le porta sull'altro lato
  const inward: 1 | -1 = exterior ? (g.extSign === 1 ? -1 : 1) : -1;
  const openDir = (o.flip ? -inward : inward) as 1 | -1;
  return {
    exterior,
    fc,
    fd,
    ct: 0.015,
    tf: isDoor ? 0.04 : 0.055,
    leafT: isDoor ? (exterior ? 0.07 : 0.045) : 0.07,
    leaves: leavesOf(t),
    openDir,
    mirror: !!o.mirror,
    hasSill: !isDoor && t.sill > 0,
    hasThreshold: exterior && t.sill === 0,
  };
}

/** Ante: intervalli lungo il muro, con la posizione della cerniera */
export function leafSpans(spec: FixtureSpec, start: number, end: number) {
  const c0 = start + spec.ct + spec.tf;
  const c1 = end - spec.ct - spec.tf;
  if (spec.leaves === 2) {
    const mid = (c0 + c1) / 2;
    return [
      { s0: c0, s1: mid, hinge: c0, free: mid },
      { s0: mid, s1: c1, hinge: c1, free: mid },
    ];
  }
  return [{ s0: c0, s1: c1, hinge: spec.mirror ? c1 : c0, free: spec.mirror ? c0 : c1 }];
}
