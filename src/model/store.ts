import { create } from 'zustand';
import { freeze, produce } from 'immer';
import type { Phase, Project } from './types';
import { sampleProject } from './defaults';
import { getImage, putImage } from './images';
import { constrain } from './constraints';
import { ProjectFormatError, validateProject, type ValidationResult } from './validate';

const STORAGE_KEY = 'pennino.project.v1';
const HISTORY_LIMIT = 120;

function loadInitial(): Project {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      return validateProject(JSON.parse(raw)).project;
    }
  } catch {
    /* progetto salvato non leggibile: si riparte dall'esempio */
  }
  return sampleProject();
}

export type Selection = { scope: 'modello' | 'cantiere' | 'contesto'; ids: string[] };

interface State {
  project: Project;
  /** Incrementato a ogni modifica: le viste derivate (3D, fogli) lo usano per rigenerarsi */
  revision: number;
  past: Project[];
  future: Project[];
  phase: Phase;
  activeLevelId: string;
  selection: Selection;
  theme: 'scuro' | 'chiaro';
  savedAt: number | null;
  /** Avviso breve all'utente (modifica rifiutata, ecc.) */
  notice: string | null;
  setNotice: (n: string | null) => void;

  /** Modifica del modello registrata nella cronologia */
  edit: (fn: (draft: Project) => void) => void;
  /** Modifica continua (trascinamento): la cronologia va aperta prima con checkpoint() */
  editLive: (fn: (draft: Project) => void) => void;
  checkpoint: () => void;
  undo: () => void;
  redo: () => void;
  replaceProject: (p: Project) => void;

  setPhase: (p: Phase) => void;
  setActiveLevel: (id: string) => void;
  select: (scope: Selection['scope'], ids: string[]) => void;
  clearSelection: () => void;
  toggleTheme: () => void;
  /** Impostazioni di disegno comuni a tutte le fasi, ricordate tra le sessioni */
  drafting: DraftingSettings;
  setDrafting: (patch: Partial<DraftingSettings>) => void;
}

export interface DraftingSettings {
  /** Disegno ortogonale (F8); Maiusc lo inverte finché è premuto */
  ortho: boolean;
  /** Griglia visibile nelle viste di disegno */
  grid: boolean;
  /** Passo di aggancio (m) */
  snapStep: number;
}

function readDrafting(): DraftingSettings {
  const def: DraftingSettings = { ortho: true, grid: true, snapStep: 0.05 };
  try {
    return { ...def, ...JSON.parse(localStorage.getItem('pennino.drafting') || '{}') };
  } catch {
    return def;
  }
}

function readTheme(): 'scuro' | 'chiaro' {
  try {
    return (localStorage.getItem('pennino.theme') as 'scuro' | 'chiaro') || 'scuro';
  } catch {
    return 'scuro';
  }
}

// congelato come tutti gli stati successivi: i calcoli derivati si possono memorizzare per progetto
const initial = freeze(loadInitial(), true);

export const useStore = create<State>((set, get) => ({
  project: initial,
  revision: 0,
  past: [],
  future: [],
  phase: 'modellazione',
  activeLevelId: initial.levels[0]?.id ?? '',
  selection: { scope: 'modello', ids: [] },
  theme: readTheme(),
  drafting: readDrafting(),
  savedAt: null,
  notice: null,
  setNotice: (n) => set({ notice: n }),

  edit: (fn) => {
    const { project, past, revision } = get();
    // il valore restituito dalla funzione viene ignorato: conta solo ciò che modifica nella bozza
    // dopo la modifica, solai e coperture appoggiati sui muri cambiati li seguono
    const { project: next, refusal: why } = constrain(
      project,
      produce(project, (d) => {
        fn(d);
      }),
    );
    if (why) set({ notice: why });
    if (next === project) return;
    set({ project: next, past: [...past, project].slice(-HISTORY_LIMIT), future: [], revision: revision + 1 });
  },
  editLive: (fn) => {
    const { project, revision } = get();
    // dopo la modifica, solai e coperture appoggiati sui muri cambiati li seguono
    const { project: next, refusal: why } = constrain(
      project,
      produce(project, (d) => {
        fn(d);
      }),
    );
    if (why && why !== get().notice) set({ notice: why });
    if (next !== project) set({ project: next, revision: revision + 1 });
  },
  checkpoint: () => {
    const { project, past } = get();
    if (past[past.length - 1] === project) return;
    set({ past: [...past, project].slice(-HISTORY_LIMIT), future: [] });
  },
  undo: () => {
    const { past, project, future, revision } = get();
    if (!past.length) return;
    const prev = past[past.length - 1];
    set({ project: prev, past: past.slice(0, -1), future: [project, ...future], revision: revision + 1 });
    get().clearSelection();
  },
  redo: () => {
    const { past, project, future, revision } = get();
    if (!future.length) return;
    set({ project: future[0], past: [...past, project], future: future.slice(1), revision: revision + 1 });
  },
  replaceProject: (p) => {
    set({
      project: freeze(p, true),
      past: [],
      future: [],
      revision: get().revision + 1,
      activeLevelId: p.levels[0]?.id ?? '',
      selection: { scope: 'modello', ids: [] },
    });
  },

  setPhase: (phase) => set({ phase, selection: { scope: 'modello', ids: [] } }),
  setActiveLevel: (id) => set({ activeLevelId: id }),
  select: (scope, ids) => set({ selection: { scope, ids } }),
  clearSelection: () => set({ selection: { scope: get().selection.scope, ids: [] } }),
  setDrafting: (patch) => {
    const drafting = { ...get().drafting, ...patch };
    try {
      localStorage.setItem('pennino.drafting', JSON.stringify(drafting));
    } catch {
      /* impostazioni non salvabili */
    }
    set({ drafting });
  },
  toggleTheme: () => {
    const theme = get().theme === 'scuro' ? 'chiaro' : 'scuro';
    try {
      localStorage.setItem('pennino.theme', theme);
    } catch {
      /* preferenza non salvabile */
    }
    set({ theme });
  },
}));

// Salvataggio automatico locale
let saveTimer: number | undefined;
useStore.subscribe((s, prev) => {
  if (s.project === prev.project) return;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(useStore.getState().project));
      useStore.setState({ savedAt: Date.now() });
    } catch {
      /* spazio locale esaurito: il progetto resta esportabile in JSON */
    }
  }, 400);
});

export async function exportProjectFile(p: Project) {
  // le immagini raster viaggiano dentro il file di progetto
  const images: Record<string, string> = {};
  for (const u of p.site.underlays ?? []) {
    const url = await getImage(u.imageId);
    if (url) images[u.imageId] = url;
  }
  const blob = new Blob([JSON.stringify({ ...p, images }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${p.name.replace(/[^\w\- ]+/g, '').trim() || 'progetto'}.pennino.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Legge un file di progetto, salvando a parte le immagini raster incluse */
export async function importProjectFile(text: string): Promise<ValidationResult> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ProjectFormatError('Il file non è un JSON leggibile.');
  }
  const result = validateProject(raw);
  const images = (raw as { images?: Record<string, unknown> }).images;
  if (images && typeof images === 'object')
    for (const [id, url] of Object.entries(images)) if (typeof url === 'string' && url.startsWith('data:image/')) await putImage(id, url);
  return result;
}

export function downloadText(name: string, text: string, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function resetToSample() {
  useStore.getState().replaceProject(sampleProject());
}
