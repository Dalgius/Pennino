import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../model/store';
import { downloadText } from '../model/store';
import type { PaperFormat, Project, Sheet, Viewport, ViewportKind } from '../model/types';
import { byId, sortedLevels, uid } from '../model/geometry';
import { NumberField, Panel, SelectField, TextField } from '../ui/controls';
import { Icon } from '../ui/icons';
import { PAPER, SCALES, SheetView, viewportFrame } from '../views/SheetView';

const KIND_LABEL: Record<ViewportKind, string> = {
  pianta: 'Pianta',
  prospetto: 'Prospetto',
  sezione: 'Sezione',
  assonometria: 'Assonometria',
  planimetria: 'Planimetria',
  abaco: 'Abaco',
  legenda: 'Legenda',
};

export function Layout() {
  const project = useStore((s) => s.project);
  const revision = useStore((s) => s.revision);
  const edit = useStore((s) => s.edit);
  const editLive = useStore((s) => s.editLive);
  const checkpoint = useStore((s) => s.checkpoint);
  const [sheetId, setSheetId] = useState(project.sheets[0]?.id ?? '');
  const [vpId, setVpId] = useState<string | null>(null);
  const [zoom, setZoom] = useState<'adatta' | number>('adatta');
  const [printing, setPrinting] = useState<Sheet[] | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const svgWrap = useRef<HTMLDivElement>(null);
  const [fitK, setFitK] = useState(2);
  const drag = useRef<{ id: string; sx: number; sy: number; x: number; y: number; moved: boolean } | null>(null);

  const sheet = project.sheets.find((s) => s.id === sheetId) ?? project.sheets[0];
  const vp = sheet?.viewports.find((v) => v.id === vpId) ?? null;
  const paper = sheet ? PAPER[sheet.format] : PAPER.A3;

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setFitK(Math.min((el.clientWidth - 48) / paper.w, (el.clientHeight - 48) / paper.h)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [paper.w, paper.h]);
  const k = zoom === 'adatta' ? fitK : zoom * (96 / 25.4);

  const updSheet = (fn: (s: Sheet) => void) =>
    edit((d) => {
      const s = d.sheets.find((x) => x.id === sheet.id);
      if (s) fn(s);
    });
  const updVp = (fn: (v: Viewport) => void) =>
    edit((d) => {
      const v = d.sheets.find((x) => x.id === sheet.id)?.viewports.find((x) => x.id === vpId);
      if (v) fn(v);
    });

  const addViewport = (v: Omit<Viewport, 'id' | 'x' | 'y'>) => {
    const id = uid('vp');
    edit((d) => {
      const s = d.sheets.find((x) => x.id === sheet.id)!;
      s.viewports.push({ ...v, id, x: 24, y: 20 + (s.viewports.length % 4) * 12 });
    });
    setVpId(id);
  };

  const addSheet = () => {
    const id = uid('sh');
    edit((d) => {
      const n = d.sheets.length + 1;
      d.sheets.push({ id, number: `A.${String(n).padStart(2, '0')}`, title: 'Nuova tavola', format: 'A3', revision: '00', date: new Date().toISOString().slice(0, 10), viewports: [] });
    });
    setSheetId(id);
    setVpId(null);
  };

  const onViewportDown = (v: Viewport, e: React.PointerEvent) => {
    e.stopPropagation();
    setVpId(v.id);
    drag.current = { id: v.id, sx: e.clientX, sy: e.clientY, x: v.x, y: v.y, moved: false };
    (e.currentTarget as SVGGElement).ownerSVGElement?.setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.sx) / k;
    const dy = (e.clientY - d.sy) / k;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < 1) return;
      checkpoint();
      d.moved = true;
    }
    editLive((dr) => {
      const v = dr.sheets.find((x) => x.id === sheet.id)?.viewports.find((x) => x.id === d.id);
      if (v) {
        v.x = Math.round((d.x + dx) * 2) / 2;
        v.y = Math.round((d.y + dy) * 2) / 2;
      }
    });
  };

  const print = (sheets: Sheet[]) => {
    setPrinting(sheets);
    setTimeout(() => {
      window.print();
      setPrinting(null);
    }, 400);
  };

  const exportSvg = () => {
    const svg = svgWrap.current?.querySelector('svg');
    if (!svg || !sheet) return;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('width', `${paper.w}mm`);
    clone.setAttribute('height', `${paper.h}mm`);
    clone.querySelectorAll('.sh-vp-outline').forEach((n) => n.remove());
    downloadText(`${sheet.number}_${sheet.title}.svg`, new XMLSerializer().serializeToString(clone), 'image/svg+xml');
  };

  if (!sheet)
    return (
      <div className="workspace workspace-empty">
        <button className="btn btn-primary" onClick={addSheet}>Crea la prima tavola</button>
      </div>
    );

  const levels = sortedLevels(project);

  return (
    <div className="workspace">
      <aside className="side side-left">
        <div className="side-scroll">
          <div className="side-title">
            <span className="phase-num">03</span> Layout
          </div>
          <div className="subhead">
            Tavole
            <button className="link" onClick={addSheet}>+ Nuova</button>
          </div>
          <div className="sheet-list">
            {project.sheets.map((s) => (
              <button key={s.id} className={`sheet-row ${s.id === sheet.id ? 'on' : ''}`} onClick={() => { setSheetId(s.id); setVpId(null); }}>
                <span className="sheet-num mono">{s.number}</span>
                <span className="sheet-title">{s.title}</span>
                <span className="muted mono">{s.format} · {s.viewports.length} viste · rev {s.revision}</span>
              </button>
            ))}
          </div>

          <div className="subhead">Inserisci vista dal modello</div>
          {!(project.sections ?? []).length && <p className="note">Per inserire una sezione, tracciala prima in 02 · Modellazione con lo strumento Sezione (X).</p>}
          <div className="insert-grid">
            {levels.map((l) => (
              <button key={l.id} className="insert-btn" onClick={() => addViewport({ kind: 'pianta', title: `Pianta ${l.name.toLowerCase()}`, scale: 100, levelId: l.id, showDimensions: true })}>
                <Icon name="wall" size={16} /> Pianta {l.name}
              </button>
            ))}
            {(['sud', 'est', 'nord', 'ovest'] as const).map((d) => (
              <button key={d} className="insert-btn" onClick={() => addViewport({ kind: 'prospetto', title: `Prospetto ${d}`, scale: 100, direction: d })}>
                <Icon name="building" size={16} /> Prospetto {d}
              </button>
            ))}
            {(project.sections ?? []).map((sec) => (
              <button key={sec.id} className="insert-btn" onClick={() => addViewport({ kind: 'sezione', title: `Sezione ${sec.name}–${sec.name}′`, scale: 100, sectionId: sec.id })}>
                <Icon name="section" size={16} /> Sezione {sec.name}–{sec.name}′
              </button>
            ))}
            <button className="insert-btn" onClick={() => addViewport({ kind: 'assonometria', title: 'Assonometria', scale: 150 })}>
              <Icon name="slab" size={16} /> Assonometria
            </button>
            <button className="insert-btn" onClick={() => addViewport({ kind: 'planimetria', title: 'Planimetria generale', scale: 200 })}>
              <Icon name="site" size={16} /> Planimetria
            </button>
            <button className="insert-btn" onClick={() => addViewport({ kind: 'abaco', title: 'Abaco serramenti', scale: 1, schedule: 'aperture' })}>
              <Icon name="table" size={16} /> Abaco serramenti
            </button>
            <button className="insert-btn" onClick={() => addViewport({ kind: 'abaco', title: 'Abaco murature', scale: 1, schedule: 'muri' })}>
              <Icon name="table" size={16} /> Abaco murature
            </button>
            <button className="insert-btn" onClick={() => addViewport({ kind: 'legenda', title: 'Legenda', scale: 1 })}>
              <Icon name="sheet" size={16} /> Legenda
            </button>
          </div>
        </div>
      </aside>

      <main className="stage">
        <div className="stage-bar">
          <div className="stage-bar-left">
            <span className="chip mono">{sheet.number}</span>
            <span className="chip">{sheet.format} · {paper.w} × {paper.h} mm</span>
            <span className="chip chip-live" title="Le viste sono collegate al modello">● Viste collegate al modello</span>
          </div>
          <div className="stage-bar-right">
            <button className={`tab ${zoom === 'adatta' ? 'on' : ''}`} onClick={() => setZoom('adatta')}>Adatta</button>
            <button className={`tab ${zoom === 1 ? 'on' : ''}`} onClick={() => setZoom(1)}>100%</button>
            <button className="tab tab-icon" onClick={exportSvg}><Icon name="download" size={15} /> SVG</button>
            <button className="tab tab-icon" onClick={() => print([sheet])}><Icon name="print" size={15} /> Stampa / PDF</button>
            <button className="tab" onClick={() => print(project.sheets)}>Stampa tutte</button>
          </div>
        </div>
        <div className="stage-body sheet-stage" ref={stageRef} onPointerDown={() => setVpId(null)}>
          <div
            ref={svgWrap}
            className="sheet-wrap"
            style={{ width: paper.w * k, height: paper.h * k }}
            onPointerMove={onMove}
            onPointerUp={() => (drag.current = null)}
          >
            <SheetView
              project={project}
              sheet={sheet}
              revision={revision}
              selectedVp={vpId}
              onViewportDown={onViewportDown}
              widthCss={`${paper.w * k}px`}
              heightCss={`${paper.h * k}px`}
            />
          </div>
        </div>
        <div className="prompt">
          <span className="prompt-label">Impaginazione</span>
          <span className="prompt-text">Trascina le viste sul foglio. Le viste sono generate dal modello: ogni modifica in 02 le aggiorna.</span>
        </div>
      </main>

      <aside className="side side-right">
        <div className="side-scroll">
          {vp ? <ViewportPanel project={project} sheet={sheet} vp={vp} upd={updVp} onRemove={() => { edit((d) => { const s = d.sheets.find((x) => x.id === sheet.id)!; s.viewports = s.viewports.filter((x) => x.id !== vp.id); }); setVpId(null); }} /> : <SheetPanel project={project} sheet={sheet} upd={updSheet} onRemove={() => { edit((d) => { d.sheets = d.sheets.filter((x) => x.id !== sheet.id); }); setSheetId(project.sheets.find((x) => x.id !== sheet.id)?.id ?? ''); }} />}
        </div>
      </aside>

      {printing &&
        createPortal(
          <div className="print-root">
            <style>{`@page { size: ${PAPER[printing[0].format].w}mm ${PAPER[printing[0].format].h}mm; margin: 0; }`}</style>
            {printing.map((s) => (
              <div key={s.id} className="print-page">
                <SheetView project={project} sheet={s} revision={revision} />
              </div>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}

function ViewportPanel({ project, sheet, vp, upd, onRemove }: { project: Project; sheet: Sheet; vp: Viewport; upd: (fn: (v: Viewport) => void) => void; onRemove: () => void }) {
  const f = viewportFrame(project, vp);
  const scalable = vp.kind === 'pianta' || vp.kind === 'prospetto' || vp.kind === 'sezione' || vp.kind === 'planimetria' || vp.kind === 'assonometria';
  const paper = PAPER[sheet.format];
  const outside = vp.x + f.w > paper.w - 10 || vp.y + f.h > paper.h - 10 || vp.x < 20 || vp.y < 10;
  return (
    <div className="inspector">
      <div className="insp-kicker">Vista · {KIND_LABEL[vp.kind]}</div>
      <h2 className="insp-title">{vp.title}</h2>
      <TextField label="Titolo" value={vp.title} onChange={(v) => upd((x) => (x.title = v))} />
      {scalable && (
        <div className="field">
          <span className="field-label">Scala</span>
          <div className="segmented">
            {(vp.kind === 'assonometria' ? [50, 100, 150, 200, 300] : SCALES).map((s) => (
              <button key={s} className={vp.scale === s ? 'on' : ''} onClick={() => upd((x) => (x.scale = s))}>
                1:{s}
              </button>
            ))}
          </div>
        </div>
      )}
      {vp.kind === 'pianta' && (
        <>
          <SelectField label="Livello" value={vp.levelId ?? ''} options={project.levels.map((l) => ({ value: l.id, label: l.name }))} onChange={(v) => upd((x) => (x.levelId = v))} />
          <label className="check">
            <input type="checkbox" checked={!!vp.showDimensions} onChange={(e) => upd((x) => (x.showDimensions = e.target.checked))} /> Quote automatiche dei muri perimetrali
          </label>
        </>
      )}
      {vp.kind === 'prospetto' && (
        <SelectField label="Fronte" value={vp.direction ?? 'sud'} options={['sud', 'nord', 'est', 'ovest'].map((d) => ({ value: d as 'sud', label: `Prospetto ${d}` }))} onChange={(v) => upd((x) => (x.direction = v))} />
      )}
      {vp.kind === 'sezione' && (
        <SelectField
          label="Sezione"
          value={vp.sectionId ?? ''}
          options={(project.sections ?? []).map((x) => ({ value: x.id, label: `Sezione ${x.name}–${x.name}′` }))}
          onChange={(v) => upd((x) => (x.sectionId = v))}
        />
      )}
      {vp.kind === 'abaco' && (
        <SelectField label="Abaco" value={vp.schedule ?? 'aperture'} options={[{ value: 'aperture', label: 'Serramenti' }, { value: 'muri', label: 'Murature' }]} onChange={(v) => upd((x) => (x.schedule = v))} />
      )}
      <div className="fields fields-2">
        <NumberField label="Posizione X" unit="mm" digits={1} value={vp.x} onChange={(v) => upd((x) => (x.x = v))} />
        <NumberField label="Posizione Y" unit="mm" digits={1} value={vp.y} onChange={(v) => upd((x) => (x.y = v))} />
      </div>
      <div className="kv-grid">
        <div><span>Ingombro</span><b className="mono">{Math.round(f.w)} × {Math.round(f.h)} mm</b></div>
        {vp.levelId && <div><span>Livello</span><b>{byId(project.levels, vp.levelId)?.name}</b></div>}
      </div>
      {outside && <div className="check-row warn"><b>! Fuori squadratura</b><span>La vista esce dai margini del foglio {sheet.format}.</span></div>}
      <div className="insp-actions">
        <button className="btn btn-danger" onClick={onRemove}><Icon name="trash" size={14} /> Rimuovi dal foglio</button>
      </div>
    </div>
  );
}

function SheetPanel({ project, sheet, upd, onRemove }: { project: Project; sheet: Sheet; upd: (fn: (s: Sheet) => void) => void; onRemove: () => void }) {
  const edit = useStore((s) => s.edit);
  const tb = project.titleBlock;
  const setTb = (k: keyof typeof tb, v: string) => edit((d) => void (d.titleBlock[k] = v));
  return (
    <>
      <Panel title="Tavola">
        <div className="fields fields-2">
          <TextField label="Numero" value={sheet.number} onChange={(v) => upd((s) => (s.number = v))} />
          <SelectField<PaperFormat> label="Formato" value={sheet.format} options={(['A3', 'A2', 'A1'] as PaperFormat[]).map((f) => ({ value: f, label: `${f} orizzontale` }))} onChange={(v) => upd((s) => (s.format = v))} />
        </div>
        <TextField label="Oggetto della tavola" value={sheet.title} onChange={(v) => upd((s) => (s.title = v))} />
        <div className="fields fields-2">
          <TextField label="Revisione" value={sheet.revision} onChange={(v) => upd((s) => (s.revision = v))} />
          <TextField label="Data" value={sheet.date} onChange={(v) => upd((s) => (s.date = v))} />
        </div>
        <button className="btn btn-danger btn-block" disabled={project.sheets.length < 2} onClick={onRemove}>
          <Icon name="trash" size={14} /> Elimina tavola
        </button>
      </Panel>
      <Panel title="Cartiglio (comune a tutte le tavole)">
        <TextField label="Studio" value={tb.studio} onChange={(v) => setTb('studio', v)} />
        <TextField label="Progettista" value={tb.designer} onChange={(v) => setTb('designer', v)} />
        <TextField label="Committente" value={tb.client} onChange={(v) => setTb('client', v)} />
        <div className="fields fields-2">
          <TextField label="Commessa" value={tb.projectCode} onChange={(v) => setTb('projectCode', v)} />
          <TextField label="Fase progettuale" value={tb.stage} onChange={(v) => setTb('stage', v)} />
        </div>
        <TextField label="Nome dell’opera" value={project.name} onChange={(v) => edit((d) => void (d.name = v))} />
      </Panel>
      <p className="note">Seleziona una vista sul foglio per cambiarne scala, livello o fronte.</p>
    </>
  );
}
