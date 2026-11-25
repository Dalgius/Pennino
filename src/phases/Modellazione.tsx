import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../model/store';
import type { BuildingElement, ElementStatus, Project, Vec2, VaultShape, Wall, ViewState, WallRef } from '../model/types';
import { defaultVault } from '../model/vaults';
import { axisCrossing, copyElements, cornerEnds, cornerWalls, extendTarget, extendWall, moveElements, splitWall, trimPiece, trimWall, wallStation } from '../model/wallEdit';
import { axisPolyline, extendToHost, WALL_REF_LABEL } from '../model/wallRef';
import {
  add,
  dot,
  bbox,
  byId,
  convexHull,
  dist,
  elementCode,
  fmt,
  fmtLevel,
  mul,
  norm,
  projectOnSegment,
  sortedLevels,
  sub,
  uid,
  wallLength,
  wallSegmentQuad,
  wallThickness,
  stairFootprints,
  stairFromClicks,
} from '../model/geometry';
import { HatchSwatch, hatchOf } from '../views/hatch';
import { ALL_VISIBLE, deleteExtras, findAnnotation, findRoom, hitExtras, layerOf, layersWith, similarElements, translateExtras, withoutLayers, LAYER_LABEL, type Layers } from '../model/layers';
import { roomShape } from '../model/rooms';
import { anchorAt } from '../model/anchors';
import { projectInState, STATUS_LABEL, VIEW_STATE_LABEL } from '../model/states';
import { AnnotationInspector, ContextMenu, LayersPanel, RoomInspector, type MenuItem } from './ModellazioneExtras';
import { applyHandle, dragEdge, dragHandle, dragMove, elementLevel, moveJoined, translated } from '../model/dragging';
import { columnUnder, copyElementsToLevel, deleteElements, elementOutlines, elementsInRect, getHandles, hitTestModel, nearestWall, snapModel, snapPoint, snapPoints, snapSegments, type Snap, type SnapCandidate, type SnapSegment } from '../model/edit';
import { Canvas2D, type CanvasPointer } from '../ui/Canvas2D';
import { PlanView, pts, type DimTarget } from '../views/PlanView';
import { ElevationView, elevationExtents, elevationHeight, type Direction } from '../views/ElevationView';
// la vista 3D (three.js) si carica alla prima apertura
const Model3D = lazy(() => import('../views/Model3D').then((m) => ({ default: m.Model3D })));
import { Icon } from '../ui/icons';
import { KeyHint, NumberField, Segmented, TextField } from '../ui/controls';
import { SectionMark, SectionView, sectionLength } from '../views/SectionView';
import { Inspector, TypeEditor, type CatalogKey } from './ModellazioneInspector';
import { applyDimension, computeDimensions, defaultSide, dimensionError, dimLines, layoutDimensions, segmentEdits, snapDimLine, type DimChain, type DimLine, type DimSide } from '../model/dimensions';
import { SCREEN_TEXT } from './Inquadramento';

/** Punto q riportato sull'orizzontale o sulla verticale per from, quella più vicina */
/** Rettangolo con i lati paralleli agli assi tra due angoli opposti, in senso antiorario */
const axisRect = (a: Vec2, b: Vec2): Vec2[] => {
  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const y1 = Math.max(a.y, b.y);
  return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
};

/** Il contorno è un rettangolo (tolti i vertici allineati)? Ne restituisce i quattro vertici */
function rectangleOf(poly: Vec2[] | undefined): Vec2[] | null {
  if (!poly || poly.length < 4) return null;
  const pts = poly.filter((q, i) => {
    const a = poly[(i + poly.length - 1) % poly.length];
    const b = poly[(i + 1) % poly.length];
    return Math.abs((q.x - a.x) * (b.y - q.y) - (q.y - a.y) * (b.x - q.x)) > 1e-6;
  });
  if (pts.length !== 4) return null;
  for (let i = 0; i < 4; i++) {
    const a = pts[(i + 3) % 4];
    const q = pts[i];
    const b = pts[(i + 1) % 4];
    const d1 = norm(sub(q, a));
    const d2 = norm(sub(b, q));
    if (Math.abs(dot(d1, d2)) > 1e-3) return null;
  }
  return pts;
}

const alignOrtho = (from: Vec2, q: Vec2): Vec2 => (Math.abs(q.x - from.x) >= Math.abs(q.y - from.y) ? { x: q.x, y: from.y } : { x: from.x, y: q.y });

export type Tool = 'select' | 'dividi' | 'taglia' | 'estendi' | 'cima' | 'sposta' | 'copia' | 'wall' | 'slab' | 'vault' | 'column' | 'beam' | 'door' | 'window' | 'stair' | 'roof' | 'section' | 'room' | 'quota' | 'testo' | 'altimetrica';

type ToolDef = { id: Tool; label: string; key: string; icon: string; catalog?: CatalogKey; hint: string };

const TOOLS: ToolDef[] = [
  { id: 'select', label: 'Seleziona', key: 'V', icon: 'select', hint: 'Clic per selezionare, trascina per spostare. Trascina le maniglie per modificare.' },
  { id: 'wall', label: 'Muro', key: 'M', icon: 'wall', catalog: 'wall', hint: 'Clic sui vertici del muro. Digita una lunghezza e premi Invio. Doppio clic o Esc per terminare.' },
  { id: 'slab', label: 'Solaio', key: 'S', icon: 'slab', catalog: 'slab', hint: 'Clic sui vertici del perimetro; clic sul primo punto o Invio per chiudere.' },
  { id: 'column', label: 'Pilastro', key: 'P', icon: 'column', catalog: 'column', hint: 'Clic per posizionare il pilastro.' },
  { id: 'beam', label: 'Trave', key: 'T', icon: 'beam', catalog: 'beam', hint: 'Clic su appoggio iniziale e finale.' },
  { id: 'door', label: 'Porta', key: 'O', icon: 'door', catalog: 'opening', hint: 'Avvicinati a un muro e clicca per inserire la porta. Alt inverte il verso.' },
  { id: 'window', label: 'Finestra', key: 'F', icon: 'window', catalog: 'opening', hint: 'Avvicinati a un muro e clicca per inserire la finestra.' },
  { id: 'stair', label: 'Scala', key: 'G', icon: 'stair', hint: 'Clic su partenza e arrivo della rampa: la scala sale al livello superiore.' },
  { id: 'roof', label: 'Copertura', key: 'C', icon: 'roof', catalog: 'roof', hint: 'Clic sui vertici della copertura, oppure usa «Copertura sull’edificio».' },
  { id: 'vault', label: 'Volta', key: 'B', icon: 'vault', catalog: 'vault', hint: 'Clic dentro un vano rettangolare chiuso dai muri, oppure clic su due angoli opposti del campo.' },
];

/** Strumenti non disponibili sul livello delle coperture */
const ROOF_LEVEL_OFF: Tool[] = ['door', 'window', 'stair', 'vault'];
/** Altezza dei parapetti disegnati sul livello delle coperture */
const ROOF_PARAPET = 1.1;

/** Prima lettera libera per una nuova sezione */
function nextSectionName(p: Project) {
  const used = new Set((p.sections ?? []).map((x) => x.name));
  return 'ABCDEFGHIJKLMNOPQRSTUVWZ'.split('').find((c) => !used.has(c)) ?? String(used.size + 1);
}

/** Le sezioni sono viste del progetto, non elementi costruttivi: stanno in un gruppo a parte */
const SECTION_TOOL: ToolDef = { id: 'section', label: 'Sezione', key: 'X', icon: 'section', hint: 'Clic su inizio e fine della traccia di sezione. Si guarda verso sinistra della traccia; nell’ispettore si inverte.' };

type ViewMode = 'pianta' | 'prospetti' | 'sezioni' | '3d' | 'affiancate';

/** Locali e annotazioni: non sono elementi costruttivi */
const EXTRA_TOOLS: ToolDef[] = [
  { id: 'room', label: 'Locale', key: 'L', icon: 'area', hint: 'Clic dentro un vano chiuso dai muri: nasce il locale con nome e superficie netta.' },
  { id: 'quota', label: 'Quota', key: 'Q', icon: 'path', hint: 'Clic sui due punti da quotare. La linea di quota si regola poi nell’ispettore.' },
  { id: 'testo', label: 'Testo', key: 'E', icon: 'edit', hint: 'Clic dove scrivere. Con Alt: primo clic sul punto da indicare, secondo clic sul testo (linea di richiamo).' },
  { id: 'altimetrica', label: 'Quota alt.', key: 'H', icon: 'level', hint: 'Clic per inserire la quota altimetrica del piano finito.' },
];
/** Comandi di modifica da CAD */
const EDIT_TOOLS: ToolDef[] = [
  { id: 'sposta', label: 'Sposta', key: 'W', icon: 'move', hint: 'Clic sul punto base e poi sul punto d’arrivo, oppure digita la distanza e Invio (verso del mouse). Senza selezione, il primo clic sceglie l’elemento.' },
  { id: 'copia', label: 'Copia', key: 'Y', icon: 'copy', hint: 'Clic sul punto base e poi su ogni punto dove copiare, oppure digita la distanza e Invio. Si copia più volte dallo stesso punto base; Esc per finire.' },
  { id: 'dividi', label: 'Dividi', key: 'D', icon: 'split', hint: 'Clic sul muro nel punto in cui dividerlo (si aggancia a incroci, punti medi e griglia).' },
  { id: 'taglia', label: 'Taglia', key: 'K', icon: 'trim', hint: 'Clic sul tratto di muro da togliere: si taglia agli assi dei muri che lo attraversano.' },
  { id: 'estendi', label: 'Estendi', key: 'J', icon: 'extend', hint: 'Clic vicino all’estremo del muro da allungare: prosegue fino all’asse del primo muro che incontra.' },
  { id: 'cima', label: 'Cima', key: 'I', icon: 'corner', hint: 'Clic su due muri: si allungano o si accorciano fino a chiudere l’angolo (come Cima con distanza 0). Di ogni muro resta la parte dove clicchi.' },
];
const WALL_EDIT: Tool[] = ['dividi', 'taglia', 'estendi'];

const ALL_TOOLS = () => [...TOOLS, SECTION_TOOL, ...EXTRA_TOOLS, ...EDIT_TOOLS];

function readLayers(): Layers {
  try {
    return { ...ALL_VISIBLE, ...JSON.parse(localStorage.getItem('pennino.layers') || '{}') };
  } catch {
    return ALL_VISIBLE;
  }
}

const NO_IDS: string[] = [];

interface Drag {
  kind: 'move' | 'handle' | 'lato' | 'opening' | 'sezione' | 'sezione-estremo' | 'quota' | 'quota-man';
  /** catena di quote trascinata */
  chain?: DimChain;
  /** linee di quota del livello all'inizio del trascinamento, per allinearsi */
  lines?: DimLine[];
  id: string;
  handle?: number;
  start: Vec2;
  orig: Project;
  moved: boolean;
  /** punti e lati di aggancio fissati all'inizio del trascinamento (senza l'elemento che si muove) */
  cands?: SnapCandidate[];
  segs?: SnapSegment[];
}

export function Modellazione() {
  const project = useStore((s) => s.project);
  const revision = useStore((s) => s.revision);
  const levelId = useStore((s) => s.activeLevelId);
  const setLevel = useStore((s) => s.setActiveLevel);
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const edit = useStore((s) => s.edit);
  const editLive = useStore((s) => s.editLive);
  const checkpoint = useStore((s) => s.checkpoint);
  const theme = useStore((s) => s.theme);

  const [tool, setTool] = useState<Tool>('select');
  const [view, setView] = useState<ViewMode>('pianta');
  const [activeType, setActiveType] = useState<Record<CatalogKey, string>>({
    wall: project.catalog.wall[0]?.id ?? '',
    slab: project.catalog.slab[0]?.id ?? '',
    column: project.catalog.column[0]?.id ?? '',
    beam: project.catalog.beam[0]?.id ?? '',
    opening: project.catalog.opening[0]?.id ?? '',
    roof: project.catalog.roof[0]?.id ?? '',
    vault: project.catalog.vault?.[0]?.id ?? '',
  });
  const [editingType, setEditingType] = useState<{ key: CatalogKey; id: string } | null>(null);
  // se una tipologia attiva viene eliminata, lo strumento passa alla prima disponibile
  useEffect(() => {
    setActiveType((a) => {
      let changed = false;
      const next = { ...a };
      for (const key of Object.keys(next) as CatalogKey[]) {
        const list = project.catalog[key] as { id: string }[];
        if (!list.some((t) => t.id === next[key])) {
          next[key] = list[0]?.id ?? '';
          changed = true;
        }
      }
      return changed ? next : a;
    });
    if (editingType && !(project.catalog[editingType.key] as { id: string }[]).some((t) => t.id === editingType.id)) setEditingType(null);
  }, [project.catalog, editingType]);
  const [draft, setDraft] = useState<Vec2[]>([]);
  const [cursor, setCursor] = useState<Snap | null>(null);
  const [typed, setTyped] = useState('');
  const drafting = useStore((s) => s.drafting);
  const setDrafting = useStore((s) => s.setDrafting);
  const ortho = drafting.ortho;
  const step = drafting.snapStep;
  // l'aggancio alla griglia funziona solo con la griglia visibile
  const grid = drafting.grid ? step : 0;
  const setOrtho = (v: boolean) => setDrafting({ ortho: v });
  const [ghost, setGhost] = useState(true);
  const [ghostAbove, setGhostAbove] = useState(false);
  // categorie visibili, bloccate o nascoste (ricordate tra le sessioni) e stato rappresentato
  const [layers, setLayersState] = useState<Layers>(readLayers);
  const setLayers = (l: Layers) => {
    setLayersState(l);
    try {
      localStorage.setItem('pennino.layers', JSON.stringify(l));
    } catch {
      /* preferenza non salvabile */
    }
  };
  const [viewState, setViewState] = useState<ViewState>('progetto');
  const [layersOpen, setLayersOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string | null; world?: Vec2 } | null>(null);
  // ciò che si vede (stato e categorie non nascoste) e ciò che si può prendere (non bloccato)
  const stateProject = projectInState(project, viewState);
  const viewProject = withoutLayers(stateProject, layersWith(layers, ['nascosto']));
  const pickProject = withoutLayers(stateProject, layersWith(layers, ['nascosto', 'bloccato']));
  // appunti per copiare elementi tra i livelli (Ctrl+C / Ctrl+V)
  const clipboard = useRef<string[]>([]);
  const setNotice = useStore((st) => st.setNotice);
  const [flipNext, setFlipNext] = useState(false);
  const [mirrorNext, setMirrorNext] = useState(false);
  // forma delle nuove scale
  const [stairShape, setStairShape] = useState<'dritta' | 'L' | 'U'>('dritta');
  const [vaultShape, setVaultShape] = useState<VaultShape>('botte');
  /** anteprima dei comandi sui muri: tratto da togliere, prolungamento, punto di divisione */
  const [wallEditPreview, setWallEditPreview] = useState<{ kind: 'taglia' | 'estendi' | 'dividi'; a: Vec2; b: Vec2 } | null>(null);
  /** Cima: primo muro scelto (con il punto del clic) e anteprima dei due muri a angolo chiuso */
  const [cimaFirst, setCimaFirst] = useState<{ id: string; q: Vec2 } | null>(null);
  const [cimaPreview, setCimaPreview] = useState<[Vec2, Vec2][] | null>(null);
  // linea di riferimento dei muri disegnati (ricordata tra le sessioni)
  const [wallRef, setWallRefState] = useState<WallRef>(() => {
    try {
      const v = localStorage.getItem('pennino.wallRef');
      return v === 'sinistra' || v === 'destra' ? v : 'asse';
    } catch {
      return 'asse';
    }
  });
  const setWallRef = (r: WallRef) => {
    setWallRefState(r);
    try {
      localStorage.setItem('pennino.wallRef', r);
    } catch {
      /* preferenza non salvabile */
    }
  };
  /** Muri della spezzata in corso, nell'ordine in cui sono stati disegnati */
  const chainIds = useRef<string[]>([]);
  const [stairTurn, setStairTurn] = useState<'sinistra' | 'destra'>('sinistra');
  const [openingPreview, setOpeningPreview] = useState<{ wallId: string; offset: number } | null>(null);
  const drag = useRef<Drag | null>(null);
  // selezione a riquadro: da sinistra a destra = finestra, da destra a sinistra = intersezione
  const [marquee, setMarquee] = useState<{ a: Vec2; b: Vec2; add: boolean } | null>(null);
  const [dimEdit, setDimEdit] = useState<DimTarget | null>(null);
  /** quale estremo del segmento si sposta scrivendo la misura */
  const [dimSide, setDimSide] = useState<DimSide | null>(null);
  /** catena di quote automatica selezionata (clic sulla sua linea): Canc la elimina */
  const [dimSel, setDimSel] = useState<string | null>(null);
  const [dimText, setDimText] = useState('');
  // stabile tra i render: la pianta memorizzata non si ridisegna al movimento del cursore
  const openDim = useCallback((t: DimTarget) => {
    setDimEdit(t);
    setDimSide(defaultSide(t.chain, t.k));
    setDimText(t.value.toFixed(2));
  }, []);
  const moveDim = useCallback((chain: DimChain) => {
    drag.current = { kind: 'quota', id: chain.id, start: chain.origin, orig: useStore.getState().project, moved: false, chain };
  }, []);
  const resetDim = useCallback(
    (chainId: string) =>
      edit((d) => {
        if (!d.dimOffsets) return;
        const next = { ...d.dimOffsets };
        delete next[chainId];
        d.dimOffsets = next;
      }),
    [edit],
  );
  const hideDim = useCallback(
    (chainId: string) => {
      edit((d) => void (d.hiddenDims = [...new Set([...(d.hiddenDims ?? []), chainId])]));
      setNotice('Quota eliminata: si ripristina con Ctrl+Z o dal pannello Vista.');
    },
    [edit, setNotice],
  );
  const commitDim = () => {
    const v = parseFloat(dimText.replace(',', '.'));
    if (dimEdit) {
      const why = dimensionError(project, dimEdit.chain, dimEdit.k, v, dimSide);
      if (why) setNotice(why);
      else edit((d) => applyDimension(d, dimEdit.chain, dimEdit.k, v, dimSide));
    }
    setDimEdit(null);
  };

  const levels = sortedLevels(project);
  const level = byId(project.levels, levelId) ?? levels[0];
  const lvlId = level?.id ?? '';
  const below = levels[levels.findIndex((l) => l.id === lvlId) - 1];
  const isRoofLevel = level?.kind === 'copertura';
  const above = levels[levels.findIndex((l) => l.id === lvlId) + 1];
  // passando al livello delle coperture, uno strumento non disponibile torna a Seleziona
  useEffect(() => {
    if (isRoofLevel && ROOF_LEVEL_OFF.includes(tool)) setTool('select');
  }, [isRoofLevel, tool]);
  const selectedIds = selection.scope === 'modello' ? selection.ids : NO_IDS;
  const toolDef = ALL_TOOLS().find((t) => t.id === tool)!;

  // Tipologie di aperture coerenti con lo strumento
  const openingCategory = tool === 'door' ? 'porta' : 'finestra';
  useEffect(() => {
    if (tool !== 'door' && tool !== 'window') return;
    const cur = byId(project.catalog.opening, activeType.opening);
    if (cur?.category !== openingCategory) {
      const first = project.catalog.opening.find((o) => o.category === openingCategory);
      if (first) setActiveType((a) => ({ ...a, opening: first.id }));
    }
  }, [tool, openingCategory, project.catalog.opening, activeType.opening]);

  const resetDraft = () => {
    setDraft([]);
    setTyped('');
    chainIds.current = [];
  };

  const changeTool = (t: Tool) => {
    setTool(t);
    resetDraft();
    setOpeningPreview(null);
    setWallEditPreview(null);
    setCimaFirst(null);
    setCimaPreview(null);
    if ((t === 'sposta' || t === 'copia') && !selectedIds.length) setNotice('Clic sull’elemento da ' + (t === 'sposta' ? 'spostare' : 'copiare') + ', poi sul punto base.');
    if (t !== 'select') setEditingType(null);
  };

  const bounds = useMemo(() => {
    const all: Vec2[] = [];
    for (const e of project.elements) all.push(...('levelId' in e ? getHandles(e) : []));
    const b = all.length ? bbox(all) : { minX: -5, minY: -5, maxX: 15, maxY: 12 };
    return { minX: b.minX - 3, minY: b.minY - 3, maxX: b.maxX + 3, maxY: b.maxY + 3 };
    // l'inquadratura iniziale dipende solo dal livello corrente
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lvlId]);

  // con il sottostante attivo si aggancia anche agli elementi del piano inferiore
  const refLevel = ghost && below && level?.kind !== 'copertura' ? below.id : null;
  // pilastri e travi del piano sotto si vedono sempre in pianta: ci si aggancia anche senza il sottostante
  const structLevel = below && level?.kind !== 'copertura' ? below.id : null;
  const belowStruct = useMemo(
    () => new Set(project.elements.filter((e) => (e.kind === 'column' || e.kind === 'beam') && e.levelId === structLevel).map((e) => e.id)),
    [project, structLevel],
  );
  const candidates = useMemo(
    () => [
      ...snapPoints(viewProject, lvlId),
      ...(refLevel ? snapPoints(viewProject, refLevel) : structLevel ? snapPoints(viewProject, structLevel).filter((c) => c.id && belowStruct.has(c.id)) : []),
    ],
    [viewProject, lvlId, refLevel, structLevel, belowStruct],
  );
  const segments = useMemo(
    () => [
      ...snapSegments(viewProject, lvlId),
      ...(refLevel ? snapSegments(viewProject, refLevel) : structLevel ? snapSegments(viewProject, structLevel).filter((g) => belowStruct.has(g.id)) : []),
    ],
    [viewProject, lvlId, refLevel, structLevel, belowStruct],
  );
  const columnLevels = (own: string) => [own, ...(structLevel && structLevel !== own ? [structLevel] : [])];

  // ───────── Appunti ─────────

  const copySelection = (ids: string[]) => {
    // si incolla su qualsiasi livello, nella stessa posizione
    clipboard.current = ids.filter((id) => project.elements.some((x) => x.id === id && x.kind !== 'opening'));
    setNotice(`${clipboard.current.length} elementi copiati: Ctrl+V per incollarli sul livello attivo.`);
  };
  const pasteClipboard = () => {
    const src = clipboard.current.filter((id) => project.elements.some((x) => x.id === id));
    if (!src.length) return;
    let made: string[] = [];
    edit((d) => {
      made = copyElementsToLevel(d, src, lvlId);
    });
    changeTool('select');
    select('modello', made);
    setNotice(`${made.length} elementi incollati su «${level?.name ?? ''}».`);
  };

  // ───────── Creazione elementi ─────────

  const addElement = (e: BuildingElement) => {
    // disegnando sullo stato di fatto nascono elementi esistenti
    const el = viewState === 'fatto' ? { ...e, status: 'esistente' as const } : e;
    edit((d) => {
      d.elements.push(el);
    });
    return e.id;
  };

  /** Locali e annotazioni: un clic (o due) e si torna a Seleziona con l'oggetto selezionato */
  const commitExtra = (q: Vec2, alt: boolean) => {
    const done = (id: string) => {
      select('modello', [id]);
      resetDraft();
      setTool('select');
    };
    if (tool === 'room') {
      if (!roomShape(viewProject, lvlId, q)) return setNotice('Qui i muri non chiudono un vano: il locale va inserito dentro un perimetro chiuso.');
      const id = uid('loc');
      const n = (project.rooms ?? []).filter((r) => r.levelId === lvlId).length + 1;
      edit((d) => void (d.rooms = [...(d.rooms ?? []), { id, levelId: lvlId, p: q, name: `Locale ${n}`, use: 'Altro' }]));
      return done(id);
    }
    if (tool === 'altimetrica') {
      const id = uid('an');
      edit((d) => void (d.annotations = [...(d.annotations ?? []), { id, kind: 'altimetrica', levelId: lvlId, p: q, dz: 0 }]));
      return done(id);
    }
    if (tool === 'quota') {
      if (!draft.length) return setDraft([q]);
      if (dist(draft[0], q) < 0.02) return;
      const id = uid('an');
      const a = draft[0];
      // ogni estremo si lega all'elemento su cui è stato agganciato: la quota lo seguirà
      const aRef = anchorAt(viewProject, lvlId, a) ?? undefined;
      const bRef = anchorAt(viewProject, lvlId, q) ?? undefined;
      edit((d) => void (d.annotations = [...(d.annotations ?? []), { id, kind: 'quota', levelId: lvlId, a, b: q, offset: 0.6, ...(aRef ? { aRef } : {}), ...(bRef ? { bRef } : {}) }]));
      return done(id);
    }
    // testo: con Alt il primo clic è il punto indicato dalla linea di richiamo
    if (alt && !draft.length) return setDraft([q]);
    const id = uid('an');
    const leader = draft[0];
    edit((d) => void (d.annotations = [...(d.annotations ?? []), { id, kind: 'testo', levelId: lvlId, p: q, text: 'Testo', ...(leader ? { leader } : {}) }]));
    done(id);
  };

  /** free: Maiusc premuto, l'ortogonale si inverte */
  const commitPoint = (q: Vec2, free = false) => {
    const pts2 = [...draft, q];
    if (tool === 'sposta' || tool === 'copia') {
      if (!draft.length) return setDraft([q]);
      const delta = sub(q, draft[0]);
      if (Math.hypot(delta.x, delta.y) < 1e-6) return;
      const ids = selectedIds.filter((id) => project.elements.some((x) => x.id === id && x.kind !== 'opening') || findRoom(project, id) || findAnnotation(project, id));
      if (tool === 'sposta') {
        edit((d) => moveElements(d, project, ids, delta));
        setNotice(`Spostati di ${fmt(Math.hypot(delta.x, delta.y), 2)} m.`);
        changeTool('select');
      } else {
        let made: string[] = [];
        edit((d) => {
          made = copyElements(d, ids, lvlId, delta);
        });
        // si resta nel comando: altre copie dallo stesso punto base
        setTyped('');
        setNotice(`${made.length} ${made.length === 1 ? 'copia' : 'copie'} a ${fmt(Math.hypot(delta.x, delta.y), 2)} m. Clic per un’altra copia, Esc per finire.`);
      }
      return;
    }
    if (tool === 'wall') {
      if (draft.length >= 1) {
        const last = draft[draft.length - 1];
        const closing = dist(q, draft[0]) < 0.01 && draft.length > 1;
        if (dist(last, q) > 0.01) {
          // i punti cliccati stanno sul filo di riferimento: l'asse si ricava di mezzo spessore
          const half = wallThickness(byId(project.catalog.wall, activeType.wall)) / 2;
          const axis = axisPolyline(closing ? draft : pts2, half, wallRef, closing);
          const k = draft.length - 1;
          const dir = norm(sub(q, last));
          let a = axis[k];
          let b = closing ? axis[0] : axis[k + 1];
          if (wallRef !== 'asse') {
            // su un muro esistente l'estremo arriva al suo asse: giunzione a T
            if (k === 0) a = extendToHost(viewProject, lvlId, a, mul(dir, -1));
            if (!closing) b = extendToHost(viewProject, lvlId, b, dir);
          }
          const id = uid('w');
          const prevId = chainIds.current[chainIds.current.length - 1];
          const firstId = chainIds.current[0];
          edit((d) => {
            d.elements.push({
              id,
              kind: 'wall',
              levelId: lvlId,
              typeId: activeType.wall,
              a,
              b,
              ...(wallRef !== 'asse' ? { ref: wallRef } : {}),
              // sul livello delle coperture il muro è un parapetto
              ...(isRoofLevel ? { height: ROOF_PARAPET } : {}),
              ...(viewState === 'fatto' ? { status: 'esistente' as const } : {}),
            });
            if (wallRef === 'asse') return;
            // il muro precedente finisce nel nuovo vertice d'asse; chiudendo, anche il primo
            const pw = prevId && d.elements.find((x) => x.id === prevId);
            if (pw && pw.kind === 'wall') pw.b = a;
            const fw = closing && firstId && d.elements.find((x) => x.id === firstId);
            if (fw && fw.kind === 'wall') fw.a = b;
          });
          chainIds.current = [...chainIds.current, id];
        }
        if (closing) return resetDraft();
      }
      setDraft(pts2);
    } else if (tool === 'slab' || tool === 'roof') {
      if (draft.length >= 3 && dist(q, draft[0]) < 0.01) return finishPolygon(draft);
      setDraft(pts2);
    } else if (tool === 'vault') {
      if (!draft.length) {
        // clic dentro un vano rettangolare: la volta prende il filo interno dei muri
        const field = rectangleOf(roomShape(viewProject, lvlId, q)?.net);
        if (field) return addVault(field);
        return setDraft([q]);
      }
      // secondo angolo: campo con i lati paralleli agli assi
      if (Math.abs(q.x - draft[0].x) > 0.3 && Math.abs(q.y - draft[0].y) > 0.3) addVault(axisRect(draft[0], q));
      resetDraft();
    } else if (tool === 'beam' || tool === 'stair') {
      if (draft.length === 1) {
        if (dist(draft[0], q) > 0.1) {
          if (tool === 'beam') addElement({ id: uid('b'), kind: 'beam', levelId: lvlId, typeId: activeType.beam, a: draft[0], b: q });
          else
            addElement(
              // a L e a U la lunghezza disegnata fissa le alzate della prima rampa, non la pedata
              stairFromClicks(project, {
                id: uid('sc'),
                kind: 'stair' as const,
                levelId: lvlId,
                a: draft[0],
                b: q,
                width: 1.1,
                ...(stairShape === 'dritta' ? {} : { shape: stairShape, turn: stairTurn }),
              }),
            );
        }
        resetDraft();
      } else setDraft([q]);
    } else if (tool === 'section') {
      if (draft.length === 1) {
        // anche se il punto si è agganciato a un oggetto fuori asse, la traccia resta ortogonale
        if (ortho !== free) q = alignOrtho(draft[0], q);
        if (dist(draft[0], q) > 0.5) {
          const id = uid('sez');
          const name = nextSectionName(project);
          edit((d) => {
            d.sections = [...(d.sections ?? []), { id, name, a: draft[0], b: q, depth: 40, flip: false }];
          });
          select('modello', [id]);
          setTool('select');
        }
        resetDraft();
      } else setDraft([q]);
    } else if (tool === 'column') {
      addElement({ id: uid('c'), kind: 'column', levelId: lvlId, typeId: activeType.column, p: q });
    }
    setTyped('');
  };

  const addVault = (points: Vec2[]) => {
    const id = addElement({ id: uid('v'), kind: 'vault', levelId: lvlId, typeId: activeType.vault, ...defaultVault(project, lvlId, points, vaultShape, activeType.vault) });
    select('modello', [id]);
  };

  const finishPolygon = (poly: Vec2[]) => {
    if (poly.length < 3) return resetDraft();
    if (tool === 'slab') addElement({ id: uid('s'), kind: 'slab', levelId: lvlId, typeId: activeType.slab, points: poly });
    else {
      // disegnata da un piano, la copertura va sul livello delle coperture alla sua imposta (se c'è)
      const top = level ? level.elevation + level.height : NaN;
      const roofLvl = level?.kind === 'copertura' ? lvlId : levels.find((l) => l.kind === 'copertura' && Math.abs(l.elevation - top) < 0.01)?.id ?? lvlId;
      addElement({ id: uid('r'), kind: 'roof', levelId: roofLvl, typeId: activeType.roof, points: poly, shape: 'falde', pitch: 22, overhang: 0.5 });
    }
    resetDraft();
  };

  /** Perimetro dei muri del livello corrente → nuovo solaio o copertura */
  const fromWalls = (kind: 'slab' | 'roof') => {
    // muri del livello; sul livello delle coperture si usano quelli del piano sottostante
    const wallsOf = (id: string) => project.elements.flatMap((e) => (e.kind === 'wall' && e.levelId === id ? [e.a, e.b] : []));
    let q = wallsOf(lvlId);
    let wallLevel = level;
    if (q.length < 3 && below) {
      q = wallsOf(below.id);
      wallLevel = below;
    }
    if (q.length < 3) return;
    const hull = convexHull(q);
    // la copertura va sul livello delle coperture che sta all'imposta di quei muri, se esiste
    const roofLevel =
      levels.find((l) => l.kind === 'copertura' && wallLevel && Math.abs(l.elevation - (wallLevel.elevation + wallLevel.height)) < 0.01)?.id ?? lvlId;
    const id =
      kind === 'slab'
        ? addElement({ id: uid('s'), kind: 'slab', levelId: lvlId, typeId: activeType.slab, points: hull })
        : addElement({ id: uid('r'), kind: 'roof', levelId: roofLevel, typeId: activeType.roof, points: hull, shape: 'falde', pitch: 22, overhang: 0.5 });
    select('modello', [id]);
    changeTool('select');
  };

  // ───────── Puntatore ─────────

  const onPointer = (e: CanvasPointer) => {
    const tol = 10 / e.zoom;
    const last = draft[draft.length - 1];
    const snapOpts = {
      candidates: [...candidates, ...draft.slice(0, 1).map((p) => ({ p, kind: 'estremo' as const }))],
      tol,
      grid: e.zoom > 120 ? Math.min(grid, 0.01) : grid,
      from: tool === 'select' ? undefined : last,
      ortho: ortho !== e.shift,
    };
    // Alt sospende l'aggancio agli oggetti (resta griglia/ortogonale)
    // muri e travi si agganciano agli assi (le giunzioni a T e ad L nascono sull'asse), il resto anche a facce e spigoli
    const axial = tool === 'beam' || (tool === 'wall' && wallRef === 'asse');
    // travi e muri: assi, più i lati dei pilastri (ci si attesta sul bordo del pilastro, restando sull'asse)
    const drawOpts = axial ? { ...snapOpts, candidates: snapOpts.candidates.filter((c) => c.kind !== 'spigolo') } : snapOpts;
    // travi e muri sopra un pilastro: l'estremo va al centro del pilastro (piano e sottostante)
    const onColumn = axial && !e.alt ? columnUnder(project, columnLevels(lvlId), e.world) : null;
    const snap = onColumn
      ? onColumn
      : tool === 'select' || e.alt
        ? snapPoint(e.world, drawOpts)
        : snapModel(e.world, { ...drawOpts, segments: axial ? segments.filter((g) => !g.face || g.column) : segments });

    if (menu) setMenu(null);
    if (tool === 'select') return handleSelect(e, snap, tol);

    if (WALL_EDIT.includes(tool)) {
      setCursor(tool === 'dividi' ? snap : { p: e.world, kind: 'libero' });
      const nw = nearestWall(pickProject, tool === 'dividi' ? snap.p : e.world, lvlId, tol * 1.5 + 0.3);
      const w = nw && project.elements.find((x): x is Wall => x.kind === 'wall' && x.id === nw.id);
      if (!w) return setWallEditPreview(null);
      const sAt = wallStation(w, tool === 'dividi' ? snap.p : e.world);
      const at = (sv: number) => add(w.a, mul(norm(sub(w.b, w.a)), sv));
      if (e.type === 'move') {
        if (tool === 'taglia') {
          const pc = trimPiece(project, w, sAt);
          setWallEditPreview(pc ? { kind: 'taglia', a: at(pc[0]), b: at(pc[1]) } : null);
        } else if (tool === 'estendi') {
          const end = dist(e.world, w.a) <= dist(e.world, w.b) ? 'a' : 'b';
          const tq = extendTarget(project, w, end);
          setWallEditPreview(tq ? { kind: 'estendi', a: end === 'a' ? w.a : w.b, b: tq } : null);
        } else {
          const q = at(sAt);
          const n = mul({ x: -(w.b.y - w.a.y), y: w.b.x - w.a.x }, 0.5 / (wallLength(w) || 1));
          setWallEditPreview({ kind: 'dividi', a: sub(q, n), b: add(q, n) });
        }
        return;
      }
      if (e.type !== 'down' || e.button !== 0) return;
      let msg = '';
      edit((d) => {
        const r = tool === 'dividi' ? splitWall(d, w.id, sAt) : tool === 'taglia' ? trimWall(d, w.id, sAt) : extendWall(d, w.id, e.world);
        if ('error' in r) msg = r.error;
        else if ('added' in r) msg = `Muro allungato di ${fmt(r.added, 2)} m.`;
        else if ('removed' in r) msg = `Tolto un tratto di ${fmt(r.removed, 2)} m${r.openings ? ` con ${r.openings} ${r.openings === 1 ? 'apertura' : 'aperture'}` : ''}.`;
        else msg = `Muro diviso a ${fmt(sAt, 2)} m dall’inizio.`;
      });
      setWallEditPreview(null);
      setNotice(msg);
      return;
    }

    if (tool === 'cima') {
      setCursor({ p: e.world, kind: 'libero' });
      const nw = nearestWall(pickProject, e.world, lvlId, tol * 1.5 + 0.3);
      const w = nw && project.elements.find((x): x is Wall => x.kind === 'wall' && x.id === nw.id);
      const first = cimaFirst && project.elements.find((x): x is Wall => x.kind === 'wall' && x.id === cimaFirst.id);
      if (e.type === 'move') {
        if (first && w && w.id !== first.id) {
          const x = axisCrossing(first, w);
          if (x) {
            const e1 = cornerEnds(first, x, cimaFirst!.q);
            const e2 = cornerEnds(w, x, e.world);
            return setCimaPreview([[e1.a, e1.b], [e2.a, e2.b]]);
          }
        }
        setCimaPreview(first ? [[first.a, first.b]] : null);
        return;
      }
      if (e.type !== 'down' || e.button !== 0 || !w) return;
      if (!cimaFirst) {
        setCimaFirst({ id: w.id, q: e.world });
        setCimaPreview([[w.a, w.b]]);
        setNotice('Ora clic sul secondo muro.');
        return;
      }
      let msg = 'Angolo chiuso.';
      edit((d) => {
        const r = cornerWalls(d, cimaFirst.id, cimaFirst.q, w.id, e.world);
        if ('error' in r) msg = r.error;
        else if (r.openings) msg = `Angolo chiuso: ${r.openings} ${r.openings === 1 ? 'apertura rimasta fuori dal muro è stata eliminata' : 'aperture rimaste fuori dal muro sono state eliminate'}.`;
      });
      setCimaFirst(null);
      setCimaPreview(null);
      setNotice(msg);
      return;
    }

    if (tool === 'sposta' || tool === 'copia') {
      setCursor(snap);
      if (e.type !== 'down' || e.button !== 0) return;
      // senza selezione: il primo clic sceglie l'elemento
      if (!selectedIds.length) {
        const id = hitTestModel(pickProject, e.world, lvlId, tol);
        if (id && project.elements.find((x) => x.id === id)?.kind !== 'opening') {
          select('modello', [id]);
          setNotice('Ora clic sul punto base.');
        }
        return;
      }
      commitPoint(snap.p);
      return;
    }

    if (tool === 'room' || tool === 'quota' || tool === 'testo' || tool === 'altimetrica') {
      // il locale va dove si clicca; le annotazioni si agganciano agli oggetti
      const q = tool === 'room' || tool === 'testo' ? { p: e.world, kind: 'libero' as const } : snapModel(e.world, { ...snapOpts, from: undefined, ortho: false, segments });
      setCursor(q);
      if (e.type === 'down' && e.button === 0) commitExtra(q.p, e.alt);
      return;
    }

    if (tool === 'door' || tool === 'window') {
      const nw = nearestWall(project, e.world, lvlId, 0.4);
      const t = byId(project.catalog.opening, activeType.opening);
      if (nw && t) {
        const wall = project.elements.find((x) => x.id === nw.id);
        const L = wall && wall.kind === 'wall' ? wallLength(wall) : 0;
        // posizione lungo il muro: al passo della griglia se accesa, altrimenti libera
        const offset = Math.min(L - t.width / 2, Math.max(t.width / 2, grid > 0 ? Math.round(nw.offset / grid) * grid : nw.offset));
        setOpeningPreview({ wallId: nw.id, offset });
        if (e.type === 'down' && e.button === 0) {
          const id = uid('o');
          edit((d) => {
            d.elements.push({ id, kind: 'opening', wallId: nw.id, typeId: t.id, offset, flip: flipNext !== e.alt, mirror: mirrorNext });
          });
        }
      } else setOpeningPreview(null);
      setCursor({ p: e.world, kind: 'libero' });
      return;
    }

    setCursor(snap);
    if (e.type === 'down' && e.button === 0) commitPoint(snap.p, e.shift);
    if (e.type === 'dblclick') {
      if (tool === 'slab' || tool === 'roof') finishPolygon(draft.slice(0, -1).length >= 3 ? draft.slice(0, -1) : draft);
      else resetDraft();
    }
  };

  const handleSelect = (e: CanvasPointer, snap: Snap, tol: number) => {
    if (e.type === 'down' && e.button === 0) {
      setDimSel(null);
      // maniglie dell'elemento selezionato
      for (const id of selectedIds) {
        const el = project.elements.find((x) => x.id === id);
        if (!el || el.kind === 'opening') continue;
        const hs = getHandles(el);
        const hi = hs.findIndex((h) => dist(h, e.world) < tol);
        if (hi >= 0) {
          drag.current = { kind: 'handle', id, handle: hi, start: e.world, orig: project, moved: false };
          return;
        }
        // solai e coperture: maniglie a metà dei lati per spostare un lato parallelamente
        if (el.kind === 'slab' || el.kind === 'roof') {
          const n = el.points.length;
          const li = el.points.findIndex((q, i) => dist(mul(add(q, el.points[(i + 1) % n]), 0.5), e.world) < tol);
          if (li >= 0) {
            drag.current = { kind: 'lato', id, handle: li, start: e.world, orig: project, moved: false };
            return;
          }
        }
      }
      // tracce di sezione: estremi e linea
      for (const sec of project.sections ?? []) {
        if (!selectedIds.includes(sec.id)) continue;
        const hi = [sec.a, sec.b].findIndex((h) => dist(h, e.world) < tol);
        if (hi >= 0) {
          drag.current = { kind: 'sezione-estremo', id: sec.id, handle: hi, start: e.world, orig: project, moved: false };
          return;
        }
      }
      const secHit = (project.sections ?? []).find((sec) => projectOnSegment(e.world, sec.a, sec.b).d < tol);
      // locali e annotazioni si prendono dalla loro etichetta, prima degli elementi sotto
      const extra = hitExtras(pickProject, lvlId, e.world, tol);
      if (extra) {
        if (e.shift) select('modello', selectedIds.includes(extra) ? selectedIds.filter((x) => x !== extra) : [...selectedIds, extra]);
        else if (!selectedIds.includes(extra)) select('modello', [extra]);
        // una quota disegnata a mano si sposta allontanando la sua linea: i punti misurati restano fermi
        const isQuota = findAnnotation(project, extra)?.kind === 'quota';
        drag.current = { kind: isQuota && !e.shift ? 'quota-man' : 'move', id: extra, start: e.world, orig: project, moved: false };
        setEditingType(null);
        return;
      }
      const hit = hitTestModel(pickProject, e.world, lvlId, tol);
      if (secHit && !hit) {
        select('modello', [secHit.id]);
        drag.current = { kind: 'sezione', id: secHit.id, start: snap.p, orig: project, moved: false };
        setEditingType(null);
        return;
      }
      if (hit) {
        if (e.shift) {
          select('modello', selectedIds.includes(hit) ? selectedIds.filter((x) => x !== hit) : [...selectedIds, hit]);
        } else if (!selectedIds.includes(hit)) select('modello', [hit]);
        const el = project.elements.find((x) => x.id === hit);
        drag.current = { kind: el?.kind === 'opening' ? 'opening' : 'move', id: hit, start: snap.p, orig: project, moved: false };
        setEditingType(null);
      } else {
        // clic nel vuoto: inizia un riquadro di selezione
        setMarquee({ a: e.world, b: e.world, add: e.shift });
        if (!e.shift) select('modello', []);
      }
      return;
    }
    if (e.type === 'move' && marquee) {
      setMarquee({ ...marquee, b: e.world });
      return;
    }
    if (e.type === 'up' && marquee) {
      const m = marquee;
      setMarquee(null);
      if (dist(m.a, m.b) > tol) {
        const r = { minX: Math.min(m.a.x, m.b.x), minY: Math.min(m.a.y, m.b.y), maxX: Math.max(m.a.x, m.b.x), maxY: Math.max(m.a.y, m.b.y) };
        const found = elementsInRect(pickProject, lvlId, r, m.b.x < m.a.x);
        select('modello', m.add ? [...new Set([...selectedIds, ...found])] : found);
      }
      return;
    }
    if (e.type === 'move') {
      setCursor({ p: snap.p, kind: 'libero' });
      const dr = drag.current;
      if (!dr) return;
      if (dr.kind === 'quota' || dr.kind === 'quota-man') {
        const unit = (3 / e.zoom) * SCREEN_TEXT;
        if (!dr.lines) {
          // le linee di quota come sono all'inizio, dove si vedono
          const src = projectInState(dr.orig, viewState);
          const hiddenSet = new Set(src.hiddenDims ?? []);
          const placed = layers.quote === 'nascosto' ? [] : layoutDimensions(computeDimensions(src, lvlId).filter((c) => !hiddenSet.has(c.id)), unit, src.dimOffsets);
          dr.lines = dimLines(placed, src.annotations, lvlId, unit);
        }
        if (dr.kind === 'quota' && dr.chain) {
          // catena di quote: la linea segue il cursore, a passi di mezzo millimetro di carta, e si allinea alle altre
          const c = dr.chain;
          const raw = dot(sub(e.world, c.origin), c.out);
          const sn = e.alt ? { value: raw, to: null } : snapDimLine(raw, c.origin, c.dir, c.out, dr.lines, c.id, tol);
          // anche dall'altra parte dell'elemento (distanza negativa), ma non sopra di esso
          let off = sn.to ? sn.value / unit : Math.round((raw / unit) * 2) / 2;
          if (Math.abs(off) < 1.5) off = off < 0 ? -1.5 : 1.5;
          if (!dr.moved) {
            checkpoint();
            dr.moved = true;
          }
          setCursor(sn.to ? { p: e.world, kind: 'allineamento' } : null);
          editLive((d) => void (d.dimOffsets = { ...(d.dimOffsets ?? {}), [c.id]: off }));
          return;
        }
        // quota disegnata a mano: cambia la distanza della linea dai punti misurati
        const n0 = findAnnotation(dr.orig, dr.id);
        if (!n0 || n0.kind !== 'quota') return;
        if (!dr.moved) {
          if (dist(e.world, dr.start) < tol * 0.5) return;
          checkpoint();
          dr.moved = true;
        }
        const d0 = norm(sub(n0.b, n0.a));
        const nrm = { x: -d0.y, y: d0.x };
        const raw = dot(sub(e.world, n0.a), nrm);
        const sn = e.alt ? { value: raw, to: null } : snapDimLine(raw, n0.a, d0, nrm, dr.lines, n0.id, tol);
        const step = grid > 0 ? grid : 0.05;
        const off = sn.to ? sn.value : Math.round(raw / step) * step;
        setCursor(sn.to ? { p: e.world, kind: 'allineamento' } : null);
        editLive((d) => {
          const x = findAnnotation(d, dr.id);
          if (x && x.kind === 'quota') x.offset = +off.toFixed(4);
        });
        return;
      }
      if (!dr.moved) {
        if (dist(e.world, dr.start) < tol * 0.5) return;
        checkpoint();
        dr.moved = true;
        dr.cands = candidates;
        dr.segs = segments;
      }
      const o = dr.orig;
      if (dr.kind === 'opening') {
        const op = o.elements.find((x) => x.id === dr.id);
        if (!op || op.kind !== 'opening') return;
        const wall = o.elements.find((x) => x.id === op.wallId);
        const t = byId(o.catalog.opening, op.typeId);
        if (!wall || wall.kind !== 'wall' || !t) return;
        const L = wallLength(wall);
        const dir = norm(sub(wall.b, wall.a));
        const s = (e.world.x - wall.a.x) * dir.x + (e.world.y - wall.a.y) * dir.y;
        const offset = Math.min(L - t.width / 2, Math.max(t.width / 2, grid > 0 ? Math.round(s / grid) * grid : s));
        editLive((d) => {
          const x = d.elements.find((q) => q.id === dr.id);
          if (x && x.kind === 'opening') x.offset = offset;
        });
        return;
      }
      if (dr.kind === 'sezione' || dr.kind === 'sezione-estremo') {
        const src = (o.sections ?? []).find((x) => x.id === dr.id);
        if (!src) return;
        const rawS = sub(snap.p, dr.start);
        const delta = dr.kind === 'sezione' && ortho !== e.shift ? (Math.abs(rawS.x) >= Math.abs(rawS.y) ? { x: rawS.x, y: 0 } : { x: 0, y: rawS.y }) : rawS;
        editLive((d) => {
          const x = (d.sections ?? []).find((q) => q.id === dr.id);
          if (!x) return;
          if (dr.kind === 'sezione') {
            x.a = add(src.a, delta);
            x.b = add(src.b, delta);
          } else {
            // con l'ortogonale la traccia resta orizzontale o verticale rispetto all'altro estremo
            const q = ortho !== e.shift ? alignOrtho(dr.handle === 0 ? src.b : src.a, snap.p) : snap.p;
            if (dr.handle === 0) x.a = q;
            else x.b = q;
          }
        });
        return;
      }
      // agganci fissati a inizio trascinamento (senza seguire ciò che si muove) e impostazioni di disegno
      const ctx = { candidates: dr.cands ?? candidates, segments: dr.segs ?? segments, tol, grid, ortho: ortho !== e.shift, alt: e.alt };
      if (dr.kind === 'lato') {
        const r = dragEdge(o, dr.id, dr.handle!, dr.start, e.world, ctx);
        if (!r) return;
        setCursor(r.snap);
        editLive((d) => {
          const x = d.elements.find((q) => q.id === dr.id);
          if (!x || (x.kind !== 'slab' && x.kind !== 'roof')) return;
          for (const [k, p] of r.points) x.points[k] = p;
        });
        return;
      }
      if (dr.kind === 'handle') {
        const r = dragHandle(o, dr.id, dr.handle!, e.world, { ...ctx, columnLevels: columnLevels(elementLevel(o, dr.id) ?? lvlId) });
        if (!r) return;
        setCursor(r.snap);
        editLive((d) => {
          applyHandle(d, dr.id, dr.handle!, r.snap.p);
          if (r.element.kind === 'wall') moveJoined(d, o, r.element.levelId, dr.id, [r.from], sub(r.snap.p, r.from));
        });
        return;
      }
      // spostamento dell'elemento (o della selezione)
      const ids = selectedIds.includes(dr.id) ? selectedIds : [dr.id];
      const delta = dragMove(dr.start, e.world, ids, { ...ctx, grid: e.zoom > 120 ? Math.min(grid, 0.01) : grid });
      editLive((d) => {
        for (const id of ids) {
          const src = o.elements.find((q) => q.id === id);
          const x = d.elements.findIndex((q) => q.id === id);
          if (!src || x < 0 || src.kind === 'opening') continue;
          d.elements[x] = translated(src, delta);
          if (src.kind === 'wall' && ids.length === 1) moveJoined(d, o, src.levelId, id, [src.a, src.b], delta);
        }
        translateExtras(d, o, ids, delta);
      });
      return;
    }
    if (e.type === 'up') {
      // il segno «Allineata» non resta sullo schermo a trascinamento finito
      if (drag.current?.kind === 'quota' || drag.current?.kind === 'quota-man') setCursor(null);
      // clic sulla linea senza trascinare: la catena si seleziona
      if (drag.current?.kind === 'quota' && !drag.current.moved) {
        setDimSel(drag.current.id);
        select('modello', []);
      }
      drag.current = null;
    }
  };

  // ───────── Tastiera ─────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA') return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        // seleziona tutto il livello
        e.preventDefault();
        changeTool('select');
        select('modello', elementsInRect(pickProject, lvlId, { minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 }, false));
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && selectedIds.length) {
        // copia la selezione (si incolla su qualsiasi livello, nella stessa posizione)
        copySelection(selectedIds);
        e.preventDefault();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && clipboard.current.length) {
        e.preventDefault();
        pasteClipboard();
        return;
      }
      if (e.ctrlKey || e.metaKey) return;
      const k = e.key;
      if (draft.length > 0 && /^[0-9.,]$/.test(k)) {
        setTyped((t) => t + (k === ',' ? '.' : k));
        e.preventDefault();
        return;
      }
      if (k === 'Backspace' && typed) {
        setTyped((t) => t.slice(0, -1));
        e.preventDefault();
        return;
      }
      if (k === 'Enter') {
        if (typed && draft.length && cursor) {
          const lenV = parseFloat(typed);
          const last = draft[draft.length - 1];
          let dir = norm(sub(cursor.p, last));
          if (!isFinite(dir.x) || (dir.x === 0 && dir.y === 0)) dir = { x: 1, y: 0 };
          if (lenV > 0) commitPoint(add(last, mul(dir, lenV)));
          setTyped('');
        } else if (tool === 'slab' || tool === 'roof') finishPolygon(draft);
        else resetDraft();
        return;
      }
      if (k === 'Escape') {
        if (draft.length) resetDraft();
        else if (tool !== 'select') changeTool('select');
        else select('modello', []);
        return;
      }
      if ((k === 'Delete' || k === 'Backspace') && dimSel) {
        // le quote automatiche non si cancellano dal modello: si nascondono (ripristinabili da Vista)
        hideDim(dimSel);
        setDimSel(null);
        return;
      }
      if ((k === 'Delete' || k === 'Backspace') && selectedIds.length) {
        edit((d) => {
          deleteElements(d, selectedIds);
          if (d.sections) d.sections = d.sections.filter((x) => !selectedIds.includes(x.id));
          deleteExtras(d, selectedIds);
        });
        select('modello', []);
        return;
      }
      if (k === 'F8') {
        setOrtho(!ortho);
        return;
      }
      if (tool === 'wall' && k.toLowerCase() === 'r') {
        // R: riferimento successivo (asse → filo sinistro → filo destro)
        const order: WallRef[] = ['asse', 'sinistra', 'destra'];
        const next = order[(order.indexOf(wallRef) + 1) % order.length];
        setWallRef(next);
        setNotice(`Riferimento del muro: ${WALL_REF_LABEL[next].toLowerCase()}`);
        return;
      }
      const t = ALL_TOOLS().find((x) => x.key.toLowerCase() === k.toLowerCase());
      if (t && !(isRoofLevel && ROOF_LEVEL_OFF.includes(t.id))) changeTool(t.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ───────── Rendering ─────────

  const last = draft[draft.length - 1];
  const previewLen = last && cursor ? dist(last, cursor.p) : 0;
  const catKey = toolDef.catalog;
  const typeList = catKey
    ? (project.catalog[catKey] as { id: string; name: string; category?: string }[]).filter(
        (t) => catKey !== 'opening' || t.category === openingCategory,
      )
    : [];

  // ───────── Menu contestuale ─────────

  const menuTitle = (id: string | null) => {
    if (!id) return level?.name ?? 'Pianta';
    if (id.startsWith('quota:')) return 'Quota automatica';
    const el = project.elements.find((x) => x.id === id);
    if (el) return selectedIds.length > 1 && selectedIds.includes(id) ? `${selectedIds.length} elementi` : elementCode(project, el);
    return findRoom(project, id)?.name ?? 'Annotazione';
  };
  const menuItems = (id: string | null): MenuItem[] => {
    if (id?.startsWith('quota:')) {
      const cid = id.slice(6);
      return [
        { label: 'Elimina questa quota (Canc)', danger: true, onClick: () => (hideDim(cid), setDimSel(null)) },
        { label: 'Rimetti al suo posto', disabled: !(project.dimOffsets ?? {})[cid], onClick: () => resetDim(cid) },
        { label: 'Ripristina le quote eliminate', disabled: !(project.hiddenDims ?? []).length, onClick: () => edit((d) => void (d.hiddenDims = [])) },
      ];
    }
    const hideLayer = (k: keyof Layers, mode: 'bloccato' | 'nascosto') => {
      setLayers({ ...layers, [k]: mode });
      select('modello', []);
    };
    if (!id) {
      const off = layersWith(layers, ['nascosto', 'bloccato']).length > 0;
      return [
        { label: 'Seleziona tutto', onClick: () => select('modello', elementsInRect(pickProject, lvlId, { minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 }, false)) },
        { label: 'Incolla sul livello', disabled: !clipboard.current.length, onClick: pasteClipboard },
        { label: 'Mostra e sblocca tutte le categorie', disabled: !off, onClick: () => setLayers(ALL_VISIBLE) },
        { label: 'Pannello Vista…', onClick: () => setLayersOpen(true) },
      ];
    }
    const targets = selectedIds.includes(id) ? selectedIds : [id];
    const remove = () => {
      edit((d) => {
        deleteElements(d, targets);
        if (d.sections) d.sections = d.sections.filter((x) => !targets.includes(x.id));
        deleteExtras(d, targets);
      });
      select('modello', []);
    };
    const el = project.elements.find((x) => x.id === id);
    if (!el) {
      const k = findRoom(project, id) ? 'locali' : 'annotazioni';
      return [
        { label: `Nascondi «${LAYER_LABEL[k]}»`, onClick: () => hideLayer(k, 'nascosto') },
        { label: 'Elimina', danger: true, onClick: remove },
      ];
    }
    const k = layerOf(el);
    const setStatus = (st: ElementStatus) =>
      edit((d) => {
        for (const x of d.elements)
          if (targets.includes(x.id)) {
            if (st === 'nuovo') delete x.status;
            else x.status = st;
          }
      });
    const wallHere = el.kind === 'wall' && menu?.world ? el : null;
    const runWall = (fn: (d: Project) => { error: string } | object, ok: string) => {
      let msg = ok;
      edit((d) => {
        const r = fn(d);
        if ('error' in r) msg = r.error;
      });
      setNotice(msg);
    };
    return [
      ...(wallHere && menu?.world
        ? [
            { label: 'Dividi qui', onClick: () => runWall((d) => splitWall(d, wallHere.id, wallStation(wallHere, menu.world!)), 'Muro diviso.') },
            { label: 'Taglia questo tratto', onClick: () => runWall((d) => trimWall(d, wallHere.id, wallStation(wallHere, menu.world!)), 'Tratto tolto.') },
            { label: 'Estendi fino al muro', onClick: () => runWall((d) => extendWall(d, wallHere.id, menu.world!), 'Muro allungato.') },
            {
              label: 'Cima con un altro muro…',
              onClick: () => {
                changeTool('cima');
                setCimaFirst({ id: wallHere.id, q: menu.world! });
                setCimaPreview([[wallHere.a, wallHere.b]]);
                setNotice('Ora clic sul secondo muro.');
              },
            },
          ]
        : []),
      { label: 'Sposta… (W)', onClick: () => changeTool('sposta') },
      { label: 'Copia… (Y)', onClick: () => changeTool('copia') },
      { label: 'Seleziona simili sul livello', onClick: () => select('modello', similarElements(pickProject, id)) },
      { label: 'Copia (Ctrl+C)', onClick: () => copySelection(targets) },
      ...(['nuovo', 'esistente', 'demolito'] as ElementStatus[]).map((st) => ({ label: `Stato: ${STATUS_LABEL[st].toLowerCase()}`, onClick: () => setStatus(st) })),
      { label: `Blocca «${LAYER_LABEL[k]}»`, onClick: () => hideLayer(k, 'bloccato') },
      { label: `Nascondi «${LAYER_LABEL[k]}»`, onClick: () => hideLayer(k, 'nascosto') },
      { label: 'Elimina (Canc)', danger: true, onClick: remove },
    ];
  };

  const planCanvas = (
    <Canvas2D
      bounds={bounds}
      onPointer={onPointer}
      cursor={tool === 'select' ? 'default' : 'crosshair'}
      ortho
      onMenu={(m) => {
        const tolM = 10 / m.zoom;
        // tasto destro su una linea di quota automatica: menu della catena
        if (layers.quote !== 'nascosto') {
          const unit = (3 / m.zoom) * SCREEN_TEXT;
          const hiddenSet = new Set(viewProject.hiddenDims ?? []);
          const placed = layoutDimensions(computeDimensions(viewProject, lvlId).filter((c) => !hiddenSet.has(c.id)), unit, viewProject.dimOffsets);
          const hit = placed.find(({ chain: c, offset }) => {
            const s0 = c.marks[0].s;
            const s1 = c.marks[c.marks.length - 1].s;
            const a = add(add(c.origin, mul(c.dir, s0)), mul(c.out, offset * unit));
            const b = add(add(c.origin, mul(c.dir, s1)), mul(c.out, offset * unit));
            return projectOnSegment(m.world, a, b).d < tolM * 0.6;
          });
          if (hit) {
            setDimSel(hit.chain.id);
            select('modello', []);
            setMenu({ x: m.x, y: m.y, id: `quota:${hit.chain.id}` });
            return;
          }
        }
        const id = hitExtras(pickProject, lvlId, m.world, tolM) ?? hitTestModel(pickProject, m.world, lvlId, tolM);
        if (id && !selectedIds.includes(id)) select('modello', [id]);
        if (tool !== 'select') changeTool('select');
        setMenu({ x: m.x, y: m.y, id, world: m.world });
      }}
      hud={
        <>
          {layersOpen && (
            <LayersPanel
              layers={layers}
              onLayers={setLayers}
              state={viewState}
              onState={setViewState}
              hiddenDims={(project.hiddenDims ?? []).length}
              onShowDims={() => edit((d) => void (d.hiddenDims = []))}
              movedDims={Object.keys(project.dimOffsets ?? {}).length}
              onResetDims={() => edit((d) => void (d.dimOffsets = {}))}
              onClose={() => setLayersOpen(false)}
            />
          )}
          {menu && <ContextMenu x={menu.x} y={menu.y} title={menuTitle(menu.id)} items={menuItems(menu.id)} onClose={() => setMenu(null)} />}
        </>
      }
      tools={
        <>
          {below && (
            <button className={`chip ${ghost ? 'chip-on' : ''}`} onClick={() => setGhost(!ghost)} title="Mostra in trasparenza il livello inferiore e agganciati ai suoi elementi">
              Sottostante: {below.name}
            </button>
          )}
          {above && above.kind !== 'copertura' && !isRoofLevel && (
            <button className={`chip ${ghostAbove ? 'chip-on' : ''}`} onClick={() => setGhostAbove(!ghostAbove)} title="Mostra in trasparenza i muri del livello superiore">
              Soprastante: {above.name}
            </button>
          )}
          <button
            className={`chip ${layersOpen || viewState !== 'progetto' || layersWith(layers, ['nascosto', 'bloccato']).length ? 'chip-on' : ''}`}
            onClick={() => setLayersOpen(!layersOpen)}
            title="Stato rappresentato, categorie visibili, bloccate o nascoste"
          >
            Vista{viewState !== 'progetto' ? `: ${VIEW_STATE_LABEL[viewState]}` : ''}
          </button>
        </>
      }
    >
      {(z) => {
        const mm = 3 / z;
        return (
          <>
            <PlanView
              project={viewProject}
              levelId={lvlId}
              mm={mm}
              selectedIds={selectedIds}
              ghostLevelId={ghost ? below?.id : undefined}
              ghostAboveId={ghostAbove && above && above.kind !== 'copertura' ? above.id : undefined}
              comparativa={viewState === 'comparativa'}
              showDimensions={z > 18 && layers.quote !== 'nascosto'}
              textScale={SCREEN_TEXT}
              onDimEdit={tool === 'select' ? openDim : undefined}
              onDimHide={tool === 'select' ? hideDim : undefined}
              onDimMove={tool === 'select' ? moveDim : undefined}
              onDimReset={tool === 'select' ? resetDim : undefined}
              selectedDim={dimSel}
              activeDim={dimEdit ? `${dimEdit.chain.id}#${dimEdit.k}` : undefined}
            />
            <DraftOverlay
              tool={tool}
              draft={draft}
              cursor={cursor?.p}
              snapKind={cursor?.kind}
              mm={mm}
              typed={typed}
              previewLen={previewLen}
              thickness={tool === 'wall' ? wallThickness(byId(project.catalog.wall, activeType.wall)) : 0}
              wallAxis={
                tool === 'wall' && last && cursor && wallRef !== 'asse'
                  ? axisPolyline([...draft, cursor.p], wallThickness(byId(project.catalog.wall, activeType.wall)) / 2, wallRef).slice(-2)
                  : undefined
              }
            />
            {wallEditPreview && WALL_EDIT.includes(tool) && (
              // anteprima: tratto da togliere (rosso), prolungamento (tratteggiato), punto di divisione
              <line
                x1={wallEditPreview.a.x}
                y1={-wallEditPreview.a.y}
                x2={wallEditPreview.b.x}
                y2={-wallEditPreview.b.y}
                className={`wall-edit-preview wall-edit-${wallEditPreview.kind}`}
                strokeWidth={(wallEditPreview.kind === 'taglia' ? 1.2 : 0.6) * mm}
                strokeDasharray={wallEditPreview.kind === 'estendi' ? `${2 * mm} ${1 * mm}` : undefined}
                pointerEvents="none"
              />
            )}
            {tool === 'cima' &&
              cimaPreview?.map(([a, b], i) => (
                <line key={`cima${i}`} x1={a.x} y1={-a.y} x2={b.x} y2={-b.y} className="wall-edit-preview" strokeWidth={0.6 * mm} strokeDasharray={i === 1 || cimaPreview.length === 1 ? `${2 * mm} ${1 * mm}` : undefined} pointerEvents="none" />
              ))}
            {(tool === 'sposta' || tool === 'copia') && draft.length === 1 && cursor && (
              // anteprima degli elementi nella posizione d'arrivo
              <g className="draft" pointerEvents="none">
                {(() => {
                  const lenV = parseFloat(typed);
                  const dir = norm(sub(cursor.p, draft[0]));
                  const delta = typed && lenV > 0 && isFinite(dir.x) ? mul(dir, lenV) : sub(cursor.p, draft[0]);
                  return selectedIds.flatMap((id) => {
                    const el = project.elements.find((x) => x.id === id);
                    if (!el) return [];
                    return elementOutlines(project, el).map((q, i) => <polygon key={`${id}${i}`} points={pts(q.map((v) => add(v, delta)))} className="draft-poly" strokeWidth={0.35 * mm} />);
                  });
                })()}
              </g>
            )}
            {tool === 'vault' && draft.length === 1 && cursor && (
              // anteprima del campo della volta
              <g className="draft" pointerEvents="none">
                <polygon points={pts(axisRect(draft[0], cursor.p))} className="draft-poly" strokeWidth={0.35 * mm} />
              </g>
            )}
            {tool === 'stair' && draft.length === 1 && cursor && dist(draft[0], cursor.p) > 0.1 && (
              // anteprima della scala: rampe e pianerottolo
              <g className="draft" pointerEvents="none">
                {stairFootprints(project, stairFromClicks(project, { levelId: lvlId, a: draft[0], b: cursor.p, width: 1.1, shape: stairShape, turn: stairTurn })).map((q, i) => (
                  <polygon key={i} points={pts(q)} className="draft-poly" strokeWidth={0.35 * mm} />
                ))}
              </g>
            )}
            {marquee && (
              <rect
                x={Math.min(marquee.a.x, marquee.b.x)}
                y={-Math.max(marquee.a.y, marquee.b.y)}
                width={Math.abs(marquee.b.x - marquee.a.x)}
                height={Math.abs(marquee.b.y - marquee.a.y)}
                className={marquee.b.x < marquee.a.x ? 'marquee marquee-cross' : 'marquee'}
                pointerEvents="none"
              />
            )}
            {/* anteprima della traccia di sezione: segue il mouse dopo il primo clic */}
            {tool === 'section' && draft.length === 1 && cursor && dist(draft[0], cursor.p) > 0.05 && (
              <g className="sm-preview" pointerEvents="none">
                <SectionMark
                  section={{ id: 'anteprima', name: nextSectionName(project), a: draft[0], b: ortho ? alignOrtho(draft[0], cursor.p) : cursor.p, depth: 40, flip: false }}
                  mm={mm}
                  ts={SCREEN_TEXT}
                  selected
                />
              </g>
            )}
            {dimEdit && (
              <g transform={`translate(${dimEdit.at.x} ${-dimEdit.at.y}) scale(${1 / z})`}>
                <foreignObject x={-110} y={-17} width={220} height={74}>
                  <div data-hud className="dim-input dim-input-wide">
                    <div className="dim-input-row">
                    <input
                      autoFocus
                      className="mono"
                      value={dimText}
                      onChange={(e) => setDimText(e.target.value)}
                      onFocus={(e) => e.target.select()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitDim();
                        if (e.key === 'Escape') setDimEdit(null);
                      }}
                      onBlur={() => setDimEdit(null)}
                    />
                    <span>m</span>
                    </div>
                    {(() => {
                      const ed = segmentEdits(dimEdit.chain, dimEdit.k);
                      const both = !!ed.inizio && !!ed.fine;
                      const label = dimSide ? ed[dimSide] : null;
                      return (
                        <div className="dim-input-side">
                          {both ? (
                            (['inizio', 'fine'] as DimSide[]).map((sd) => (
                              <button
                                key={sd}
                                className={dimSide === sd ? 'on' : ''}
                                // il campo resta attivo: si sceglie e si conferma con Invio
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => setDimSide(sd)}
                                title={`Si sposta ${ed[sd]}, l’altro estremo resta fermo`}
                              >
                                {sd === 'inizio' ? '◀ ' : ''}
                                {ed[sd]}
                                {sd === 'fine' ? ' ▶' : ''}
                              </button>
                            ))
                          ) : (
                            <span>si sposta {label}</span>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                </foreignObject>
              </g>
            )}
            {openingPreview && (tool === 'door' || tool === 'window') && (
              <OpeningPreview project={project} wallId={openingPreview.wallId} offset={openingPreview.offset} typeId={activeType.opening} mm={mm} />
            )}
          </>
        );
      }}
    </Canvas2D>
  );

  return (
    <div className="workspace">
      <aside className="side side-left">
        <div className="side-scroll">
          <div className="side-title">
            <span className="phase-num">02</span> Modellazione
          </div>
          <div className="toolgrid">
            {TOOLS.map((t) => {
              const off = isRoofLevel && ROOF_LEVEL_OFF.includes(t.id);
              const label = isRoofLevel && t.id === 'wall' ? 'Parapetto' : t.label;
              return (
                <button
                  key={t.id}
                  className={`tool ${tool === t.id ? 'on' : ''}`}
                  disabled={off}
                  onClick={() => changeTool(t.id)}
                  title={off ? 'Non disponibile sul livello delle coperture: non ci sono muri d’ambito né piani superiori' : `${label} (${t.key})`}
                >
                  <Icon name={t.icon} size={20} />
                  <span>{label}</span>
                  <kbd>{t.key}</kbd>
                </button>
              );
            })}
          </div>

          <div className="subhead">Modifica</div>
          <div className="toolgrid">
            {EDIT_TOOLS.map((t) => (
              <button key={t.id} className={`tool ${tool === t.id ? 'on' : ''}`} onClick={() => changeTool(t.id)} title={`${t.label} (${t.key})`}>
                <Icon name={t.icon} size={20} />
                <span>{t.label}</span>
                <kbd>{t.key}</kbd>
              </button>
            ))}
          </div>

          <div className="subhead">Locali e annotazioni</div>
          <div className="toolgrid">
            {EXTRA_TOOLS.map((t) => (
              <button key={t.id} className={`tool ${tool === t.id ? 'on' : ''}`} onClick={() => changeTool(t.id)} title={`${t.label} (${t.key})`}>
                <Icon name={t.icon} size={20} />
                <span>{t.label}</span>
                <kbd>{t.key}</kbd>
              </button>
            ))}
          </div>

          {catKey && (
            <div className="typelist">
              <div className="subhead">
                Tipologie · {toolDef.label.toLowerCase()}
                <button
                  className="link"
                  onClick={() => {
                    const id = duplicateType(catKey, activeType[catKey]);
                    if (id) {
                      setActiveType((a) => ({ ...a, [catKey]: id }));
                      setEditingType({ key: catKey, id });
                    }
                  }}
                >
                  + Nuova
                </button>
              </div>
              {typeList.map((t) => (
                <div key={t.id} className={`typeitem ${activeType[catKey] === t.id ? 'on' : ''}`} onClick={() => setActiveType((a) => ({ ...a, [catKey]: t.id }))}>
                  <TypeSwatch project={project} catKey={catKey} id={t.id} />
                  <div className="typeitem-name">{t.name}</div>
                  <button
                    className="icon-btn"
                    title="Modifica tipologia: aggiorna tutte le istanze"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      setEditingType({ key: catKey, id: t.id });
                    }}
                  >
                    <Icon name="edit" size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {(tool === 'slab' || tool === 'roof') && (
            <button className="btn btn-block" onClick={() => fromWalls(tool)}>
              {tool === 'slab' ? 'Solaio dal perimetro dei muri' : 'Copertura sull’edificio'}
            </button>
          )}
          {tool === 'wall' && (
            <>
              <div className="subhead">Riferimento <kbd>R</kbd></div>
              <Segmented<WallRef>
                small
                value={wallRef}
                options={(['sinistra', 'asse', 'destra'] as WallRef[]).map((r) => ({ value: r, label: WALL_REF_LABEL[r] }))}
                onChange={setWallRef}
              />
              <p className="note">
                {wallRef === 'asse'
                  ? 'Si disegna sull’asse del muro.'
                  : `Si disegna sul ${wallRef === 'sinistra' ? 'filo sinistro' : 'filo destro'}, guardando nel verso di disegno: il muro cresce dall’altra parte e quel filo resta fermo se cambi spessore.`}
              </p>
            </>
          )}
          {tool === 'vault' && (
            <>
              <div className="subhead">Forma della volta</div>
              <Segmented<VaultShape>
                small
                value={vaultShape}
                options={[
                  { value: 'botte', label: 'A botte' },
                  { value: 'crociera', label: 'A crociera' },
                  { value: 'padiglione', label: 'A padiglione' },
                  { value: 'vela', label: 'A vela' },
                ]}
                onChange={setVaultShape}
              />
              <p className="note">
                Clic dentro un vano rettangolare chiuso dai muri (la volta prende il filo interno), oppure su due angoli opposti del campo. Imposta e freccia si propongono con la chiave sotto il solaio superiore e si cambiano nell’ispettore.
              </p>
            </>
          )}
          {tool === 'stair' && (
            <>
              <div className="subhead">Forma della scala</div>
              <Segmented<'dritta' | 'L' | 'U'>
                small
                value={stairShape}
                options={[
                  { value: 'dritta', label: 'Dritta' },
                  { value: 'L', label: 'L' },
                  { value: 'U', label: 'U' },
                ]}
                onChange={setStairShape}
              />
              {stairShape !== 'dritta' && (
                <Segmented<'sinistra' | 'destra'>
                  small
                  value={stairTurn}
                  options={[
                    { value: 'sinistra', label: 'Svolta a sinistra' },
                    { value: 'destra', label: 'Svolta a destra' },
                  ]}
                  onChange={setStairTurn}
                />
              )}
              <p className="note">
                {stairShape === 'dritta'
                  ? 'Clic su partenza e arrivo della rampa.'
                  : 'Clic sulla partenza e sul bordo del pianerottolo: la prima rampa prende metà delle alzate, la seconda gira dopo il pianerottolo.'}
              </p>
            </>
          )}
          {(tool === 'door') && (
            <label className="check">
              <input type="checkbox" checked={flipNext} onChange={(e) => setFlipNext(e.target.checked)} /> Apertura verso l’altro lato
            </label>
          )}
          {tool === 'door' && (
            <label className="check">
              <input type="checkbox" checked={mirrorNext} onChange={(e) => setMirrorNext(e.target.checked)} /> Cerniera sull’altro stipite
            </label>
          )}

          <div className="subhead">Livelli</div>
          <div className="levels-list">
            {[...levels].reverse().map((l) => {
              const n = project.elements.filter((e) => 'levelId' in e && e.levelId === l.id).length;
              return (
                <button key={l.id} className={`level-row ${l.id === lvlId ? 'on' : ''}`} onClick={() => setLevel(l.id)}>
                  <span>{l.name}</span>
                  <span className="mono">{fmtLevel(l.elevation)}</span>
                  <span className="muted mono">{n} el.</span>
                </button>
              );
            })}
          </div>
          <p className="note">Quote e altezze dei livelli si definiscono in 01 · Inquadramento.</p>

          <div className="subhead">
            Sezioni
            <button className={`link ${tool === 'section' ? 'strong' : ''}`} onClick={() => { setView('pianta'); changeTool('section'); }} title="Traccia una sezione in pianta (X)">
              + Traccia (X)
            </button>
          </div>
          <div className="elist">
            {(project.sections ?? []).map((sec) => (
              <button
                key={sec.id}
                className={`elist-row ${selectedIds.includes(sec.id) ? 'on' : ''}`}
                onClick={() => {
                  changeTool('select');
                  select('modello', [sec.id]);
                }}
                onDoubleClick={() => setView('sezioni')}
                title="Clic per selezionare, doppio clic per aprire"
              >
                <span className="mono elist-code">{sec.name}–{sec.name}′</span>
                <span>Profondità {fmt(sec.depth, 0)} m</span>
              </button>
            ))}
          </div>
          {!(project.sections ?? []).length && <p className="note">Nessuna sezione: tracciala in pianta con due clic.</p>}
        </div>
      </aside>

      <main className="stage">
        <div className="stage-bar">
          <Segmented<ViewMode>
            value={view}
            onChange={setView}
            options={[
              { value: 'pianta', label: 'Pianta' },
              { value: 'prospetti', label: 'Prospetti' },
              { value: 'sezioni', label: 'Sezioni' },
              { value: '3d', label: 'Vista 3D' },
              { value: 'affiancate', label: 'Pianta + 3D' },
            ]}
          />
          <div className="stage-bar-right">
            {levels.map((l) => (
              <button key={l.id} className={`tab ${l.id === lvlId ? 'on' : ''}`} onClick={() => setLevel(l.id)}>
                {l.name}
              </button>
            ))}
          </div>
        </div>
        <div className={`stage-body ${view === 'affiancate' ? 'split' : ''}`}>
          {(view === 'pianta' || view === 'affiancate') && planCanvas}
          {view === 'prospetti' && <ElevationsBoard project={project} />}
          {view === 'sezioni' && <SectionsBoard project={project} selectedIds={selectedIds} onDraw={() => { setView('pianta'); changeTool('section'); }} />}
          {(view === '3d' || view === 'affiancate') && (
            <Suspense fallback={<div className="empty-stage">Caricamento della vista 3D…</div>}>
            <Model3D
              project={project}
              revision={revision}
              selectedIds={selectedIds}
              dark={theme === 'scuro'}
              onPick={(id) => {
                if (!id) return select('modello', []);
                select('modello', [id]);
                const el = project.elements.find((x) => x.id === id);
                if (el && 'levelId' in el && el.levelId !== lvlId) setLevel(el.levelId);
                if (el?.kind === 'opening') {
                  const w = project.elements.find((x) => x.id === el.wallId);
                  if (w && 'levelId' in w) setLevel(w.levelId);
                }
              }}
            />
            </Suspense>
          )}
        </div>
        <div className="prompt">
          <span className="prompt-label">{toolDef.label}</span>
          <span className="prompt-text">
            {tool === 'section' && draft.length === 1
              ? 'Ora clicca il punto finale: la traccia segue il mouse e le frecce mostrano il verso di vista. Esc per annullare.'
              : toolDef.hint}
          </span>
          {typed && (
            <span className="prompt-typed mono">
              {tool === 'sposta' || tool === 'copia' ? 'Distanza' : 'L'} = {typed} m <kbd>Invio</kbd>
            </span>
          )}
          <span className="prompt-keys">
            <KeyHint k="Esc">annulla</KeyHint>
            <KeyHint k="Spazio">sposta vista</KeyHint>
            <KeyHint k="Canc">elimina</KeyHint>
          </span>
        </div>
      </main>

      <aside className="side side-right">
        <div className="side-scroll">
          {editingType ? (
            <TypeEditor catKey={editingType.key} id={editingType.id} onClose={() => setEditingType(null)} />
          ) : selectedIds.length ? (
            (project.sections ?? []).some((x) => x.id === selectedIds[0]) ? (
              <SectionInspector id={selectedIds[0]} onOpen={() => setView('sezioni')} />
            ) : findRoom(project, selectedIds[0]) ? (
              <RoomInspector id={selectedIds[0]} />
            ) : findAnnotation(project, selectedIds[0]) ? (
              <AnnotationInspector id={selectedIds[0]} />
            ) : (
              <Inspector ids={selectedIds} onEditType={(key, id) => setEditingType({ key, id })} />
            )
          ) : (
            <LevelSummary project={project} levelId={lvlId} />
          )}
        </div>
      </aside>
    </div>
  );

  function duplicateType(key: CatalogKey, id: string): string | null {
    const src = (project.catalog[key] as { id: string; name: string }[]).find((t) => t.id === id);
    if (!src) return null;
    const nid = uid('t');
    edit((d) => {
      const copy = { ...JSON.parse(JSON.stringify(src)), id: nid, name: `${src.name} (copia)` };
      (d.catalog[key] as unknown[]).push(copy);
    });
    return nid;
  }
}

function DraftOverlay({
  tool,
  draft,
  cursor,
  snapKind,
  mm,
  typed,
  previewLen,
  thickness,
  wallAxis,
}: {
  tool: Tool;
  draft: Vec2[];
  cursor?: Vec2;
  snapKind?: Snap['kind'];
  mm: number;
  typed: string;
  previewLen: number;
  thickness: number;
  /** Asse del tratto in disegno, quando si disegna su un filo */
  wallAxis?: Vec2[];
}) {
  const last = draft[draft.length - 1];
  const chain = cursor && tool !== 'select' ? [...draft, cursor] : draft;
  const closed = tool === 'slab' || tool === 'roof';
  return (
    <g className="draft" pointerEvents="none">
      {tool === 'wall' && last && cursor && dist(last, cursor) > 0.01 && (
        <polygon
          points={pts(
            wallAxis
              ? wallSegmentQuad({ a: wallAxis[0], b: wallAxis[1] } as never, thickness, 0, dist(wallAxis[0], wallAxis[1]))
              : wallSegmentQuad({ a: last, b: cursor } as never, thickness, 0, dist(last, cursor)),
          )}
          className="draft-wall"
          strokeWidth={0.25 * mm}
        />
      )}
      {chain.length > 1 && (closed ? <polygon points={pts(chain)} className="draft-poly" strokeWidth={0.35 * mm} /> : <polyline points={pts(chain)} className="draft-line" strokeWidth={0.35 * mm} />)}
      {draft.map((p, i) => (
        <rect key={i} x={p.x - 0.8 * mm} y={-p.y - 0.8 * mm} width={1.6 * mm} height={1.6 * mm} className="draft-vertex" />
      ))}
      {cursor && snapKind && <SnapMarker p={cursor} kind={snapKind} mm={mm} />}
      {cursor && tool !== 'select' && (
        <g>
          <line x1={cursor.x - 4 * mm} y1={-cursor.y} x2={cursor.x + 4 * mm} y2={-cursor.y} className="draft-cross" strokeWidth={0.2 * mm} />
          <line x1={cursor.x} y1={-cursor.y - 4 * mm} x2={cursor.x} y2={-cursor.y + 4 * mm} className="draft-cross" strokeWidth={0.2 * mm} />
          {last && (
            <g>
              <rect x={cursor.x + 2.5 * mm} y={-cursor.y + 2.5 * mm} width={20 * mm} height={5 * mm} className="draft-tag" />
              <text x={cursor.x + 3.5 * mm} y={-cursor.y + 6.2 * mm} fontSize={2.8 * mm} className="draft-tag-text">
                {typed ? `${typed} m` : `${fmt(previewLen, 2)} m`}
              </text>
            </g>
          )}
        </g>
      )}
    </g>
  );
}

const SNAP_LABEL: Partial<Record<Snap['kind'], string>> = {
  estremo: 'Estremo',
  medio: 'Punto medio',
  intersezione: 'Intersezione',
  perpendicolare: 'Perpendicolare',
  muro: 'Su muro',
  bordo: 'Su bordo',
  spigolo: 'Spigolo',
  allineamento: 'Allineata',
};

/** Simbolo dell'aggancio attivo, con etichetta */
function SnapMarker({ p, kind, mm }: { p: Vec2; kind: Snap['kind']; mm: number }) {
  const label = SNAP_LABEL[kind];
  if (!label) return null;
  const x = p.x;
  const y = -p.y;
  const r = 1.8 * mm;
  const sw = 0.3 * mm;
  let mark;
  switch (kind) {
    case 'estremo':
    case 'spigolo':
      mark = <rect x={x - r} y={y - r} width={2 * r} height={2 * r} className="snap-mark" strokeWidth={sw} />;
      break;
    case 'medio':
      mark = <polygon points={`${x},${y - 2.1 * mm} ${x + 1.9 * mm},${y + 1.2 * mm} ${x - 1.9 * mm},${y + 1.2 * mm}`} className="snap-mark" strokeWidth={sw} />;
      break;
    case 'intersezione':
      mark = (
        <g className="snap-mark" strokeWidth={sw}>
          <line x1={x - r} y1={y - r} x2={x + r} y2={y + r} />
          <line x1={x - r} y1={y + r} x2={x + r} y2={y - r} />
        </g>
      );
      break;
    case 'perpendicolare':
      mark = (
        <g className="snap-mark" strokeWidth={sw}>
          <polyline points={`${x - r},${y - r} ${x - r},${y + r} ${x + r},${y + r}`} />
          <polyline points={`${x - r},${y} ${x},${y} ${x},${y + r}`} />
        </g>
      );
      break;
    default:
      mark = <polygon points={`${x},${y - r} ${x + r},${y} ${x},${y + r} ${x - r},${y}`} className="snap-mark" strokeWidth={sw} />;
  }
  return (
    <g>
      {mark}
      <text x={x + 2.6 * mm} y={y - 2.4 * mm} fontSize={2.6 * mm} strokeWidth={0.6 * mm} className="snap-label">
        {label}
      </text>
    </g>
  );
}

function OpeningPreview({ project, wallId, offset, typeId, mm }: { project: Project; wallId: string; offset: number; typeId: string; mm: number }) {
  const w = project.elements.find((x) => x.id === wallId);
  const t = byId(project.catalog.opening, typeId);
  if (!w || w.kind !== 'wall' || !t) return null;
  const th = wallThickness(byId(project.catalog.wall, w.typeId));
  return (
    <polygon
      points={pts(wallSegmentQuad(w, th + 0.08, offset - t.width / 2, offset + t.width / 2))}
      className="draft-opening"
      strokeWidth={0.35 * mm}
    />
  );
}

function TypeSwatch({ project, catKey, id }: { project: Project; catKey: CatalogKey; id: string }) {
  if (catKey === 'wall') {
    const t = byId(project.catalog.wall, id);
    const tot = wallThickness(t);
    return (
      <div className="swatch-layers" title={`${(tot * 100).toFixed(1)} cm`}>
        {t && <HatchSwatch kinds={t.layers.map(hatchOf)} weights={t.layers.map((l) => l.thickness)} width={44} height={14} />}
        <em className="mono">{Math.round(tot * 100)}</em>
      </div>
    );
  }
  const info: Record<string, string> = {};
  const s = byId(project.catalog.slab, id);
  if (catKey === 'slab' && s) info.v = `${Math.round(s.thickness * 100)}`;
  const o = byId(project.catalog.opening, id);
  if (catKey === 'opening' && o) info.v = `${Math.round(o.width * 100)}×${Math.round(o.height * 100)}`;
  const c = byId(project.catalog.column, id);
  if (catKey === 'column' && c) info.v = `${Math.round(c.width * 100)}×${Math.round(c.depth * 100)}`;
  const b = byId(project.catalog.beam, id);
  if (catKey === 'beam' && b) info.v = `${Math.round(b.width * 100)}×${Math.round(b.height * 100)}`;
  const r = byId(project.catalog.roof, id);
  if (catKey === 'roof' && r) info.v = `${Math.round(r.thickness * 100)}`;
  return <div className="swatch-tag mono">{info.v}</div>;
}

function LevelSummary({ project, levelId }: { project: Project; levelId: string }) {
  const l = byId(project.levels, levelId);
  if (!l) return null;
  const on = project.elements.filter((e) => 'levelId' in e && e.levelId === levelId);
  const walls = on.filter((e) => e.kind === 'wall');
  const wallLen = walls.reduce((s, w) => s + (w.kind === 'wall' ? wallLength(w) : 0), 0);
  const openings = project.elements.filter((e) => e.kind === 'opening' && walls.some((w) => w.id === e.wallId)).length;
  const count = (k: string) => on.filter((e) => e.kind === k).length;
  return (
    <div className="inspector">
      <div className="insp-kicker">Livello attivo</div>
      <h2 className="insp-title">{l.name}</h2>
      <div className="kv-grid">
        <div>
          <span>Quota piano finito</span>
          <b className="mono">{fmtLevel(l.elevation)} m</b>
        </div>
        <div>
          <span>Altezza interpiano</span>
          <b className="mono">{fmt(l.height)} m</b>
        </div>
        <div>
          <span>Muri</span>
          <b className="mono">
            {walls.length} · {fmt(wallLen, 1)} m
          </b>
        </div>
        <div>
          <span>Aperture</span>
          <b className="mono">{openings}</b>
        </div>
        <div>
          <span>Solai</span>
          <b className="mono">{count('slab')}</b>
        </div>
        <div>
          <span>Pilastri / travi</span>
          <b className="mono">
            {count('column')} / {count('beam')}
          </b>
        </div>
      </div>
      <p className="note">
        Seleziona un elemento per modificarne proprietà e tipologia. Ogni modifica aggiorna in tempo reale i fogli (03) e il computo (04).
      </p>
      <div className="subhead">Elementi del livello</div>
      <ElementList project={project} ids={on.map((e) => e.id)} />
    </div>
  );
}

function ElementList({ project, ids }: { project: Project; ids: string[] }) {
  const select = useStore((s) => s.select);
  return (
    <div className="elist">
      {ids.map((id) => {
        const e = project.elements.find((x) => x.id === id)!;
        let detail = '';
        if (e.kind === 'wall') detail = byId(project.catalog.wall, e.typeId)?.name ?? '';
        if (e.kind === 'slab') detail = byId(project.catalog.slab, e.typeId)?.name ?? '';
        if (e.kind === 'column') detail = byId(project.catalog.column, e.typeId)?.name ?? '';
        if (e.kind === 'beam') detail = byId(project.catalog.beam, e.typeId)?.name ?? '';
        if (e.kind === 'roof') detail = byId(project.catalog.roof, e.typeId)?.name ?? '';
        if (e.kind === 'stair') detail = `Rampa ${fmt(dist(e.a, e.b), 2)} m`;
        return (
          <button key={id} className="elist-row" onClick={() => select('modello', [id])}>
            <span className="mono elist-code">{elementCode(project, e)}</span>
            <span>{detail}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Tavola dei quattro prospetti, rigenerata dal modello */
function ElevationsBoard({ project }: { project: Project }) {
  const dirs: Direction[] = ['sud', 'est', 'nord', 'ovest'];
  const h = elevationHeight(project);
  const layout = dirs.map((d) => ({ d, ext: elevationExtents(project, d) }));
  const colW = Math.max(...layout.map((l) => l.ext.max - l.ext.min)) + 8;
  const rowH = h.top - h.bottom + 6;
  const bounds = { minX: -2, minY: -rowH * 2 + h.top, maxX: colW * 2, maxY: h.top + 3 };
  return (
    <Canvas2D bounds={bounds} grid={false}>
      {(z) => (
        <g>
          {layout.map(({ d, ext }, i) => {
            const ox = (i % 2) * colW - ext.min;
            const oy = Math.floor(i / 2) * rowH;
            return (
              <g key={d} transform={`translate(${ox} ${oy})`}>
                <ElevationView project={project} direction={d} mm={3 / z} textScale={SCREEN_TEXT} />
                <text x={ext.min} y={-h.top - 1.2} fontSize={12 / z} className="board-title">
                  PROSPETTO {d.toUpperCase()}
                </text>
              </g>
            );
          })}
        </g>
      )}
    </Canvas2D>
  );
}

/** Sezioni del progetto, generate dal modello */
function SectionsBoard({ project, selectedIds, onDraw }: { project: Project; selectedIds: string[]; onDraw: () => void }) {
  const all = project.sections ?? [];
  const sel = all.find((x) => selectedIds.includes(x.id));
  const list = sel ? [sel] : all;
  if (!all.length)
    return (
      <div className="empty-stage">
        <p>Nessuna sezione nel progetto.</p>
        <button className="btn btn-primary" onClick={onDraw}>Traccia una sezione in pianta</button>
      </div>
    );
  const h = elevationHeight(project);
  const rowH = h.top - h.bottom + 6;
  const maxL = Math.max(...list.map(sectionLength));
  const bounds = { minX: -2, minY: h.top - rowH * list.length, maxX: maxL + 14, maxY: h.top + 3 };
  return (
    <Canvas2D key={list.map((x) => x.id).join()} bounds={bounds} grid={false}>
      {(z) => (
        <g>
          {list.map((sec, i) => (
            <g key={sec.id} transform={`translate(0 ${i * rowH})`}>
              <SectionView project={project} section={sec} mm={3 / z} textScale={SCREEN_TEXT} />
              <text x={0} y={-h.top - 1.2} fontSize={12 / z} className="board-title">
                SEZIONE {sec.name}–{sec.name}′
              </text>
            </g>
          ))}
        </g>
      )}
    </Canvas2D>
  );
}

function SectionInspector({ id, onOpen }: { id: string; onOpen: () => void }) {
  const project = useStore((s) => s.project);
  const edit = useStore((s) => s.edit);
  const select = useStore((s) => s.select);
  const sec = (project.sections ?? []).find((x) => x.id === id);
  if (!sec) return null;
  const upd = (fn: (x: NonNullable<Project['sections']>[number]) => void) =>
    edit((d) => {
      const x = (d.sections ?? []).find((q) => q.id === id);
      if (x) fn(x);
    });
  return (
    <div className="inspector">
      <div className="insp-kicker">Sezione</div>
      <h2 className="insp-title">
        {sec.name}–{sec.name}′
      </h2>
      <TextField label="Sigla" value={sec.name} onChange={(v) => upd((x) => (x.name = v.trim() || x.name))} />
      <NumberField label="Profondità di vista" unit="m" value={sec.depth} min={1} step={1} digits={1} onChange={(v) => upd((x) => (x.depth = v))} />
      <div className="kv-grid">
        <div><span>Lunghezza traccia</span><b className="mono">{fmt(sectionLength(sec))} m</b></div>
        <div><span>Verso di vista</span><b>{sec.flip ? 'a destra della traccia' : 'a sinistra della traccia'}</b></div>
      </div>
      <div className="door-tools">
        <button className="btn" onClick={() => upd((x) => (x.flip = !x.flip))}>⇅ Inverti verso</button>
        <button className="btn btn-primary" onClick={onOpen}>Apri la sezione</button>
      </div>
      <p className="note">La sezione si aggiorna a ogni modifica del modello. In 03 Layout puoi inserirla in una tavola.</p>
      <div className="insp-actions">
        <button
          className="btn btn-danger"
          onClick={() => {
            edit((d) => void (d.sections = (d.sections ?? []).filter((x) => x.id !== id)));
            select('modello', []);
          }}
        >
          <Icon name="trash" size={14} /> Elimina sezione
        </button>
      </div>
    </div>
  );
}
