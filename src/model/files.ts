// Progetto su file: «Salva» scrive sempre sullo stesso file scelto dall'utente, «Salva con nome»
// ne sceglie un altro; dopo il primo salvataggio le modifiche vengono scritte sul file da sole.
// Usa l'accesso ai file del browser (Chrome, Edge e l'app desktop); dove manca si ripiega sullo
// scaricamento del file.

import type { Project } from './types';
import { exportProjectFile, importProjectFile, serializeProject, useStore } from './store';

interface WritableLike {
  write(data: string): Promise<void>;
  close(): Promise<void>;
}
export interface FileHandleLike {
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<WritableLike>;
  queryPermission?(o: { mode: 'readwrite' }): Promise<string>;
  requestPermission?(o: { mode: 'readwrite' }): Promise<string>;
}
interface PickerWindow {
  showSaveFilePicker?: (o: unknown) => Promise<FileHandleLike>;
  showOpenFilePicker?: (o: unknown) => Promise<FileHandleLike[]>;
}

const TYPES = [{ description: 'Progetto Pennino', accept: { 'application/json': ['.json'] } }];
const picker = () => window as unknown as PickerWindow;

/** Il programma può scrivere direttamente su un file scelto dall'utente? */
export const canUseFiles = () => typeof window !== 'undefined' && !!picker().showSaveFilePicker && !!picker().showOpenFilePicker;

let handle: FileHandleLike | null = null;
let lastWritten: Project | null = null;

// ───────── Progetti recenti (i riferimenti ai file stanno in IndexedDB) ─────────

export interface RecentFile {
  name: string;
  at: number;
  handle: FileHandleLike;
}

const DB = 'pennino-files';
const STORE = 'recent';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'name' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function recentFiles(): Promise<RecentFile[]> {
  try {
    const db = await openDb();
    const all = await new Promise<RecentFile[]>((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result as RecentFile[]);
      req.onerror = () => reject(req.error);
    });
    return all.sort((a, b) => b.at - a.at).slice(0, 8);
  } catch {
    return [];
  }
}

async function remember(h: FileHandleLike) {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ name: h.name, at: Date.now(), handle: h });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* elenco dei recenti non disponibile */
  }
}

// ───────── Scrittura e lettura ─────────

const cancelled = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

async function write(h: FileHandleLike, p: Project) {
  const text = await serializeProject(p);
  const w = await h.createWritable();
  await w.write(text);
  await w.close();
  lastWritten = p;
  useStore.setState({ fileName: h.name, fileSavedAt: Date.now() });
}

/** Salva sul file del progetto; senza file (o con saveAs) chiede dove. Restituisce false se annullato */
export async function saveProject(saveAs = false): Promise<boolean> {
  const p = useStore.getState().project;
  if (!canUseFiles()) {
    await exportProjectFile(p);
    return true;
  }
  try {
    if (!handle || saveAs) {
      const name = `${p.name.replace(/[^\w\- ]+/g, '').trim() || 'progetto'}.pennino.json`;
      handle = await picker().showSaveFilePicker!({ suggestedName: name, types: TYPES });
      await remember(handle);
    }
    await write(handle, p);
    return true;
  } catch (e) {
    if (cancelled(e)) return false;
    useStore.getState().setNotice('Non è stato possibile scrivere il file: il progetto resta nel salvataggio locale.');
    return false;
  }
}

async function load(h: FileHandleLike) {
  const { project, warnings } = await importProjectFile(await (await h.getFile()).text());
  handle = h;
  lastWritten = null;
  useStore.getState().replaceProject(project);
  lastWritten = useStore.getState().project;
  useStore.setState({ fileName: h.name, fileSavedAt: Date.now() });
  await remember(h);
  return warnings;
}

/** Apre un progetto scegliendolo dal disco. Restituisce gli avvisi, o null se annullato */
export async function openProject(): Promise<string[] | null> {
  try {
    const [h] = await picker().showOpenFilePicker!({ types: TYPES });
    return await load(h);
  } catch (e) {
    if (cancelled(e)) return null;
    throw e;
  }
}

/** Riapre un progetto recente (il browser può chiedere di confermare l'accesso al file) */
export async function openRecent(r: RecentFile): Promise<string[] | null> {
  const h = r.handle;
  if (h.queryPermission && (await h.queryPermission({ mode: 'readwrite' })) !== 'granted') {
    if (!h.requestPermission || (await h.requestPermission({ mode: 'readwrite' })) !== 'granted') return null;
  }
  return load(h);
}

/** Il progetto non è più legato a un file (nuovo progetto, esempio) */
export function detachFile() {
  handle = null;
  lastWritten = null;
  useStore.setState({ fileName: null, fileSavedAt: null });
}

// Dopo il primo salvataggio le modifiche vanno sul file da sole, poco dopo l'ultima
let timer: number | undefined;
if (typeof window !== 'undefined')
  useStore.subscribe((s, prev) => {
    if (s.project === prev.project || !handle) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      const p = useStore.getState().project;
      if (!handle || p === lastWritten) return;
      write(handle, p).catch(() => useStore.getState().setNotice('Salvataggio automatico sul file non riuscito: usa «Salva» per riprovare.'));
    }, 1500);
  });
