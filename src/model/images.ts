// Immagini raster di base (estratti catastali, planimetrie, ortofoto).
// Il progetto conserva solo l'identificativo; i dati stanno in IndexedDB,
// perché lo spazio del salvataggio automatico (localStorage) è limitato.

import { useEffect, useState } from 'react';

const DB = 'pennino-images';
const STORE = 'images';
const cache = new Map<string, string>();
const listeners = new Set<() => void>();

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putImage(id: string, dataUrl: string) {
  cache.set(id, dataUrl);
  listeners.forEach((l) => l());
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(dataUrl, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* senza IndexedDB l'immagine resta disponibile fino alla chiusura */
  }
}

export async function getImage(id: string): Promise<string | undefined> {
  if (cache.has(id)) return cache.get(id);
  try {
    const db = await open();
    const url = await new Promise<string | undefined>((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result as string | undefined);
      req.onerror = () => reject(req.error);
    });
    if (url) cache.set(id, url);
    return url;
  } catch {
    return undefined;
  }
}

export function useImageUrl(id: string | undefined) {
  const [url, setUrl] = useState(() => (id ? cache.get(id) : undefined));
  useEffect(() => {
    if (!id) return;
    let alive = true;
    const load = () => getImage(id).then((u) => alive && setUrl(u));
    load();
    listeners.add(load);
    return () => {
      alive = false;
      listeners.delete(load);
    };
  }, [id]);
  return url;
}

/** Legge un file immagine, lo riduce se troppo grande e restituisce dati e proporzioni */
export function readImageFile(file: File, maxSide = 4000): Promise<{ dataUrl: string; w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(fr.error);
    fr.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Formato immagine non supportato'));
      img.onload = () => {
        const k = Math.min(1, maxSide / Math.max(img.width, img.height));
        if (k === 1) return resolve({ dataUrl: fr.result as string, w: img.width, h: img.height });
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k);
        c.height = Math.round(img.height * k);
        c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
        resolve({ dataUrl: c.toDataURL('image/jpeg', 0.9), w: c.width, h: c.height });
      };
      img.src = fr.result as string;
    };
    fr.readAsDataURL(file);
  });
}
