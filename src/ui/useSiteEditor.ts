// Logica di disegno e modifica comune a planimetria (01) e cantiere (05):
// selezione, maniglie, spostamenti, disegno di punti, polilinee e poligoni.

import { useEffect, useRef, useState } from 'react';
import { useStore, type Selection } from '../model/store';
import type { ContextItem, Project, SiteItem, Vec2 } from '../model/types';
import { dist } from '../model/geometry';
import { getHandles, setHandle, snapPoint, translate } from '../model/edit';
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
  const [ortho, setOrtho] = useState(false);
  const drag = useRef<{ id: string; handle: number | null; start: Vec2; orig: Project; moved: boolean } | null>(null);
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
          const hi = getHandles(it as never).findIndex((h) => dist(h, e.world) < tol);
          if (hi >= 0) {
            drag.current = { id, handle: hi, start: e.world, orig: project, moved: false };
            return;
          }
        }
        const hit = o.hitTest(project, e.world, tol);
        select(o.scope, hit ? [hit] : []);
        if (hit) drag.current = { id: hit, handle: null, start: snap, orig: project, moved: false };
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
            translate(it as never, { x: snap.x - dr.start.x, y: snap.y - dr.start.y });
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
      if (e.key === 'F8') setOrtho((x) => !x);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return { onPointer, draft, cursor, selectedIds, ortho, setOrtho };
}
