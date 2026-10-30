// Modello informativo unico di Pennino.
// Tutte le fasi leggono e scrivono questa struttura: nessuna copia, nessuna esportazione intermedia.
// Unità: metri (coordinate, quote, spessori), gradi (angoli). Asse Y = nord di progetto.

export type ID = string;

export interface Vec2 {
  x: number;
  y: number;
}

// ───────────────────────── 01 · Inquadramento ─────────────────────────

export interface Level {
  id: ID;
  name: string;
  /** Quota del piano finito rispetto allo ±0.00 di progetto */
  elevation: number;
  /** Altezza interpiano (da piano finito a piano finito) */
  height: number;
}

export type ContextItem =
  | { id: ID; kind: 'edificio'; name: string; points: Vec2[]; height: number }
  | { id: ID; kind: 'strada'; name: string; points: Vec2[]; width: number }
  | { id: ID; kind: 'albero'; name: string; p: Vec2; radius: number };

/** Immagine raster di base (catastale, planimetria, ortofoto) posizionata in scala */
export interface Underlay {
  id: ID;
  name: string;
  /** Riferimento all'immagine salvata a parte (IndexedDB) */
  imageId: string;
  /** Angolo inferiore sinistro (m) */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Rotazione antioraria attorno all'angolo inferiore sinistro (gradi) */
  rotation: number;
  opacity: number;
  visible: boolean;
}

export interface Site {
  address: string;
  municipality: string;
  cadastre: string;
  latitude: number;
  longitude: number;
  crs: string;
  /** Quota s.l.m. dello ±0.00 di progetto */
  altitude: number;
  /** Rotazione del nord geografico rispetto al nord di progetto (gradi, orari) */
  trueNorth: number;
  /** Quota del terreno naturale rispetto allo ±0.00 */
  groundLevel: number;
  lot: Vec2[];
  context: ContextItem[];
  zoning: {
    zone: string;
    maxHeight: number;
    minBoundaryDistance: number;
    maxCoverage: number; // rapporto di copertura (0-1)
  };
  sun: { month: number; day: number; hour: number };
  underlays?: Underlay[];
}

// ───────────────────────── 02 · Modellazione ─────────────────────────

export type LayerRole = 'finitura' | 'isolante' | 'struttura' | 'altro';

export interface WallLayer {
  name: string;
  thickness: number;
  role: LayerRole;
  color: string;
  /** Voce di elenco prezzi per gli strati di finitura (computata per superficie netta) */
  priceCode?: string;
}

export interface WallType {
  id: ID;
  name: string;
  layers: WallLayer[];
  priceCode: string;
}

export interface SlabType {
  id: ID;
  name: string;
  thickness: number;
  priceCode: string;
  /** Pavimento: computato per superficie */
  finishName: string;
  finishPriceCode?: string;
}

export interface ColumnType {
  id: ID;
  name: string;
  width: number;
  depth: number;
  material: string;
  priceCode: string;
}

export interface BeamType {
  id: ID;
  name: string;
  width: number;
  height: number;
  material: string;
  priceCode: string;
}

export interface OpeningType {
  id: ID;
  category: 'porta' | 'finestra';
  name: string;
  width: number;
  height: number;
  sill: number;
  priceCode: string;
  /** Trasmittanza (finestre) */
  uw?: number;
  /** Numero di ante; se assente si deduce dalla larghezza */
  leaves?: 1 | 2;
}

export interface RoofType {
  id: ID;
  name: string;
  thickness: number;
  priceCode: string;
}

export interface Catalog {
  wall: WallType[];
  slab: SlabType[];
  column: ColumnType[];
  beam: BeamType[];
  opening: OpeningType[];
  roof: RoofType[];
}

export interface Wall {
  id: ID;
  kind: 'wall';
  levelId: ID;
  typeId: ID;
  a: Vec2;
  b: Vec2;
  /** Se assente, il muro segue l'altezza interpiano del livello */
  height?: number;
  /** Inverte il lato esterno (di norma è quello rivolto fuori dall'edificio) */
  flip?: boolean;
}

export interface Opening {
  id: ID;
  kind: 'opening';
  wallId: ID;
  typeId: ID;
  /** Distanza del centro dell'apertura dall'inizio del muro (a) */
  offset: number;
  /** Verso di apertura (porte): anta sull'altro lato del muro */
  flip: boolean;
  /** Porta specchiata: cerniera sull'altro stipite */
  mirror?: boolean;
}

export interface Slab {
  id: ID;
  kind: 'slab';
  levelId: ID;
  typeId: ID;
  points: Vec2[];
}

export interface Column {
  id: ID;
  kind: 'column';
  levelId: ID;
  typeId: ID;
  p: Vec2;
}

export interface Beam {
  id: ID;
  kind: 'beam';
  levelId: ID;
  typeId: ID;
  a: Vec2;
  b: Vec2;
}

export interface Stair {
  id: ID;
  kind: 'stair';
  levelId: ID;
  a: Vec2;
  b: Vec2;
  width: number;
}

export interface Roof {
  id: ID;
  kind: 'roof';
  levelId: ID;
  typeId: ID;
  points: Vec2[];
  shape: 'piana' | 'falde';
  /** Pendenza falde in gradi */
  pitch: number;
  overhang: number;
}

export type BuildingElement = Wall | Opening | Slab | Column | Beam | Stair | Roof;
export type ElementKind = BuildingElement['kind'];

// ───────────────────────── 03 · Layout ─────────────────────────

export type ViewportKind = 'pianta' | 'prospetto' | 'assonometria' | 'planimetria' | 'abaco' | 'legenda';

export interface Viewport {
  id: ID;
  kind: ViewportKind;
  title: string;
  /** Posizione dell'angolo superiore sinistro sul foglio (mm) */
  x: number;
  y: number;
  scale: number;
  levelId?: ID;
  direction?: 'sud' | 'nord' | 'est' | 'ovest';
  schedule?: 'aperture' | 'muri';
  showDimensions?: boolean;
}

export type PaperFormat = 'A3' | 'A2' | 'A1';

export interface Sheet {
  id: ID;
  number: string;
  title: string;
  format: PaperFormat;
  revision: string;
  date: string;
  viewports: Viewport[];
}

export interface TitleBlock {
  studio: string;
  designer: string;
  client: string;
  projectCode: string;
  stage: string;
}

// ───────────────────────── 04 · Computo ─────────────────────────

export type WbsCategory =
  | 'Strutture'
  | 'Murature'
  | 'Solai'
  | 'Coperture'
  | 'Serramenti'
  | 'Scale'
  | 'Finiture'
  | 'Cantiere e sicurezza';

export interface PriceItem {
  code: string;
  description: string;
  unit: 'm' | 'm²' | 'm³' | 'cad' | 'kg';
  price: number;
  category: WbsCategory;
}

// ───────────────────────── 05 · Cantiere ─────────────────────────

export type SiteAreaUse = 'deposito' | 'baraccamenti' | 'parcheggio' | 'rifiuti' | 'lavorazione';
export type VehicleKind = 'autobetoniera' | 'autocarro' | 'escavatore' | 'autogru' | 'pompa';

export type SiteItem =
  | { id: ID; kind: 'recinzione'; points: Vec2[]; height: number }
  | { id: ID; kind: 'accesso'; p: Vec2; width: number; rotation: number; name: string }
  | { id: ID; kind: 'area'; points: Vec2[]; use: SiteAreaUse; name: string }
  | { id: ID; kind: 'gru'; p: Vec2; radius: number; name: string }
  | { id: ID; kind: 'mezzo'; p: Vec2; rotation: number; vehicle: VehicleKind }
  | { id: ID; kind: 'percorso'; points: Vec2[]; width: number; name: string };

export type SiteItemKind = SiteItem['kind'];

// ───────────────────────── Progetto ─────────────────────────

export interface Project {
  version: 1;
  name: string;
  site: Site;
  levels: Level[];
  catalog: Catalog;
  elements: BuildingElement[];
  sheets: Sheet[];
  titleBlock: TitleBlock;
  prices: PriceItem[];
  priceListName: string;
  siteLogistics: SiteItem[];
}

export type Phase = 'inquadramento' | 'modellazione' | 'layout' | 'computo' | 'cantiere';
