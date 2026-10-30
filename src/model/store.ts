import { create } from 'zustand';
import { produce } from 'immer';
import type { Phase, Project } from './types';
import { sampleProject } from './defaults';
import { getImage, putImage } from './images';

const STORAGE_KEY = 'pennino.project.v1';
const HISTORY_LIMIT = 120;

function loadInitial(): Project {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Project;
      if (p && p.version === 1 && Array.isArray(p.elements)) return p;
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
}

function readTheme(): 'scuro' | 'chiaro' {
  try {
    return (localStorage.getItem('pennino.theme') as 'scuro' | 'chiaro') || 'scuro';
  } catch {
    return 'scuro';
  }
}

const initial = loadInitial();

export const useStore = create<State>((set, get) => ({
  project: initial,
  revision: 0,
  past: [],
  future: [],
  phase: 'modellazione',
  activeLevelId: initial.levels[0]?.id ?? '',
  selection: { scope: 'modello', ids: [] },
  theme: readTheme(),
  savedAt: null,

  edit: (fn) => {
    const { project, past, revision } = get();
    // il valore restituito dalla funzione viene ignorato: conta solo ciò che modifica nella bozza
    const next = produce(project, (d) => {
      fn(d);
    });
    if (next === project) return;
    set({ project: next, past: [...past, project].slice(-HISTORY_LIMIT), future: [], revision: revision + 1 });
  },
  editLive: (fn) => {
    const { project, revision } = get();
    const next = produce(project, (d) => {
      fn(d);
    });
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
      project: p,
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
export async function importProjectFile(text: string): Promise<Project> {
  const raw = JSON.parse(text) as Project & { images?: Record<string, string> };
  if (raw.version !== 1 || !Array.isArray(raw.elements)) throw new Error('formato');
  const { images, ...p } = raw;
  for (const [id, url] of Object.entries(images ?? {})) await putImage(id, url);
  return p;
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
