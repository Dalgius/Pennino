import { useMemo, useRef, useState } from 'react';
import { useStore } from '../model/store';
import type { ContextItem, Project, Underlay, Vec2 } from '../model/types';
import {
  bbox,
  buildingHeight,
  distToPolyline,
  fmt,
  fmtLevel,
  footprintPoints,
  pointInPolygon,
  polygonArea,
  sortedLevels,
  sunPosition,
  uid,
} from '../model/geometry';
import { hitTestSite } from '../model/edit';
import { projectMetrics } from '../model/quantities';
import { Canvas2D, type CanvasPointer } from '../ui/Canvas2D';
import { putImage, readImageFile } from '../model/images';
import { UnderlayLayer } from '../views/UnderlayLayer';
import { NumberField, Panel, Segmented, TextField } from '../ui/controls';
import { Icon } from '../ui/icons';
import { useSiteEditor, type DrawKind, type Editable } from '../ui/useSiteEditor';
import { SiteView } from '../views/SiteView';
import { ElevationView, elevationExtents } from '../views/ElevationView';
import { pts } from '../views/PlanView';
import { geocode, gridConvergence, suggestedCrs, terrainElevation, toUtm, type GeoResult } from '../model/geo';

/** Ingrandimento dei testi nelle viste a schermo rispetto alla stampa */
export const SCREEN_TEXT = 1.8;

type SiteTool = 'select' | 'lotto' | 'edificio' | 'strada' | 'albero';

const SITE_TOOLS: { id: SiteTool; label: string; icon: string; draw: DrawKind; hint: string }[] = [
  { id: 'select', label: 'Seleziona', icon: 'select', draw: null, hint: 'Seleziona lotto o elementi di contesto; trascina i vertici per modificarli.' },
  { id: 'lotto', label: 'Lotto', icon: 'lot', draw: 'polygon', hint: 'Ridisegna il perimetro del lotto: clic sui vertici, Invio per chiudere.' },
  { id: 'edificio', label: 'Edificio esistente', icon: 'building', draw: 'polygon', hint: 'Disegna l’impronta di un edificio del contesto.' },
  { id: 'strada', label: 'Strada', icon: 'road', draw: 'polyline', hint: 'Disegna l’asse stradale: doppio clic o Invio per terminare.' },
  { id: 'albero', label: 'Albero', icon: 'tree', draw: 'point', hint: 'Clic per posizionare un albero.' },
];

export function contextList(p: Project): Editable[] {
  const lot = p.site;
  const lotItem = {
    id: 'lot',
    kind: 'lotto' as const,
    get points() {
      return lot.lot;
    },
    set points(v: Vec2[]) {
      lot.lot = v;
    },
  };
  return [lotItem, ...p.site.context];
}

export function SiteDraft({ draft, cursor, mm, closed }: { draft: Vec2[]; cursor: Vec2 | null; mm: number; closed: boolean }) {
  const chain = cursor && draft.length ? [...draft, cursor] : draft;
  return (
    <g className="draft" pointerEvents="none">
      {chain.length > 1 && (closed ? <polygon points={pts(chain)} className="draft-poly" strokeWidth={0.35 * mm} /> : <polyline points={pts(chain)} className="draft-line" strokeWidth={0.35 * mm} />)}
      {draft.map((p, i) => (
        <rect key={i} x={p.x - 0.8 * mm} y={-p.y - 0.8 * mm} width={1.6 * mm} height={1.6 * mm} className="draft-vertex" />
      ))}
      {cursor && (
        <g>
          <line x1={cursor.x - 4 * mm} y1={-cursor.y} x2={cursor.x + 4 * mm} y2={-cursor.y} className="draft-cross" strokeWidth={0.2 * mm} />
          <line x1={cursor.x} y1={-cursor.y - 4 * mm} x2={cursor.x} y2={-cursor.y + 4 * mm} className="draft-cross" strokeWidth={0.2 * mm} />
        </g>
      )}
    </g>
  );
}

export function SelectionHandles({ items, ids, mm }: { items: Editable[]; ids: string[]; mm: number }) {
  return (
    <g pointerEvents="none">
      {items
        .filter((i) => ids.includes(i.id))
        .map((i) => {
          const hs = 'points' in i ? i.points : 'p' in i ? [i.p] : [];
          return (
            <g key={i.id} className="pv-sel" strokeWidth={0.4 * mm}>
              {'points' in i && <polyline points={pts(i.points)} />}
              {hs.map((h, k) => (
                <circle key={k} cx={h.x} cy={-h.y} r={1.3 * mm} className="pv-handle" />
              ))}
            </g>
          );
        })}
    </g>
  );
}

export function Inquadramento() {
  const project = useStore((s) => s.project);
  const edit = useStore((s) => s.edit);
  const [tool, setTool] = useState<SiteTool>('select');
  const [view, setView] = useState<'planimetria' | 'sezione'>('planimetria');
  const toolDef = SITE_TOOLS.find((t) => t.id === tool)!;
  const site = project.site;

  const editor = useSiteEditor({
    scope: 'contesto',
    tool,
    drawKind: toolDef.draw,
    list: contextList,
    hitTest: (p, w, tol) => hitTestSite(p.site.context, w, tol) ?? (p.site.lot.length > 2 && (pointInPolygon(w, p.site.lot) || distToPolyline(w, p.site.lot, true) < tol) ? 'lot' : null),
    extraSnaps: footprintPoints(project),
    onCreate: (points) => {
      edit((d) => {
        if (tool === 'lotto') d.site.lot = points;
        else if (tool === 'edificio') d.site.context.push({ id: uid('k'), kind: 'edificio', name: 'Edificio esistente', points, height: 7 });
        else if (tool === 'strada') d.site.context.push({ id: uid('k'), kind: 'strada', name: 'Strada', points, width: 7 });
        else if (tool === 'albero') d.site.context.push({ id: uid('k'), kind: 'albero', name: 'Albero', p: points[0], radius: 2.5 });
      });
      if (tool === 'lotto') setTool('select');
    },
    onDelete: (ids) =>
      edit((d) => {
        d.site.context = d.site.context.filter((c) => !ids.includes(c.id));
      }),
  });

  const bounds = useMemo(() => {
    const all: Vec2[] = [...site.lot, ...footprintPoints(project)];
    const b = all.length ? bbox(all) : { minX: -20, minY: -20, maxX: 20, maxY: 20 };
    return { minX: b.minX - 8, minY: b.minY - 8, maxX: b.maxX + 8, maxY: b.maxY + 8 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ───── Basi raster ─────
  const underlays = site.underlays ?? [];
  const [rasterId, setRasterId] = useState<string | null>(null);
  const [rasterMode, setRasterMode] = useState<'sposta' | 'calibra' | null>(null);
  const [calib, setCalib] = useState<Vec2[]>([]);
  const [calibLen, setCalibLen] = useState('');
  const [rasterCursor, setRasterCursor] = useState<Vec2 | null>(null);
  const rasterDrag = useRef<{ start: Vec2; x: number; y: number; moved: boolean } | null>(null);
  const checkpoint = useStore((s) => s.checkpoint);
  const editLive = useStore((s) => s.editLive);
  const fileRef = useRef<HTMLInputElement>(null);
  const activeRaster = underlays.find((u) => u.id === rasterId);

  const startRasterMode = (id: string, mode: 'sposta' | 'calibra') => {
    setRasterId(id);
    setRasterMode(mode);
    setCalib([]);
    setCalibLen('');
  };
  const stopRasterMode = () => {
    setRasterMode(null);
    setCalib([]);
    setRasterCursor(null);
  };

  const importRaster = async (file: File) => {
    try {
      const img = await readImageFile(file);
      const imageId = uid('img');
      await putImage(imageId, img.dataUrl);
      // prima collocazione: centrata sul lotto, larga una volta e mezza il lotto
      const ref = site.lot.length > 2 ? bbox(site.lot) : { minX: -20, minY: -20, maxX: 20, maxY: 20, w: 40, h: 40 };
      const width = Math.max(ref.w, ref.h) * 1.5;
      const height = (width * img.h) / img.w;
      const id = uid('ras');
      edit((d) => {
        d.site.underlays = [
          ...(d.site.underlays ?? []),
          {
            id,
            name: file.name.replace(/\.[^.]+$/, ''),
            imageId,
            x: (ref.minX + ref.maxX) / 2 - width / 2,
            y: (ref.minY + ref.maxY) / 2 - height / 2,
            width,
            height,
            rotation: 0,
            opacity: 0.6,
            visible: true,
          },
        ];
      });
      startRasterMode(id, 'calibra');
    } catch {
      alert('Impossibile leggere l’immagine. Usa un file PNG o JPG (un PDF va prima esportato come immagine).');
    }
  };

  const onRasterPointer = (e: CanvasPointer) => {
    if (!activeRaster) return;
    if (rasterMode === 'calibra') {
      setRasterCursor(e.world);
      if (e.type === 'down' && e.button === 0 && calib.length < 2) setCalib([...calib, e.world]);
      return;
    }
    // sposta
    if (e.type === 'down' && e.button === 0) rasterDrag.current = { start: e.world, x: activeRaster.x, y: activeRaster.y, moved: false };
    else if (e.type === 'move' && rasterDrag.current) {
      const d0 = rasterDrag.current;
      if (!d0.moved) {
        checkpoint();
        d0.moved = true;
      }
      editLive((d) => {
        const u = d.site.underlays?.find((x) => x.id === activeRaster.id);
        if (u) {
          u.x = d0.x + e.world.x - d0.start.x;
          u.y = d0.y + e.world.y - d0.start.y;
        }
      });
    } else if (e.type === 'up') rasterDrag.current = null;
  };

  const applyCalibration = () => {
    const real = parseFloat(calibLen.replace(',', '.'));
    if (!activeRaster || calib.length < 2 || !(real > 0)) return;
    const measured = Math.hypot(calib[1].x - calib[0].x, calib[1].y - calib[0].y);
    if (measured < 1e-6) return;
    const k = real / measured;
    const p0 = calib[0];
    edit((d) => {
      const u = d.site.underlays?.find((x) => x.id === activeRaster.id);
      if (!u) return;
      u.x = p0.x + (u.x - p0.x) * k;
      u.y = p0.y + (u.y - p0.y) * k;
      u.width *= k;
      u.height *= k;
    });
    stopRasterMode();
  };

  const selected = editor.selectedIds[0];
  const selItem = selected && selected !== 'lot' ? site.context.find((c) => c.id === selected) : undefined;

  return (
    <div className="workspace">
      <aside className="side side-left">
        <div className="side-scroll">
          <div className="side-title">
            <span className="phase-num">01</span> Inquadramento
          </div>
          <LevelsPanel />
          <RasterPanel
            activeId={rasterId}
            mode={rasterMode}
            onImport={() => fileRef.current?.click()}
            onMode={(id, m) => (m ? startRasterMode(id, m) : stopRasterMode())}
            onSelect={setRasterId}
          />
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importRaster(f);
              e.target.value = '';
            }}
          />
        </div>
      </aside>

      <main className="stage">
        <div className="stage-bar">
          <Segmented
            value={view}
            onChange={setView}
            options={[
              { value: 'planimetria', label: 'Planimetria e contesto' },
              { value: 'sezione', label: 'Quote e altezze' },
            ]}
          />
          {view === 'planimetria' && (
            <div className="stage-bar-right">
              {SITE_TOOLS.map((t) => (
                <button key={t.id} className={`tab tab-icon ${tool === t.id ? 'on' : ''}`} onClick={() => setTool(t.id)} title={t.hint}>
                  <Icon name={t.icon} size={16} /> {t.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="stage-body">
          {view === 'planimetria' ? (
            <Canvas2D
              bounds={bounds}
              onPointer={rasterMode ? onRasterPointer : editor.onPointer}
              cursor={rasterMode === 'sposta' ? 'move' : tool === 'select' && !rasterMode ? 'default' : 'crosshair'}
              hud={
                rasterMode && activeRaster ? (
                  <div className="canvas-hud-top raster-hud">
                    {rasterMode === 'sposta' ? (
                      <span className="chip">Trascina «{activeRaster.name}» nella posizione corretta</span>
                    ) : calib.length < 2 ? (
                      <span className="chip">
                        Calibra «{activeRaster.name}»: clic sul {calib.length === 0 ? 'primo' : 'secondo'} punto di una misura nota (zoom per precisione)
                      </span>
                    ) : (
                      <span className="chip raster-calib">
                        Distanza reale tra i due punti
                        <input
                          autoFocus
                          className="mono"
                          value={calibLen}
                          placeholder="es. 25.40"
                          onChange={(ev) => setCalibLen(ev.target.value)}
                          onKeyDown={(ev) => ev.key === 'Enter' && applyCalibration()}
                        />
                        m
                        <button className="btn btn-primary" onClick={applyCalibration}>Applica scala</button>
                      </span>
                    )}
                    <button className="chip" onClick={stopRasterMode}>{rasterMode === 'sposta' ? 'Fine' : 'Annulla'}</button>
                  </div>
                ) : undefined
              }
            >
              {(z) => {
                const mm = 3 / z;
                return (
                  <>
                    <UnderlayLayer underlays={underlays} selectedId={rasterMode ? rasterId : null} />
                    {rasterMode === 'calibra' && (
                      <SiteDraft draft={calib} cursor={calib.length < 2 ? rasterCursor : null} mm={mm} closed={false} />
                    )}
                    <SiteView project={project} mm={mm} selectedIds={editor.selectedIds} textScale={SCREEN_TEXT} />
                    <SelectionHandles items={contextList(project)} ids={editor.selectedIds} mm={mm} />
                    <SiteDraft draft={editor.draft} cursor={toolDef.draw ? editor.cursor : null} mm={mm} closed={toolDef.draw === 'polygon'} />
                  </>
                );
              }}
            </Canvas2D>
          ) : (
            <LevelsSection project={project} />
          )}
        </div>
        <div className="prompt">
          <span className="prompt-label">{view === 'planimetria' ? (rasterMode ? 'Raster' : toolDef.label) : 'Quote'}</span>
          <span className="prompt-text">
            {view === 'planimetria'
              ? rasterMode === 'calibra'
                ? 'Scegli due punti di cui conosci la distanza reale (un lato del lotto, una quota del catastale), poi scrivi la misura.'
                : rasterMode === 'sposta'
                  ? 'Trascina il raster per sovrapporlo al lotto. Rotazione e trasparenza nel pannello a sinistra.'
                  : toolDef.hint
              : 'Sezione schematica: livelli, terreno naturale e altezza massima ammessa. Si aggiorna con il modello.'}
          </span>
        </div>
      </main>

      <aside className="side side-right">
        <div className="side-scroll">
          {selItem ? <ContextInspector item={selItem} /> : <SitePanels />}
        </div>
      </aside>
    </div>
  );
}

function RasterPanel({
  activeId,
  mode,
  onImport,
  onMode,
  onSelect,
}: {
  activeId: string | null;
  mode: 'sposta' | 'calibra' | null;
  onImport: () => void;
  onMode: (id: string, m: 'sposta' | 'calibra' | null) => void;
  onSelect: (id: string) => void;
}) {
  const underlays = useStore((s) => s.project.site.underlays) ?? [];
  const edit = useStore((s) => s.edit);
  const upd = (id: string, fn: (u: Underlay) => void) =>
    edit((d) => {
      const u = d.site.underlays?.find((x) => x.id === id);
      if (u) fn(u);
    });
  return (
    <>
      <div className="subhead">
        Basi raster
        <button className="link" onClick={onImport}>+ Importa immagine</button>
      </div>
      {!underlays.length && (
        <p className="note">Importa un estratto catastale, una planimetria o un’ortofoto (PNG o JPG), calibrane la scala e ridisegna sopra lotto e contesto.</p>
      )}
      {underlays.map((u) => (
        <div key={u.id} className={`level-card ${u.id === activeId ? 'raster-on' : ''}`} onClick={() => onSelect(u.id)}>
          <div className="raster-head">
            <label className="check">
              <input type="checkbox" checked={u.visible} onChange={(e) => upd(u.id, (x) => (x.visible = e.target.checked))} />
            </label>
            <TextField label="Nome" value={u.name} onChange={(v) => upd(u.id, (x) => (x.name = v))} />
          </div>
          <div className="fields fields-2">
            <NumberField label="Larghezza reale" unit="m" value={u.width} min={0.1} onChange={(v) => upd(u.id, (x) => { x.height *= v / x.width; x.width = v; })} />
            <NumberField label="Rotazione" unit="°" digits={2} step={0.5} value={u.rotation} onChange={(v) => upd(u.id, (x) => (x.rotation = v))} />
          </div>
          <label className="field">
            <span className="field-label">Opacità {Math.round(u.opacity * 100)}%</span>
            <input type="range" min={0.1} max={1} step={0.05} value={u.opacity} onChange={(e) => upd(u.id, (x) => (x.opacity = parseFloat(e.target.value)))} />
          </label>
          <div className="level-card-foot">
            <button className={`link ${mode === 'calibra' && u.id === activeId ? 'strong' : ''}`} onClick={() => onMode(u.id, mode === 'calibra' && u.id === activeId ? null : 'calibra')}>Calibra scala</button>
            <button className={`link ${mode === 'sposta' && u.id === activeId ? 'strong' : ''}`} onClick={() => onMode(u.id, mode === 'sposta' && u.id === activeId ? null : 'sposta')}>Sposta</button>
            <span className="spacer" />
            <button className="link link-danger" onClick={() => edit((d) => void (d.site.underlays = (d.site.underlays ?? []).filter((x) => x.id !== u.id)))}>Rimuovi</button>
          </div>
        </div>
      ))}
    </>
  );
}

function LevelsPanel() {
  const project = useStore((s) => s.project);
  const edit = useStore((s) => s.edit);
  const setActive = useStore((s) => s.setActiveLevel);
  const [chain, setChain] = useState(true);
  const levels = [...sortedLevels(project)].reverse();

  const setElevation = (id: string, v: number) =>
    edit((d) => {
      const l = d.levels.find((x) => x.id === id)!;
      const delta = v - l.elevation;
      for (const o of d.levels) if (o.id === id || (chain && o.elevation > l.elevation)) o.elevation = +(o.elevation + delta).toFixed(4);
    });
  const setHeight = (id: string, v: number) =>
    edit((d) => {
      const l = d.levels.find((x) => x.id === id)!;
      const delta = v - l.height;
      l.height = v;
      if (chain) for (const o of d.levels) if (o.elevation > l.elevation) o.elevation = +(o.elevation + delta).toFixed(4);
    });

  return (
    <>
      <div className="subhead">Livelli e quote</div>
      <div className="level-cards">
        {levels.map((l) => {
          const n = project.elements.filter((e) => 'levelId' in e && e.levelId === l.id).length;
          return (
            <div key={l.id} className={`level-card ${l.kind === 'copertura' ? 'level-card-roof' : ''}`}>
              <div className="level-card-head">
                <TextField label="Nome" value={l.name} onChange={(v) => edit((d) => void (d.levels.find((x) => x.id === l.id)!.name = v))} />
                <span className="level-elev mono">{fmtLevel(l.elevation)}</span>
              </div>
              <div className="fields fields-2">
                {l.kind === 'copertura' ? (
                  <>
                    <NumberField label="Quota d’imposta" unit="m" value={l.elevation} onChange={(v) => setElevation(l.id, v)} />
                    <div className="field">
                      <span className="field-label">Livello</span>
                      <span className="level-kind">Coperture</span>
                    </div>
                  </>
                ) : (
                  <>
                    <NumberField label="Quota piano finito" unit="m" value={l.elevation} onChange={(v) => setElevation(l.id, v)} />
                    <NumberField label="Interpiano" unit="m" value={l.height} min={1} onChange={(v) => setHeight(l.id, v)} />
                  </>
                )}
              </div>
              <div className="level-card-foot">
                <span className="muted">{n} elementi · s.l.m. {fmt(project.site.altitude + l.elevation, 2)} m</span>
                <button className="link" onClick={() => setActive(l.id)}>Attivo</button>
                <button
                  className="link link-danger"
                  disabled={project.levels.length < 2}
                  onClick={() => {
                    if (n > 0 && !confirm(`Eliminare «${l.name}» e i suoi ${n} elementi?`)) return;
                    edit((d) => {
                      d.levels = d.levels.filter((x) => x.id !== l.id);
                      const gone = new Set(d.elements.filter((e) => 'levelId' in e && e.levelId === l.id).map((e) => e.id));
                      d.elements = d.elements.filter((e) => !gone.has(e.id) && !(e.kind === 'opening' && gone.has(e.wallId)));
                    });
                    if (useStore.getState().activeLevelId === l.id) setActive(useStore.getState().project.levels[0]?.id ?? '');
                  }}
                >
                  Elimina
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <label className="check">
        <input type="checkbox" checked={chain} onChange={(e) => setChain(e.target.checked)} /> Le quote superiori seguono gli interpiani
      </label>
      <button
        className="btn btn-block"
        onClick={() =>
          edit((d) => {
            // il nuovo piano va sotto il livello delle coperture, che sale di un interpiano
            const sorted = [...d.levels].sort((a, b) => b.elevation - a.elevation);
            const roof = sorted.find((x) => x.kind === 'copertura');
            const top = sorted.find((x) => x.kind !== 'copertura');
            const elevation = top ? +(top.elevation + top.height).toFixed(3) : 0;
            d.levels.push({ id: uid('lvl'), name: `Livello ${d.levels.length}`, elevation, height: 3 });
            if (roof && roof.elevation <= elevation + 1e-6) roof.elevation = +(elevation + 3).toFixed(3);
          })
        }
      >
        <Icon name="plus" size={14} /> Aggiungi livello superiore
      </button>
      {!project.levels.some((l) => l.kind === 'copertura') && (
        <button
          className="btn btn-block"
          onClick={() =>
            edit((d) => {
              const top = [...d.levels].sort((a, b) => b.elevation - a.elevation)[0];
              const elevation = top ? +(top.elevation + top.height).toFixed(3) : 3;
              d.levels.push({ id: uid('lvl'), name: 'Copertura', elevation, height: 0, kind: 'copertura' });
            })
          }
        >
          <Icon name="roof" size={14} /> Aggiungi livello delle coperture
        </button>
      )}
      <button
        className="btn btn-block"
        onClick={() =>
          edit((d) => {
            const bottom = [...d.levels].sort((a, b) => a.elevation - b.elevation)[0];
            const h = 2.7;
            d.levels.push({ id: uid('lvl'), name: 'Piano interrato', elevation: +((bottom?.elevation ?? 0) - h).toFixed(3), height: h });
          })
        }
      >
        <Icon name="plus" size={14} /> Aggiungi livello interrato
      </button>
      <p className="note">Muri e pilastri seguono automaticamente quote e interpiani: modificali qui e il modello, i fogli e il computo si aggiornano.</p>
    </>
  );
}

function SitePanels() {
  const project = useStore((s) => s.project);
  const edit = useStore((s) => s.edit);
  const site = project.site;
  const set = (fn: (s: Project['site']) => void) => edit((d) => fn(d.site));
  const sun = sunPosition(site.latitude, site.longitude, site.sun.month, site.sun.day, site.sun.hour);
  const h = buildingHeight(project);
  const m = projectMetrics(project);
  const minDist = boundaryDistance(project);

  return (
    <>
      <LocationPanel />

      <Panel title="Orientamento e soleggiamento">
        <div className="sun-row">
          <SunCompass trueNorth={site.trueNorth} azimuth={sun.azimuth} altitude={sun.altitude} />
          <div className="fields">
            <NumberField label="Nord geografico" unit="°" digits={1} step={1} value={site.trueNorth} min={-180} max={180} onChange={(v) => set((s) => (s.trueNorth = v))} />
            <div className="fields fields-3">
              <NumberField label="Giorno" digits={0} step={1} value={site.sun.day} min={1} max={31} onChange={(v) => set((s) => (s.sun.day = Math.round(v)))} />
              <NumberField label="Mese" digits={0} step={1} value={site.sun.month} min={1} max={12} onChange={(v) => set((s) => (s.sun.month = Math.round(v)))} />
              <NumberField label="Ora" digits={1} step={0.5} value={site.sun.hour} min={0} max={24} onChange={(v) => set((s) => (s.sun.hour = v))} />
            </div>
          </div>
        </div>
        <div className="kv-grid">
          <div><span>Azimut solare</span><b className="mono">{fmt(sun.azimuth, 1)}°</b></div>
          <div><span>Altezza solare</span><b className="mono">{fmt(sun.altitude, 1)}°</b></div>
        </div>
        <p className="note">
          Angolo, in senso orario, tra il nord di progetto (alto del foglio) e il nord geografico. Se il progetto è orientato sulla cartografia UTM vale circa {fmt(gridConvergence(site.latitude, site.longitude), 2)}°.
          Il sole orienta luci e ombre della vista 3D in 02 · Modellazione.
        </p>
      </Panel>

      <Panel title="Vincoli urbanistici" aside={<span className="badge">{site.zoning.zone.split('·')[0]}</span>}>
        <TextField label="Zona di PGT / PRG" value={site.zoning.zone} onChange={(v) => set((s) => (s.zoning.zone = v))} />
        <div className="fields fields-3">
          <NumberField label="H max" unit="m" value={site.zoning.maxHeight} min={0} onChange={(v) => set((s) => (s.zoning.maxHeight = v))} />
          <NumberField label="Dist. confini" unit="m" value={site.zoning.minBoundaryDistance} min={0} onChange={(v) => set((s) => (s.zoning.minBoundaryDistance = v))} />
          <NumberField label="Rc max" unit="%" digits={0} step={1} value={site.zoning.maxCoverage * 100} min={0} max={100} onChange={(v) => set((s) => (s.zoning.maxCoverage = v / 100))} />
        </div>
        <Check ok={h <= site.zoning.maxHeight} label="Altezza edificio" value={`${fmt(h)} m su ${fmt(site.zoning.maxHeight)} m`} />
        <Check ok={m.coverage <= site.zoning.maxCoverage} label="Rapporto di copertura" value={`${fmt(m.coverage * 100, 1)}% su ${fmt(site.zoning.maxCoverage * 100, 0)}%`} />
        <Check ok={minDist >= site.zoning.minBoundaryDistance} label="Distanza minima dai confini" value={`${fmt(minDist)} m (min ${fmt(site.zoning.minBoundaryDistance)} m)`} />
        <div className="kv-grid">
          <div><span>Superficie lotto</span><b className="mono">{fmt(m.lotArea, 0)} m²</b></div>
          <div><span>Superficie coperta</span><b className="mono">{fmt(m.footprint, 1)} m²</b></div>
        </div>
      </Panel>
    </>
  );
}

function LocationPanel() {
  const project = useStore((s) => s.project);
  const edit = useStore((s) => s.edit);
  const site = project.site;
  const set = (fn: (s: Project['site']) => void) => edit((d) => fn(d.site));
  const [results, setResults] = useState<GeoResult[] | null>(null);
  const [status, setStatus] = useState<{ kind: 'info' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const utm = toUtm(site.latitude, site.longitude);

  const search = async () => {
    const q = [site.address, site.municipality].filter(Boolean).join(', ');
    if (!q.trim()) return setStatus({ kind: 'err', text: 'Scrivi un indirizzo o un comune da cercare.' });
    setBusy(true);
    setStatus(null);
    try {
      const r = await geocode(q);
      if (!r.length) setStatus({ kind: 'err', text: `Nessun risultato per «${q}». Prova a indicare solo via e comune.` });
      else if (r.length === 1) await apply(r[0]);
      else setResults(r);
    } catch {
      setStatus({ kind: 'err', text: 'Ricerca non riuscita: serve la connessione a internet. Puoi inserire le coordinate a mano.' });
    } finally {
      setBusy(false);
    }
  };

  const apply = async (r: GeoResult) => {
    setResults(null);
    set((s) => {
      s.latitude = +r.latitude.toFixed(6);
      s.longitude = +r.longitude.toFixed(6);
      if (r.address) s.address = r.address;
      if (r.municipality) s.municipality = r.municipality;
      s.crs = suggestedCrs(r.latitude, r.longitude);
    });
    let msg = 'Coordinate aggiornate.';
    try {
      const z = await terrainElevation(r.latitude, r.longitude);
      if (z !== null) {
        set((s) => {
          s.altitude = +(z - s.groundLevel).toFixed(2);
        });
        msg = `Coordinate e quota aggiornate: terreno a ${fmt(z, 1)} m s.l.m.`;
      }
    } catch {
      msg = 'Coordinate aggiornate; quota s.l.m. non disponibile, inseriscila a mano.';
    }
    setStatus({ kind: 'info', text: msg });
  };

  return (
    <Panel title="Localizzazione">
      <TextField label="Indirizzo" value={site.address} onChange={(v) => set((s) => (s.address = v))} />
      <div className="fields fields-2">
        <TextField label="Comune" value={site.municipality} onChange={(v) => set((s) => (s.municipality = v))} />
        <TextField label="Catasto" value={site.cadastre} onChange={(v) => set((s) => (s.cadastre = v))} />
      </div>
      <button className="btn btn-primary btn-block" onClick={search} disabled={busy}>
        {busy ? 'Ricerca in corso…' : 'Trova coordinate dall’indirizzo'}
      </button>
      {results && (
        <div className="geo-results">
          <div className="subhead">Scegli la località</div>
          {results.map((r, i) => (
            <button key={i} className="geo-row" onClick={() => apply(r)}>
              {r.label}
            </button>
          ))}
          <button className="link" onClick={() => setResults(null)}>Annulla</button>
        </div>
      )}
      {status && <div className={`check-row ${status.kind === 'err' ? 'warn' : 'ok'}`}><span>{status.text}</span></div>}
      <div className="fields fields-2">
        <NumberField label="Latitudine" unit="°N" digits={6} step={0.0001} value={site.latitude} min={-90} max={90} onChange={(v) => set((s) => { s.latitude = v; s.crs = suggestedCrs(v, s.longitude); })} />
        <NumberField label="Longitudine" unit="°E" digits={6} step={0.0001} value={site.longitude} min={-180} max={180} onChange={(v) => set((s) => { s.longitude = v; s.crs = suggestedCrs(s.latitude, v); })} />
        <NumberField label="Quota ±0.00 s.l.m." unit="m" value={site.altitude} onChange={(v) => set((s) => (s.altitude = v))} />
        <NumberField label="Terreno naturale" unit="m" value={site.groundLevel} onChange={(v) => set((s) => (s.groundLevel = v))} />
      </div>
      <TextField label="Sistema di riferimento" value={site.crs} onChange={(v) => set((s) => (s.crs = v))} />
      <div className="kv-grid">
        <div><span>Est (UTM {utm.zone})</span><b className="mono">{fmt(utm.easting, 2)} m</b></div>
        <div><span>Nord (UTM {utm.zone})</span><b className="mono">{fmt(utm.northing, 2)} m</b></div>
      </div>
      <a className="link" href={`https://www.openstreetmap.org/?mlat=${site.latitude}&mlon=${site.longitude}#map=18/${site.latitude}/${site.longitude}`} target="_blank" rel="noreferrer">
        Apri la posizione su OpenStreetMap ↗
      </a>
    </Panel>
  );
}

function Check({ ok, label, value }: { ok: boolean; label: string; value: string }) {
  return (
    <div className={`check-row ${ok ? 'ok' : 'warn'}`}>
      <b>{ok ? '✓' : '!'} {label}</b>
      <span className="mono">{value}</span>
    </div>
  );
}

/** Distanza minima tra impronta dell'edificio e perimetro del lotto */
function boundaryDistance(p: Project) {
  const lot = p.site.lot;
  if (lot.length < 3) return Infinity;
  let min = Infinity;
  for (const q of footprintPoints(p)) min = Math.min(min, distToPolyline(q, lot, true));
  return isFinite(min) ? min : 0;
}

function SunCompass({ trueNorth, azimuth, altitude }: { trueNorth: number; azimuth: number; altitude: number }) {
  const R = 44;
  const a = ((azimuth + trueNorth) * Math.PI) / 180;
  const r = R * (1 - Math.max(0, altitude) / 90);
  return (
    <svg viewBox="-56 -56 112 112" className="compass">
      <circle r={R} className="compass-ring" />
      <circle r={R * 0.5} className="compass-ring compass-ring-soft" />
      <line x1={-R} y1={0} x2={R} y2={0} className="compass-ring compass-ring-soft" />
      <line x1={0} y1={-R} x2={0} y2={R} className="compass-ring compass-ring-soft" />
      <g transform={`rotate(${trueNorth})`}>
        <path d={`M0,${-R - 2} l4,10 l-8,0 z`} className="compass-north" />
        <text y={-R - 5} textAnchor="middle" className="compass-text">N</text>
      </g>
      {altitude > 0 && (
        <>
          <line x1={0} y1={0} x2={Math.sin(a) * r} y2={-Math.cos(a) * r} className="compass-ray" />
          <circle cx={Math.sin(a) * r} cy={-Math.cos(a) * r} r={4.5} className="compass-sun" />
        </>
      )}
      <text y={R + 12} textAnchor="middle" className="compass-text">{altitude > 0 ? 'sole' : 'sotto l’orizzonte'}</text>
    </svg>
  );
}

function ContextInspector({ item }: { item: ContextItem }) {
  const edit = useStore((s) => s.edit);
  const select = useStore((s) => s.select);
  const upd = (fn: (x: ContextItem) => void) =>
    edit((d) => {
      const x = d.site.context.find((c) => c.id === item.id);
      if (x) fn(x);
    });
  const label = { edificio: 'Edificio esistente', strada: 'Strada', albero: 'Albero' }[item.kind];
  return (
    <div className="inspector">
      <div className="insp-kicker">Contesto · {label}</div>
      <h2 className="insp-title">{item.name}</h2>
      <TextField label="Nome" value={item.name} onChange={(v) => upd((x) => (x.name = v))} />
      {item.kind === 'edificio' && (
        <>
          <NumberField label="Altezza in gronda" unit="m" value={item.height} min={1} onChange={(v) => upd((x) => x.kind === 'edificio' && (x.height = v))} />
          <div className="kv-grid">
            <div><span>Impronta</span><b className="mono">{fmt(polygonArea(item.points), 1)} m²</b></div>
          </div>
        </>
      )}
      {item.kind === 'strada' && <NumberField label="Larghezza carreggiata" unit="m" value={item.width} min={2} onChange={(v) => upd((x) => x.kind === 'strada' && (x.width = v))} />}
      {item.kind === 'albero' && <NumberField label="Raggio chioma" unit="m" value={item.radius} min={0.5} onChange={(v) => upd((x) => x.kind === 'albero' && (x.radius = v))} />}
      <p className="note">Il contesto è riutilizzato nella planimetria di cantiere (05) e nella vista 3D.</p>
      <div className="insp-actions">
        <button className="btn" onClick={() => select('contesto', [])}>Chiudi</button>
        <button
          className="btn btn-danger"
          onClick={() => {
            edit((d) => {
              d.site.context = d.site.context.filter((c) => c.id !== item.id);
            });
            select('contesto', []);
          }}
        >
          <Icon name="trash" size={14} /> Elimina
        </button>
      </div>
    </div>
  );
}

/** Sezione schematica delle quote */
function LevelsSection({ project }: { project: Project }) {
  const ext = elevationExtents(project, 'sud');
  const z = project.site.zoning.maxHeight;
  const bounds = { minX: ext.min - 6, minY: project.site.groundLevel - 4, maxX: ext.max + 14, maxY: z + 3 };
  const levels = sortedLevels(project);
  return (
    <Canvas2D bounds={bounds} grid={false}>
      {(zoom) => {
        const mm = 3 / zoom;
        return (
          <g>
            <rect x={ext.min - 6} y={-project.site.groundLevel} width={ext.max - ext.min + 20} height={4} className="ls-ground" />
            <ElevationView project={project} direction="sud" mm={mm} textScale={SCREEN_TEXT} />
            <line x1={ext.min - 6} y1={-z} x2={ext.max + 14} y2={-z} className="ls-limit" strokeWidth={0.35 * mm} strokeDasharray={`${3 * mm} ${1.5 * mm}`} />
            <text x={ext.min - 5.5} y={-z - 1.2 * mm} fontSize={2.4 * mm * SCREEN_TEXT} className="ls-limit-text">
              ALTEZZA MASSIMA AMMESSA {fmtLevel(z)}
            </text>
            {levels.map((l) => (
              <line key={l.id} x1={ext.min - 6} y1={-l.elevation} x2={ext.max} y2={-l.elevation} className="ls-level" strokeWidth={0.18 * mm} strokeDasharray={`${1 * mm} ${1 * mm}`} />
            ))}
            {levels.map((l) => (
              <text key={`t${l.id}`} x={ext.min - 5.5} y={-l.elevation - 1 * mm} fontSize={2.2 * mm * SCREEN_TEXT} className="ls-level-text">
                {l.name} · {fmtLevel(l.elevation)} · h {fmt(l.height)}
              </text>
            ))}
            <text x={ext.min - 5.5} y={-project.site.groundLevel + 3.5 * mm} fontSize={2 * mm * SCREEN_TEXT} className="ls-level-text">
              Terreno naturale {fmtLevel(project.site.groundLevel)} · {fmt(project.site.altitude + project.site.groundLevel, 2)} m s.l.m.
            </text>
          </g>
        );
      }}
    </Canvas2D>
  );
}

