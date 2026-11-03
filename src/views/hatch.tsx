// Campiture da disegno a china: ogni materiale ha un retino in bianco e nero o una tonalità di grigio.
// I retini sono <pattern> SVG in coordinate del disegno, dimensionati sul millimetro di carta (mm),
// così mantengono la stessa densità a qualunque scala.

import { useId } from 'react';
import type { HatchKind, WallLayer } from '../model/types';

export type { HatchKind };

export const HATCH_LABEL: Record<HatchKind, string> = {
  laterizio: 'Laterizio · tratteggio 45°',
  calcestruzzo: 'Calcestruzzo · punti e inerti',
  isolante: 'Isolante · reticolo fine',
  legno: 'Legno · tratteggio −45°',
  intonaco: 'Intonaco · grigio chiaro',
  massetto: 'Massetto · punteggiato',
  pietra: 'Pietra, gres · grigio medio',
  impermeabile: 'Guaina · nero pieno',
  terreno: 'Terreno, vegetale',
  vuoto: 'Vuoto, intercapedine',
};

export const HATCH_KINDS = Object.keys(HATCH_LABEL) as HatchKind[];

const RULES: [RegExp, HatchKind][] = [
  [/impermeab|guaina|bitum|barriera/, 'impermeabile'],
  [/vespaio|igloo|ventilaz|intercapedine|camera d.aria/, 'vuoto'],
  [/vegetaz|substrato|terreno|terra\b|ghiaia/, 'terreno'],
  [/isolant|eps|xps|lana|fibra|poliuret|sughero|anticalpestio/, 'isolante'],
  [/latero|lateriz|forato|mattone|blocco|coppi|tegol|poroton/, 'laterizio'],
  [/calcestruzzo|c\.a\.|cemento|platea|setto|getto/, 'calcestruzzo'],
  [/legno|assito|parquet|rovere|abete|listell|xlam|orditura/, 'legno'],
  [/intonac|rasatura|cartongesso|gesso|pittura/, 'intonaco'],
  [/massetto|sottofondo|caldana|allettamento/, 'massetto'],
  [/pietra|gres|lastre|marmo|ceramic|piastrell|pavimento|manto/, 'pietra'],
];

/** Campitura di uno strato: quella scelta, altrimenti dedotta dal nome e dal ruolo */
export function hatchOf(l: Pick<WallLayer, 'name' | 'role'> & { hatch?: HatchKind }): HatchKind {
  if (l.hatch) return l.hatch;
  const n = l.name.toLowerCase();
  for (const [re, k] of RULES) if (re.test(n)) return k;
  return l.role === 'isolante' ? 'isolante' : l.role === 'finitura' ? 'intonaco' : l.role === 'struttura' ? 'laterizio' : 'vuoto';
}

/** Campitura che rappresenta il muro intero alle scale piccole: quella dello strato portante */
export function mainHatch(layers: (Pick<WallLayer, 'name' | 'role' | 'thickness'> & { hatch?: HatchKind })[]): HatchKind {
  const pool = layers.filter((l) => l.role === 'struttura');
  const list = pool.length ? pool : layers;
  const best = list.reduce((a, b) => (b.thickness > a.thickness ? b : a), list[0]);
  return best ? hatchOf(best) : 'laterizio';
}

const SOLID: Partial<Record<HatchKind, string>> = {
  intonaco: '#dadada',
  pietra: '#b4b4b4',
  impermeabile: '#1b1b1b',
};

const INK = 'var(--hatch-ink, #1b1b1b)';
const PAPER = 'var(--hatch-paper, #ffffff)';

/** Riempimento da usare in fill= */
export function hatchFill(prefix: string, k: HatchKind) {
  if (SOLID[k]) return SOLID[k]!;
  if (k === 'vuoto') return PAPER;
  return `url(#${prefix}-${k})`;
}

/** Prefisso univoco per i retini di un disegno (più disegni convivono nella stessa pagina) */
export function useHatchPrefix() {
  return 'h' + useId().replace(/[^a-zA-Z0-9]/g, '');
}

/** Definizioni dei retini; u = metri per millimetro di carta */
export function HatchDefs({ prefix, u }: { prefix: string; u: number }) {
  const sw = 0.2 * u;
  const lines = (id: string, step: number, angle: number, color = INK, w = sw) => (
    <pattern key={id} id={`${prefix}-${id}`} patternUnits="userSpaceOnUse" width={step} height={step} patternTransform={`rotate(${angle})`}>
      <rect width={step} height={step} fill={PAPER} />
      <line x1={0} y1={0} x2={0} y2={step} stroke={color} strokeWidth={w} />
    </pattern>
  );
  const c = 4 * u;
  return (
    <defs>
      {lines('laterizio', 1.1 * u, 45)}
      {lines('legno', 1.3 * u, -45, INK, sw * 0.9)}
      <pattern id={`${prefix}-isolante`} patternUnits="userSpaceOnUse" width={u} height={u} patternTransform="rotate(45)">
        <rect width={u} height={u} fill={PAPER} />
        <path d={`M0,0 V${u} M0,0 H${u}`} stroke="#4a4a4a" strokeWidth={sw * 0.8} fill="none" />
      </pattern>
      <pattern id={`${prefix}-calcestruzzo`} patternUnits="userSpaceOnUse" width={c} height={c}>
        <rect width={c} height={c} fill="#efefef" />
        {[
          [0.5, 0.6],
          [2.3, 0.4],
          [3.4, 1.6],
          [1.2, 2.1],
          [2.8, 3.1],
          [0.4, 3.5],
          [1.9, 1.3],
        ].map(([x, y], i) => (
          <circle key={i} cx={x * u} cy={y * u} r={0.2 * u} fill={INK} />
        ))}
        <path
          d={`M${1.4 * u},${0.4 * u} l${0.6 * u},${0.3 * u} l${-0.5 * u},${0.4 * u} z M${3 * u},${2.2 * u} l${0.5 * u},${0.5 * u} l${-0.7 * u},${0.1 * u} z M${0.5 * u},${2.6 * u} l${0.6 * u},${0.1 * u} l${-0.2 * u},${0.5 * u} z`}
          fill="none"
          stroke={INK}
          strokeWidth={sw * 0.8}
        />
      </pattern>
      <pattern id={`${prefix}-massetto`} patternUnits="userSpaceOnUse" width={1.4 * u} height={1.4 * u}>
        <rect width={1.4 * u} height={1.4 * u} fill={PAPER} />
        <circle cx={0.35 * u} cy={0.35 * u} r={0.16 * u} fill={INK} />
        <circle cx={1.05 * u} cy={1.05 * u} r={0.16 * u} fill={INK} />
      </pattern>
      <pattern id={`${prefix}-terreno`} patternUnits="userSpaceOnUse" width={3 * u} height={2 * u}>
        <rect width={3 * u} height={2 * u} fill={PAPER} />
        <path d={`M${0.3 * u},${0.6 * u} h${0.9 * u} M${1.8 * u},${1.5 * u} h${0.9 * u}`} stroke={INK} strokeWidth={sw} />
        <circle cx={2.2 * u} cy={0.5 * u} r={0.16 * u} fill={INK} />
        <circle cx={0.8 * u} cy={1.5 * u} r={0.16 * u} fill={INK} />
      </pattern>
    </defs>
  );
}

/** Campione di campitura per pannelli e liste (piccolo SVG autonomo) */
export function HatchSwatch({ kinds, weights, height = 14, width = 46 }: { kinds: HatchKind[]; weights?: number[]; height?: number; width?: number }) {
  const prefix = useHatchPrefix();
  const tot = (weights ?? kinds.map(() => 1)).reduce((a, b) => a + b, 0) || 1;
  let x = 0;
  // u: un "millimetro" del campione vale ~2.2 px
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="hatch-swatch" aria-hidden>
      <HatchDefs prefix={prefix} u={2.2} />
      {kinds.map((k, i) => {
        const w = ((weights?.[i] ?? 1) / tot) * width;
        const r = <rect key={i} x={x} y={0} width={w} height={height} fill={hatchFill(prefix, k)} stroke="#1b1b1b" strokeWidth={0.5} />;
        x += w;
        return r;
      })}
    </svg>
  );
}
