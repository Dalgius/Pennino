// Componenti dei serramenti: controtelaio, telaio fisso, ante, davanzale o soglia.
// Le misure sono convenzionali (sezioni tipiche di serramenti in legno-alluminio e porte interne)
// e servono al disegno; la luce dell'apertura è la larghezza della tipologia.

import type { FramePosition, Opening, OpeningType, Project, Wall } from './types';
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
  leaves: 0 | 1 | 2;
  /** Vano senza serramento: niente telaio, ante, soglia */
  bare: boolean;
  /** Verso di apertura delle ante lungo la normale n del muro (+1 / −1) */
  openDir: 1 | -1;
  /** Cerniera della prima anta sull'inizio (false) o sulla fine (true) dell'apertura */
  mirror: boolean;
  hasSill: boolean;
  hasThreshold: boolean;
}

/** Vano senza porta: una porta con zero ante */
export const isBareOpening = (t: Pick<OpeningType, 'category' | 'leaves'> | undefined) => !!t && t.category === 'porta' && t.leaves === 0;

export function leavesOf(t: OpeningType): 0 | 1 | 2 {
  if (isBareOpening(t)) return 0;
  if (t.leaves) return t.leaves;
  return t.category === 'finestra' ? (t.width >= 1.0 ? 2 : 1) : t.width >= 1.4 ? 2 : 1;
}

/** Soglia: solo per le aperture a pavimento; scelta sull'apertura, altrimenti nei muri perimetrali */
export function hasThreshold(o: Pick<Opening, 'threshold'>, t: OpeningType, exterior: boolean): boolean {
  if (t.sill > 0) return false;
  return o.threshold ?? (exterior && !isBareOpening(t));
}

/** Sporgenza della soglia oltre il filo esterno del muro (m) */
export const THRESHOLD_NOSE = 0.02;

/** Profondità del telaio quando non occupa tutto lo spessore del muro */
export const frameDepth = (t: OpeningType) => (t.category === 'porta' ? 0.09 : 0.07);

/**
 * Centro del telaio (scostamento dall'asse lungo n) per una posizione scelta. Le distanze si misurano
 * dal filo esterno del muro (lato extSign) verso l'interno e sono contenute nello spessore.
 */
export function framePlacement(g: WallGeom, pos: Exclude<FramePosition, 'auto'>, fd: number, offset = 0): number {
  const room = Math.max(0, 2 * g.half - fd);
  const d = pos === 'esterno' ? 0 : pos === 'interno' ? room : pos === 'asse' ? room / 2 : Math.min(room, Math.max(0, offset));
  return g.extSign * (g.half - d - fd / 2);
}

/** Distanza della faccia esterna del telaio dal filo esterno del muro */
export const frameDistance = (g: WallGeom, spec: Pick<FixtureSpec, 'fc' | 'fd'>) => g.half - g.extSign * spec.fc - spec.fd / 2;

export function fixtureSpec(p: Project, w: Wall, g: WallGeom, o: Opening, t: OpeningType): FixtureSpec {
  const exterior = isExteriorWall(p, w);
  const wt = byId(p.catalog.wall, w.typeId);
  const isDoor = t.category === 'porta';
  let fc = 0;
  let fd = 2 * g.half;
  if (o.frame && o.frame !== 'auto') {
    // posizione scelta per questa apertura (murature storiche, mazzette, serramenti in luce)
    fd = Math.min(frameDepth(t), 2 * g.half);
    fc = framePlacement(g, o.frame, fd, o.frameOffset);
  } else if (exterior || !isDoor) {
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
    bare: isBareOpening(t),
    openDir,
    mirror: !!o.mirror,
    hasSill: !isDoor && t.sill > 0,
    hasThreshold: hasThreshold(o, t, exterior),
  };
}

/** Ante: intervalli lungo il muro, con la posizione della cerniera */
export function leafSpans(spec: FixtureSpec, start: number, end: number) {
  if (spec.leaves === 0) return [];
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
