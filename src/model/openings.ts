// Componenti dei serramenti: controtelaio, telaio fisso, ante, davanzale o soglia.
// Le misure sono convenzionali (sezioni tipiche di serramenti in legno-alluminio e porte interne)
// e servono al disegno; la luce dell'apertura è la larghezza della tipologia.

import type { ArchHead, FramePosition, Opening, OpeningType, Project, Wall } from './types';
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

// ───────── Archi ─────────

export const ARCH_LABEL: Record<ArchHead, string> = { piana: 'Piana (architrave)', 'tutto-sesto': 'Arco a tutto sesto', ribassato: 'Arco ribassato' };

type ArchShape = Pick<OpeningType, 'width' | 'height' | 'head' | 'rise'>;

/** Freccia proposta per un arco ribassato: un quinto della luce */
export const defaultRise = (width: number) => Math.round((width / 5) * 100) / 100;

/** Freccia dell'arco (m): 0 per la testa piana; mai oltre metà luce né oltre l'altezza */
export function archRise(t: ArchShape): number {
  if (!t.head || t.head === 'piana') return 0;
  const half = t.width / 2;
  const f = t.head === 'tutto-sesto' ? half : (t.rise ?? defaultRise(t.width));
  return Math.max(0, Math.min(f, half, t.height));
}

/** Raggio dell'intradosso: la corda è la luce, la freccia f */
const archRadius = (half: number, f: number) => (half * half + f * f) / (2 * f);

/** Altezza dell'imposta sopra il davanzale */
export const springHeight = (t: ArchShape) => t.height - archRise(t);

/** Altezza dell'intradosso sopra il davanzale a distanza x dal centro dell'apertura */
export function headAt(t: ArchShape, x: number): number {
  const f = archRise(t);
  if (f < 1e-6) return t.height;
  const half = t.width / 2;
  const R = archRadius(half, f);
  const xx = Math.min(Math.abs(x), half);
  return t.height - f + Math.sqrt(Math.max(0, R * R - xx * xx)) - (R - f);
}

/**
 * Intradosso da un'imposta all'altra: punti (x dal centro, h sopra il davanzale) da sinistra a destra.
 * inset restringe l'arco verso l'interno (telaio): resta la parte sopra l'imposta.
 */
export function archProfile(t: ArchShape, inset = 0, n = 32): { x: number; h: number }[] {
  const f = archRise(t);
  const half = t.width / 2;
  if (f < 1e-6) return [{ x: -half + inset, h: t.height - inset }, { x: half - inset, h: t.height - inset }];
  const R = archRadius(half, f);
  const r = R - inset;
  const zc = t.height - R; // centro dell'arco sopra il davanzale
  const spring = t.height - f;
  if (r <= spring - zc) return [];
  // angoli tra cui l'arco ristretto sta sopra l'imposta
  const a0 = Math.asin(Math.max(-1, Math.min(1, (spring - zc) / r)));
  const out: { x: number; h: number }[] = [];
  for (let i = 0; i <= n; i++) {
    const a = Math.PI - a0 - ((Math.PI - 2 * a0) * i) / n;
    out.push({ x: r * Math.cos(a), h: zc + r * Math.sin(a) });
  }
  return out;
}

/** Area del vano (m²): il rettangolo fino all'imposta più il segmento d'arco */
export function openingArea(t: ArchShape): number {
  const f = archRise(t);
  const rect = t.width * t.height;
  if (f < 1e-6) return rect;
  const half = t.width / 2;
  const R = archRadius(half, f);
  const segment = R * R * Math.acos((R - f) / R) - (R - f) * half;
  return rect - (t.width * f - segment);
}

/** Area del vano in un muro alto H sopra il davanzale (le aperture più alte del muro si tagliano) */
export function openingAreaIn(t: ArchShape & { sill: number }, H: number, span = t.width): number {
  const h = Math.max(0, H - t.sill);
  const k = span / t.width;
  if (h >= t.height) return openingArea(t) * k;
  if (h <= springHeight(t)) return span * h;
  // arco tagliato dalla cima del muro: integrazione per strisce
  const n = 64;
  let a = 0;
  for (let i = 0; i < n; i++) a += Math.min(h, headAt(t, -t.width / 2 + ((i + 0.5) * t.width) / n));
  return (a * t.width) / n * k;
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
