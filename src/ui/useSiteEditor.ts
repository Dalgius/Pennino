// Logica di disegno e modifica comune a planimetria (01) e cantiere (05):
// selezione, maniglie, spostamenti, disegno di punti, polilinee e poligoni.

import { useEffect, useRef, useState } from 'react';
import { useStore, type Selection } from '../model/store';
import type { ContextItem, Project, SiteItem, Vec2 } from '../model/types';
import { dist } from '../model/geometry';
import { getHandles, setHandle, siteItemsInRect, snapPoint, translate } from '../model/edit';
import type { CanvasPointer } from './Canvas2D';

export type Editable = SiteItem | ContextItem | { id: string; kind: 'lotto'; points: Vec2[] };
export type DrawKind = 'point' | 'polyline' | 'polygon' | null;

interface Options {
  scope: Selection['scope'];
  tool: string;
  drawKind: DrawKind;
  list: (p: Project) => Editable[];
  hitTest: (p: Project, w: Vec2, tol: number) => string | null;
  onCreate: (points: Vec2[]) => void;
  onDelete: (ids: string[]) => void;
  /** Punti notevoli aggiuntivi per l'aggancio */
  extraSnaps?: Vec2[];
}

export function useSiteEditor(o: Options) {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const editLive = useStore((s) => s.editLive);
  const checkpoint = useStore((s) => s.checkpoint);
  const [draft, setDraft] = useState<Vec2[]>([]);
  const [cursor, setCursor] = useState<Vec2 | null>(null);
  const ortho = useStore((s) => s.drafting.ortho);
  const setDrafting = useStore((s) => s.setDrafting);
  const setOrtho = (v: boolean) => setDrafting({ ortho: v });
  const drag = useRef<{ id: string; ids: string[]; handle: number | null; start: Vec2; orig: Project; moved: boolean } | null>(null);
  // selezione a riquadro: da sinistra a destra = finestra, da destra a sinistra = intersezione
  const [marquee, setMarquee] = useState<{ a: Vec2; b: Vec2; add: boolean } | null>(null);
  const selectedIds = selection.scope === o.scope ? selection.ids : [];

  useEffect(() => setDraft([]), [o.tool]);

  const snapsOf = (p: Project) => {
    const out: { p: Vec2; kind: 'estremo' }[] = [];
    for (const it of o.list(p)) for (const h of getHandles(it as never)) out.push({ p: h, kind: 'estremo' });
    for (const q of o.extraSnaps ?? []) out.push({ p: q, kind: 'estremo' });
    return out;
  };

  const finish = (pts: Vec2[]) => {
    const min = o.drawKind === 'polygon' ? 3 : 2;
    if (pts.length >= min) o.onCreate(pts);
    setDraft([]);
  };

  const onPointer = (e: CanvasPointer) => {
    const tol = 10 / e.zoom;
    const last = draft[draft.length - 1];
    const snap = snapPoint(e.world, {
      candidates: [...snapsOf(project), ...draft.map((p) => ({ p, kind: 'estremo' as const }))],
      tol,
      grid: 0.1,
      from: o.drawKind ? last : undefined,
      ortho: ortho !== e.shift,
    }).p;

    if (!o.drawKind) {
      // selezione e modifica
      if (e.type === 'down' && e.button === 0) {
        for (const id of selectedIds) {
          const it = o.list(project).find((x) => x.id === id);
          if (!it) continue;
          const hs = getHandles(it as never);
          // gli oggetti a punto non hanno vertici da modificare: il clic sposta la selezione
          if (hs.length < 2) continue;
          const hi = hs.findIndex((h) => dist(h, e.world) < tol);
          if (hi >= 0) {
            drag.current = { id, ids: [id], handle: hi, start: e.world, orig: project, moved: false };
            return;
          }
        }
        const hit = o.hitTest(project, e.world, tol);
        if (!hit) {
          // clic nel vuoto: inizia un riquadro
          setMarquee({ a: e.world, b: e.world, add: e.shift });
          if (!e.shift) select(o.scope, []);
          return;
        }
        let ids = selectedIds.includes(hit) ? selectedIds : [hit];
        if (e.shift) ids = selectedIds.includes(hit) ? selectedIds.filter((x) => x !== hit) : [...selectedIds, hit];
        select(o.scope, ids);
        if (ids.includes(hit)) drag.current = { id: hit, ids, handle: null, start: snap, orig: project, moved: false };
      } else if (e.type === 'move' && marquee) {
        setMarquee({ ...marquee, b: e.world });
      } else if (e.type === 'up' && marquee) {
        const m = marquee;
        setMarquee(null);
        if (dist(m.a, m.b) > tol) {
          const r = { minX: Math.min(m.a.x, m.b.x), minY: Math.min(m.a.y, m.b.y), maxX: Math.max(m.a.x, m.b.x), maxY: Math.max(m.a.y, m.b.y) };
          const found = siteItemsInRect(o.list(project), r, m.b.x < m.a.x);
          select(o.scope, m.add ? [...new Set([...selectedIds, ...found])] : found);
        }
      } else if (e.type === 'move') {
        setCursor(snap);
        const dr = drag.current;
        if (!dr) return;
        if (!dr.moved) {
          if (dist(e.world, dr.start) < tol * 0.5) return;
          checkpoint();
          dr.moved = true;
        }
        const src = o.list(dr.orig).find((x) => x.id === dr.id);
        if (!src) return;
        const srcHandles = getHandles(src as never).map((h) => ({ ...h }));
        if (dr.handle === null) {
          // spostamento di tutti gli oggetti selezionati
          // in ortogonale lo spostamento segue solo l'asse prevalente (Maiusc lo libera)
          const raw = { x: snap.x - dr.start.x, y: snap.y - dr.start.y };
          const delta = ortho !== e.shift ? (Math.abs(raw.x) >= Math.abs(raw.y) ? { x: raw.x, y: 0 } : { x: 0, y: raw.y }) : raw;
          const origs = new Map(o.list(dr.orig).filter((x) => dr.ids.includes(x.id)).map((x) => [x.id, getHandles(x as never).map((h) => ({ ...h }))]));
          editLive((d) => {
            for (const it of o.list(d)) {
              const hs = origs.get(it.id);
              if (!hs) continue;
              hs.forEach((h, i) => setHandle(it as never, i, h));
              translate(it as never, delta);
            }
          });
          return;
        }
        editLive((d) => {
          const it = o.list(d).find((x) => x.id === dr.id);
          if (!it) return;
          if (dr.handle !== null) {
            const pt = snapPoint(e.world, {
              candidates: snapsOf(dr.orig).filter((c) => dist(c.p, srcHandles[dr.handle!]) > 1e-6),
              tol,
              grid: 0.1,
              ortho: false,
            }).p;
            setHandle(it as never, dr.handle, pt);
            // le polilinee chiuse (primo = ultimo punto) restano chiuse
            if ('points' in it && it.points.length > 2 && dist(srcHandles[0], srcHandles[srcHandles.length - 1]) < 1e-6) {
              if (dr.handle === 0) it.points[it.points.length - 1] = pt;
              if (dr.handle === it.points.length - 1) it.points[0] = pt;
            }
          } else {
            // riporta l'oggetto alla posizione iniziale, poi trasla
            srcHandles.forEach((h, i) => setHandle(it as never, i, h));
            const raw = { x: snap.x - dr.start.x, y: snap.y - dr.start.y };
            translate(it as never, ortho !== e.shift ? (Math.abs(raw.x) >= Math.abs(raw.y) ? { x: raw.x, y: 0 } : { x: 0, y: raw.y }) : raw);
          }
        });
      } else if (e.type === 'up') drag.current = null;
      return;
    }

    setCursor(snap);
    if (e.type === 'down' && e.button === 0) {
      if (o.drawKind === 'point') return o.onCreate([snap]);
      if (draft.length >= 2 && dist(snap, draft[0]) < tol) {
        return finish(o.drawKind === 'polyline' ? [...draft, draft[0]] : draft);
      }
      if (!last || dist(last, snap) > 0.01) setDraft([...draft, snap]);
    }
    if (e.type === 'dblclick') finish(draft);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') return;
      if (e.key === 'Enter') finish(draft);
      if (e.key === 'Escape') {
        if (draft.length) setDraft([]);
        else select(o.scope, []);
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.length && !draft.length) {
        o.onDelete(selectedIds);
        select(o.scope, []);
      }
      if (e.key === 'F8') setOrtho(!useStore.getState().drafting.ortho);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        select(o.scope, o.list(useStore.getState().project).map((x) => x.id));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return { onPointer, draft, cursor, selectedIds, ortho, setOrtho, marquee };
}
