// Validazione dei progetti letti da file o dal salvataggio automatico.
// Errori bloccanti (struttura assente o non riconoscibile) fermano il caricamento con un messaggio chiaro;
// le parti facoltative mancanti vengono completate con valori predefiniti; gli elementi non validi
// o che puntano a livelli e tipologie inesistenti vengono scartati e segnalati.

import type { BuildingElement, Project } from './types';
import { emptyProject, sampleProject } from './defaults';

export class ProjectFormatError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPt = (v: unknown) => isObj(v) && isNum(v.x) && isNum(v.y);
const isPts = (v: unknown, min: number) => Array.isArray(v) && v.length >= min && v.every(isPt);

export interface ValidationResult {
  project: Project;
  /** Avvisi non bloccanti (parti completate, elementi scartati) */
  warnings: string[];
}

export function validateProject(raw: unknown): ValidationResult {
  const warnings: string[] = [];
  if (!isObj(raw)) throw new ProjectFormatError('Il file non contiene un progetto Pennino.');
  if (raw.version !== 1) throw new ProjectFormatError('Versione del progetto non riconosciuta.');
  if (!Array.isArray(raw.levels) || !raw.levels.length) throw new ProjectFormatError('Il progetto non ha livelli.');
  if (!Array.isArray(raw.elements)) throw new ProjectFormatError('Il progetto non ha l’elenco degli elementi.');

  const levels = (raw.levels as unknown[]).filter(
    (l): l is Project['levels'][number] => isObj(l) && typeof l.id === 'string' && isNum(l.elevation) && isNum(l.height),
  );
  if (!levels.length) throw new ProjectFormatError('I livelli del progetto non sono leggibili.');
  if (levels.length < (raw.levels as unknown[]).length) warnings.push('Alcuni livelli non leggibili sono stati scartati.');
  for (const l of levels) if (typeof l.name !== 'string') l.name = 'Livello';

  // parti facoltative: si completano con i valori di un progetto vuoto
  const base = emptyProject(sampleProject());
  const catalogRaw = isObj(raw.catalog) ? raw.catalog : {};
  const catalog = { ...base.catalog } as Project['catalog'];
  for (const k of Object.keys(base.catalog) as (keyof Project['catalog'])[]) {
    const list = catalogRaw[k];
    if (Array.isArray(list) && list.length && list.every((t) => isObj(t) && typeof t.id === 'string')) (catalog[k] as unknown[]) = list;
    else warnings.push(`Tipologie «${k}» mancanti: sono state usate quelle predefinite.`);
  }
  const siteRaw = isObj(raw.site) ? raw.site : {};
  if (!isObj(raw.site)) warnings.push('Dati del sito mancanti: sono stati usati quelli predefiniti.');
  const site = {
    ...base.site,
    ...siteRaw,
    lot: isPts(siteRaw.lot, 0) ? (siteRaw.lot as Project['site']['lot']) : [],
    context: Array.isArray(siteRaw.context) ? (siteRaw.context as Project['site']['context']) : [],
    zoning: { ...base.site.zoning, ...(isObj(siteRaw.zoning) ? siteRaw.zoning : {}) },
    sun: { ...base.site.sun, ...(isObj(siteRaw.sun) ? siteRaw.sun : {}) },
    underlays: Array.isArray(siteRaw.underlays) ? (siteRaw.underlays as Project['site']['underlays']) : [],
  } as Project['site'];
  for (const k of ['latitude', 'longitude', 'altitude', 'trueNorth', 'groundLevel'] as const) if (!isNum(site[k])) site[k] = base.site[k];

  // elementi: forma minima e riferimenti a livelli e tipologie esistenti
  const levelIds = new Set(levels.map((l) => l.id));
  const typeIds = (k: keyof Project['catalog']) => new Set((catalog[k] as { id: string }[]).map((t) => t.id));
  const types = { wall: typeIds('wall'), slab: typeIds('slab'), column: typeIds('column'), beam: typeIds('beam'), opening: typeIds('opening'), roof: typeIds('roof') };
  const okElement = (e: unknown): e is BuildingElement => {
    if (!isObj(e) || typeof e.id !== 'string') return false;
    const onLevel = typeof e.levelId === 'string' && levelIds.has(e.levelId);
    switch (e.kind) {
      case 'wall':
        return onLevel && types.wall.has(e.typeId as string) && isPt(e.a) && isPt(e.b);
      case 'slab':
        return onLevel && types.slab.has(e.typeId as string) && isPts(e.points, 3);
      case 'roof':
        return onLevel && types.roof.has(e.typeId as string) && isPts(e.points, 3) && isNum(e.pitch) && isNum(e.overhang);
      case 'column':
        return onLevel && types.column.has(e.typeId as string) && isPt(e.p);
      case 'beam':
        return onLevel && types.beam.has(e.typeId as string) && isPt(e.a) && isPt(e.b);
      case 'stair':
        return onLevel && isPt(e.a) && isPt(e.b) && isNum(e.width);
      case 'opening':
        return typeof e.wallId === 'string' && types.opening.has(e.typeId as string) && isNum(e.offset);
      default:
        return false;
    }
  };
  let elements = (raw.elements as unknown[]).filter(okElement);
  // aperture senza muro ospite
  const wallIds = new Set(elements.filter((e) => e.kind === 'wall').map((e) => e.id));
  elements = elements.filter((e) => e.kind !== 'opening' || wallIds.has(e.wallId));
  const dropped = (raw.elements as unknown[]).length - elements.length;
  if (dropped > 0) warnings.push(`${dropped} elementi non validi o senza livello, tipologia o muro ospite sono stati scartati.`);

  const project: Project = {
    ...base,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : base.name,
    site,
    levels,
    catalog,
    elements,
    sections: Array.isArray(raw.sections) ? (raw.sections as Project['sections']) : [],
    sheets: Array.isArray(raw.sheets) ? (raw.sheets as Project['sheets']) : base.sheets,
    titleBlock: { ...base.titleBlock, ...(isObj(raw.titleBlock) ? raw.titleBlock : {}) },
    prices: Array.isArray(raw.prices) ? (raw.prices as Project['prices']) : base.prices,
    priceListName: typeof raw.priceListName === 'string' ? raw.priceListName : base.priceListName,
    siteLogistics: Array.isArray(raw.siteLogistics) ? (raw.siteLogistics as Project['siteLogistics']) : [],
    wallComputeOverride: raw.wallComputeOverride as Project['wallComputeOverride'],
  };
  return { project, warnings };
}
