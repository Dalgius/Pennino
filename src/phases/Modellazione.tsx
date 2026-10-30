import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../model/store';
import type { BuildingElement, Project, Vec2 } from '../model/types';
import {
  add,
  bbox,
  byId,
  convexHull,
  dist,
  elementCode,
  fmt,
  fmtLevel,
  mul,
  norm,
  sortedLevels,
  sub,
  uid,
  wallLength,
  wallSegmentQuad,
  wallThickness,
} from '../model/geometry';
import { deleteElements, getHandles, hitTestModel, nearestWall, setHandle, snapPoint, snapPoints, translate, type Snap } from '../model/edit';
import { Canvas2D, type CanvasPointer } from '../ui/Canvas2D';
import { PlanView, pts, type DimTarget } from '../views/PlanView';
import { ElevationView, elevationExtents, elevationHeight, type Direction } from '../views/ElevationView';
import { Model3D } from '../views/Model3D';
import { Icon } from '../ui/icons';
import { KeyHint, Segmented } from '../ui/controls';
import { Inspector, TypeEditor, type CatalogKey } from './ModellazioneInspector';
import { applyDimension } from '../model/dimensions';
import { SCREEN_TEXT } from './Inquadramento';

export type Tool = 'select' | 'wall' | 'slab' | 'column' | 'beam' | 'door' | 'window' | 'stair' | 'roof';

const TOOLS: { id: Tool; label: string; key: string; icon: string; catalog?: CatalogKey; hint: string }[] = [
  { id: 'select', label: 'Seleziona', key: 'V', icon: 'select', hint: 'Clic per selezionare, trascina per spostare. Trascina le maniglie per modificare.' },
  { id: 'wall', label: 'Muro', key: 'M', icon: 'wall', catalog: 'wall', hint: 'Clic sui vertici del muro. Digita una lunghezza e premi Invio. Doppio clic o Esc per terminare.' },
  { id: 'slab', label: 'Solaio', key: 'S', icon: 'slab', catalog: 'slab', hint: 'Clic sui vertici del perimetro; clic sul primo punto o Invio per chiudere.' },
  { id: 'column', label: 'Pilastro', key: 'P', icon: 'column', catalog: 'column', hint: 'Clic per posizionare il pilastro.' },
  { id: 'beam', label: 'Trave', key: 'T', icon: 'beam', catalog: 'beam', hint: 'Clic su appoggio iniziale e finale.' },
  { id: 'door', label: 'Porta', key: 'O', icon: 'door', catalog: 'opening', hint: 'Avvicinati a un muro e clicca per inserire la porta. Alt inverte il verso.' },
  { id: 'window', label: 'Finestra', key: 'F', icon: 'window', catalog: 'opening', hint: 'Avvicinati a un muro e clicca per inserire la finestra.' },
  { id: 'stair', label: 'Scala', key: 'G', icon: 'stair', hint: 'Clic su partenza e arrivo della rampa: la scala sale al livello superiore.' },
  { id: 'roof', label: 'Copertura', key: 'C', icon: 'roof', catalog: 'roof', hint: 'Clic sui vertici della copertura, oppure usa «Copertura sull’edificio».' },
];

type ViewMode = 'pianta' | 'prospetti' | '3d' | 'affiancate';

interface Drag {
  kind: 'move' | 'handle' | 'opening';
  id: string;
  handle?: number;
  start: Vec2;
  orig: Project;
  moved: boolean;
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
  });
  const [editingType, setEditingType] = useState<{ key: CatalogKey; id: string } | null>(null);
  const [draft, setDraft] = useState<Vec2[]>([]);
  const [cursor, setCursor] = useState<Snap | null>(null);
  const [typed, setTyped] = useState('');
  const [ortho, setOrtho] = useState(true);
  const [grid, setGrid] = useState(0.05);
  const [ghost, setGhost] = useState(true);
  const [flipNext, setFlipNext] = useState(false);
  const [openingPreview, setOpeningPreview] = useState<{ wallId: string; offset: number } | null>(null);
  const drag = useRef<Drag | null>(null);
  const [dimEdit, setDimEdit] = useState<DimTarget | null>(null);
  const [dimText, setDimText] = useState('');
  const openDim = (t: DimTarget) => {
    setDimEdit(t);
    setDimText(t.value.toFixed(2));
  };
  const commitDim = () => {
    const v = parseFloat(dimText.replace(',', '.'));
    if (dimEdit && v > 0) edit((d) => applyDimension(d, dimEdit.chain, dimEdit.k, v));
    setDimEdit(null);
  };

  const levels = sortedLevels(project);
  const level = byId(project.levels, levelId) ?? levels[0];
  const lvlId = level?.id ?? '';
  const below = levels[levels.findIndex((l) => l.id === lvlId) - 1];
  const selectedIds = selection.scope === 'modello' ? selection.ids : [];
  const toolDef = TOOLS.find((t) => t.id === tool)!;

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
  };

  const changeTool = (t: Tool) => {
    setTool(t);
    resetDraft();
    setOpeningPreview(null);
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

  const candidates = useMemo(() => snapPoints(project, lvlId), [project, lvlId]);

  // ───────── Creazione elementi ─────────

  const addElement = (e: BuildingElement) => {
    edit((d) => {
      d.elements.push(e);
    });
    return e.id;
  };

  const commitPoint = (q: Vec2) => {
    const pts2 = [...draft, q];
    if (tool === 'wall') {
      if (draft.length >= 1) {
        const a = draft[draft.length - 1];
        if (dist(a, q) > 0.01)
          addElement({ id: uid('w'), kind: 'wall', levelId: lvlId, typeId: activeType.wall, a, b: q });
        if (dist(q, draft[0]) < 0.01 && draft.length > 1) return resetDraft();
      }
      setDraft(pts2);
    } else if (tool === 'slab' || tool === 'roof') {
      if (draft.length >= 3 && dist(q, draft[0]) < 0.01) return finishPolygon(draft);
      setDraft(pts2);
    } else if (tool === 'beam' || tool === 'stair') {
      if (draft.length === 1) {
        if (dist(draft[0], q) > 0.1) {
          if (tool === 'beam') addElement({ id: uid('b'), kind: 'beam', levelId: lvlId, typeId: activeType.beam, a: draft[0], b: q });
          else addElement({ id: uid('sc'), kind: 'stair', levelId: lvlId, a: draft[0], b: q, width: 1.1 });
        }
        resetDraft();
      } else setDraft([q]);
    } else if (tool === 'column') {
      addElement({ id: uid('c'), kind: 'column', levelId: lvlId, typeId: activeType.column, p: q });
    }
    setTyped('');
  };

  const finishPolygon = (poly: Vec2[]) => {
    if (poly.length < 3) return resetDraft();
    if (tool === 'slab') addElement({ id: uid('s'), kind: 'slab', levelId: lvlId, typeId: activeType.slab, points: poly });
    else addElement({ id: uid('r'), kind: 'roof', levelId: lvlId, typeId: activeType.roof, points: poly, shape: 'falde', pitch: 22, overhang: 0.5 });
    resetDraft();
  };

  /** Perimetro dei muri del livello corrente → nuovo solaio o copertura */
  const fromWalls = (kind: 'slab' | 'roof') => {
    const q: Vec2[] = [];
    for (const e of project.elements) if (e.kind === 'wall' && e.levelId === lvlId) q.push(e.a, e.b);
    if (q.length < 3) return;
    const hull = convexHull(q);
    const id =
      kind === 'slab'
        ? addElement({ id: uid('s'), kind: 'slab', levelId: lvlId, typeId: activeType.slab, points: hull })
        : addElement({ id: uid('r'), kind: 'roof', levelId: lvlId, typeId: activeType.roof, points: hull, shape: 'falde', pitch: 22, overhang: 0.5 });
    select('modello', [id]);
    changeTool('select');
  };

  // ───────── Puntatore ─────────

  const onPointer = (e: CanvasPointer) => {
    const tol = 10 / e.zoom;
    const last = draft[draft.length - 1];
    const snap = snapPoint(e.world, {
      candidates: [...candidates, ...draft.slice(0, 1).map((p) => ({ p, kind: 'estremo' as const }))],
      tol,
      grid: e.zoom > 120 ? Math.min(grid, 0.01) : grid,
      from: tool === 'select' ? undefined : last,
      ortho: ortho !== e.shift,
    });

    if (tool === 'select') return handleSelect(e, snap, tol);

    if (tool === 'door' || tool === 'window') {
      const nw = nearestWall(project, e.world, lvlId, 0.4);
      const t = byId(project.catalog.opening, activeType.opening);
      if (nw && t) {
        const wall = project.elements.find((x) => x.id === nw.id);
        const L = wall && wall.kind === 'wall' ? wallLength(wall) : 0;
        const g = 0.05;
        const offset = Math.min(L - t.width / 2, Math.max(t.width / 2, Math.round(nw.offset / g) * g));
        setOpeningPreview({ wallId: nw.id, offset });
        if (e.type === 'down' && e.button === 0) {
          const id = uid('o');
          edit((d) => {
            d.elements.push({ id, kind: 'opening', wallId: nw.id, typeId: t.id, offset, flip: flipNext !== e.alt });
          });
        }
      } else setOpeningPreview(null);
      setCursor({ p: e.world, kind: 'libero' });
      return;
    }

    setCursor(snap);
    if (e.type === 'down' && e.button === 0) commitPoint(snap.p);
    if (e.type === 'dblclick') {
      if (tool === 'slab' || tool === 'roof') finishPolygon(draft.slice(0, -1).length >= 3 ? draft.slice(0, -1) : draft);
      else resetDraft();
    }
  };

  const handleSelect = (e: CanvasPointer, snap: Snap, tol: number) => {
    if (e.type === 'down' && e.button === 0) {
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
      }
      const hit = hitTestModel(project, e.world, lvlId, tol);
      if (hit) {
        if (e.shift) {
          select('modello', selectedIds.includes(hit) ? selectedIds.filter((x) => x !== hit) : [...selectedIds, hit]);
        } else if (!selectedIds.includes(hit)) select('modello', [hit]);
        const el = project.elements.find((x) => x.id === hit);
        drag.current = { kind: el?.kind === 'opening' ? 'opening' : 'move', id: hit, start: snap.p, orig: project, moved: false };
        setEditingType(null);
      } else {
        select('modello', []);
      }
      return;
    }
    if (e.type === 'move') {
      setCursor(snap);
      const dr = drag.current;
      if (!dr) return;
      if (!dr.moved) {
        if (dist(e.world, dr.start) < tol * 0.5) return;
        checkpoint();
        dr.moved = true;
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
        const offset = Math.min(L - t.width / 2, Math.max(t.width / 2, Math.round(s / 0.05) * 0.05));
        editLive((d) => {
          const x = d.elements.find((q) => q.id === dr.id);
          if (x && x.kind === 'opening') x.offset = offset;
        });
        return;
      }
      if (dr.kind === 'handle') {
        const el = o.elements.find((x) => x.id === dr.id)!;
        const orig = getHandles(el)[dr.handle!];
        const other = el.kind === 'wall' || el.kind === 'beam' || el.kind === 'stair' ? getHandles(el)[dr.handle! === 0 ? 1 : 0] : undefined;
        const sp = snapPoint(e.world, {
          candidates: candidates.filter((c) => dist(c.p, orig) > 1e-6),
          tol,
          grid,
          from: other,
          ortho: other ? ortho !== e.shift : false,
        });
        editLive((d) => {
          const x = d.elements.find((q) => q.id === dr.id)!;
          setHandle(x, dr.handle!, sp.p);
          if (el.kind === 'wall') moveJoined(d, o, el.levelId, dr.id, [orig], sub(sp.p, orig));
        });
        return;
      }
      // spostamento dell'elemento (o della selezione)
      const delta = sub(snap.p, dr.start);
      const ids = selectedIds.includes(dr.id) ? selectedIds : [dr.id];
      editLive((d) => {
        for (const id of ids) {
          const src = o.elements.find((q) => q.id === id);
          const x = d.elements.findIndex((q) => q.id === id);
          if (!src || x < 0 || src.kind === 'opening') continue;
          const copy = JSON.parse(JSON.stringify(src)) as BuildingElement;
          translate(copy, delta);
          d.elements[x] = copy;
          if (src.kind === 'wall' && ids.length === 1) moveJoined(d, o, src.levelId, id, [src.a, src.b], delta);
        }
      });
      return;
    }
    if (e.type === 'up') drag.current = null;
  };

  // ───────── Tastiera ─────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA') return;
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
      if ((k === 'Delete' || k === 'Backspace') && selectedIds.length) {
        edit((d) => deleteElements(d, selectedIds));
        select('modello', []);
        return;
      }
      if (k === 'F8') {
        setOrtho((o) => !o);
        return;
      }
      const t = TOOLS.find((x) => x.key.toLowerCase() === k.toLowerCase());
      if (t) changeTool(t.id);
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

  const planCanvas = (
    <Canvas2D
      bounds={bounds}
      onPointer={onPointer}
      cursor={tool === 'select' ? 'default' : 'crosshair'}
      hud={
        <div className="canvas-hud-top">
          <span className="chip">
            <b>{level?.name}</b>
            <span className="mono">{fmtLevel(level?.elevation ?? 0)}</span>
          </span>
          <button className={`chip ${ortho ? 'chip-on' : ''}`} onClick={() => setOrtho(!ortho)} title="F8 · Maiusc per disegno libero">
            Ortogonale
          </button>
          <select className="chip" value={grid} onChange={(e) => setGrid(parseFloat(e.target.value))} title="Passo di aggancio">
            <option value={0.01}>Passo 1 cm</option>
            <option value={0.05}>Passo 5 cm</option>
            <option value={0.1}>Passo 10 cm</option>
            <option value={0.5}>Passo 50 cm</option>
          </select>
          {below && (
            <button className={`chip ${ghost ? 'chip-on' : ''}`} onClick={() => setGhost(!ghost)} title="Mostra in trasparenza il livello inferiore">
              Sottostante: {below.name}
            </button>
          )}
        </div>
      }
    >
      {(z) => {
        const mm = 3 / z;
        return (
          <>
            <PlanView
              project={project}
              levelId={lvlId}
              mm={mm}
              selectedIds={selectedIds}
              ghostLevelId={ghost ? below?.id : undefined}
              showDimensions={z > 18}
              textScale={SCREEN_TEXT}
              onDimEdit={tool === 'select' ? openDim : undefined}
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
            />
            {dimEdit && (
              <g transform={`translate(${dimEdit.at.x} ${-dimEdit.at.y}) scale(${1 / z})`}>
                <foreignObject x={-62} y={-17} width={124} height={34}>
                  <div data-hud className="dim-input">
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
            {TOOLS.map((t) => (
              <button
                key={t.id}
                className={`tool ${tool === t.id ? 'on' : ''}`}
                onClick={() => changeTool(t.id)}
                title={`${t.label} (${t.key})`}
              >
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
          {(tool === 'door') && (
            <label className="check">
              <input type="checkbox" checked={flipNext} onChange={(e) => setFlipNext(e.target.checked)} /> Apertura verso l’altro lato
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
          {(view === '3d' || view === 'affiancate') && (
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
          )}
        </div>
        <div className="prompt">
          <span className="prompt-label">{toolDef.label}</span>
          <span className="prompt-text">{toolDef.hint}</span>
          {typed && (
            <span className="prompt-typed mono">
              L = {typed} m <kbd>Invio</kbd>
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
            <Inspector ids={selectedIds} onEditType={(key, id) => setEditingType({ key, id })} />
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

/** Trascinando un estremo di un muro, segue anche l'estremo dei muri collegati */
function moveJoined(d: Project, orig: Project, levelId: string, selfId: string, points: Vec2[], delta: Vec2) {
  for (const src of orig.elements) {
    if (src.kind !== 'wall' || src.id === selfId || src.levelId !== levelId) continue;
    const tgt = d.elements.find((x) => x.id === src.id);
    if (!tgt || tgt.kind !== 'wall') continue;
    for (const p of points) {
      if (dist(src.a, p) < 0.01) tgt.a = add(src.a, delta);
      if (dist(src.b, p) < 0.01) tgt.b = add(src.b, delta);
    }
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
}: {
  tool: Tool;
  draft: Vec2[];
  cursor?: Vec2;
  snapKind?: Snap['kind'];
  mm: number;
  typed: string;
  previewLen: number;
  thickness: number;
}) {
  const last = draft[draft.length - 1];
  const chain = cursor && tool !== 'select' ? [...draft, cursor] : draft;
  const closed = tool === 'slab' || tool === 'roof';
  return (
    <g className="draft" pointerEvents="none">
      {tool === 'wall' && last && cursor && dist(last, cursor) > 0.01 && (
        <polygon
          points={pts(wallSegmentQuad({ a: last, b: cursor } as never, thickness, 0, dist(last, cursor)))}
          className="draft-wall"
          strokeWidth={0.25 * mm}
        />
      )}
      {chain.length > 1 && (closed ? <polygon points={pts(chain)} className="draft-poly" strokeWidth={0.35 * mm} /> : <polyline points={pts(chain)} className="draft-line" strokeWidth={0.35 * mm} />)}
      {draft.map((p, i) => (
        <rect key={i} x={p.x - 0.8 * mm} y={-p.y - 0.8 * mm} width={1.6 * mm} height={1.6 * mm} className="draft-vertex" />
      ))}
      {cursor && tool !== 'select' && (
        <g>
          <line x1={cursor.x - 4 * mm} y1={-cursor.y} x2={cursor.x + 4 * mm} y2={-cursor.y} className="draft-cross" strokeWidth={0.2 * mm} />
          <line x1={cursor.x} y1={-cursor.y - 4 * mm} x2={cursor.x} y2={-cursor.y + 4 * mm} className="draft-cross" strokeWidth={0.2 * mm} />
          {snapKind === 'estremo' && <rect x={cursor.x - 1.6 * mm} y={-cursor.y - 1.6 * mm} width={3.2 * mm} height={3.2 * mm} className="snap-mark" strokeWidth={0.3 * mm} />}
          {snapKind === 'medio' && (
            <polygon
              points={`${cursor.x},${-cursor.y - 2 * mm} ${cursor.x + 1.8 * mm},${-cursor.y + 1.2 * mm} ${cursor.x - 1.8 * mm},${-cursor.y + 1.2 * mm}`}
              className="snap-mark"
              strokeWidth={0.3 * mm}
            />
          )}
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
        {t?.layers.map((l, i) => (
          <span key={i} style={{ background: l.color, flexGrow: l.thickness }} />
        ))}
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
