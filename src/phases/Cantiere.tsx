import { useMemo, useState } from 'react';
import { useStore } from '../model/store';
import type { Project, SiteAreaUse, SiteItem, SiteItemKind, Vec2, VehicleKind } from '../model/types';
import { bbox, dist, fmt, fmtEuro, footprintPoints, polygonArea, polygonPerimeter, uid } from '../model/geometry';
import { hitTestSite } from '../model/edit';
import { computeComputo, siteItemLabel } from '../model/quantities';
import { Canvas2D } from '../ui/Canvas2D';
import { NumberField, Panel, SelectField, TextField } from '../ui/controls';
import { Icon } from '../ui/icons';
import { useSiteEditor, type DrawKind } from '../ui/useSiteEditor';
import { SiteView } from '../views/SiteView';
import { SelectionHandles, SiteDraft } from './Inquadramento';

type CTool = 'select' | SiteItemKind;

const CTOOLS: { id: CTool; label: string; icon: string; draw: DrawKind; hint: string }[] = [
  { id: 'select', label: 'Seleziona', icon: 'select', draw: null, hint: 'Seleziona e sposta gli apprestamenti; trascina i vertici per modificarli.' },
  { id: 'recinzione', label: 'Recinzione', icon: 'fence', draw: 'polyline', hint: 'Clic sui vertici della recinzione; clic sul primo punto per chiuderla, Invio per terminare.' },
  { id: 'accesso', label: 'Accesso', icon: 'gate', draw: 'point', hint: 'Clic per posizionare un accesso; orientamento e larghezza nell’ispettore.' },
  { id: 'area', label: 'Area', icon: 'area', draw: 'polygon', hint: 'Disegna un’area di deposito, baraccamenti, parcheggio, rifiuti o lavorazione.' },
  { id: 'gru', label: 'Gru', icon: 'crane', draw: 'point', hint: 'Clic per posizionare la gru: verifica il raggio d’azione sull’edificio.' },
  { id: 'mezzo', label: 'Mezzo', icon: 'truck', draw: 'point', hint: 'Clic per posizionare un mezzo d’opera.' },
  { id: 'percorso', label: 'Viabilità', icon: 'path', draw: 'polyline', hint: 'Disegna l’asse della viabilità di cantiere; doppio clic o Invio per terminare.' },
];

const USES: { value: SiteAreaUse; label: string }[] = [
  { value: 'deposito', label: 'Deposito materiali' },
  { value: 'baraccamenti', label: 'Baraccamenti' },
  { value: 'parcheggio', label: 'Parcheggio' },
  { value: 'rifiuti', label: 'Rifiuti / differenziata' },
  { value: 'lavorazione', label: 'Area di lavorazione' },
];

const VEHICLES: { value: VehicleKind; label: string }[] = [
  { value: 'autobetoniera', label: 'Autobetoniera' },
  { value: 'autocarro', label: 'Autocarro' },
  { value: 'escavatore', label: 'Escavatore' },
  { value: 'autogru', label: 'Autogru' },
  { value: 'pompa', label: 'Autopompa cls' },
];

export function Cantiere() {
  const project = useStore((s) => s.project);
  const edit = useStore((s) => s.edit);
  const select = useStore((s) => s.select);
  const [tool, setTool] = useState<CTool>('select');
  const [areaUse, setAreaUse] = useState<SiteAreaUse>('deposito');
  const [vehicle, setVehicle] = useState<VehicleKind>('autobetoniera');
  const def = CTOOLS.find((t) => t.id === tool)!;

  const editor = useSiteEditor({
    scope: 'cantiere',
    tool,
    drawKind: def.draw,
    list: (p) => p.siteLogistics,
    hitTest: (p, w, tol) => hitTestSite(p.siteLogistics, w, tol),
    extraSnaps: [...project.site.lot, ...footprintPoints(project)],
    onCreate: (points) => {
      const id = uid('cn');
      const p0 = points[0];
      let item: SiteItem | null = null;
      if (tool === 'recinzione') item = { id, kind: 'recinzione', points, height: 2 };
      if (tool === 'accesso') item = { id, kind: 'accesso', p: p0, width: 5, rotation: 0, name: 'Accesso' };
      if (tool === 'area') item = { id, kind: 'area', points, use: areaUse, name: USES.find((u) => u.value === areaUse)!.label };
      if (tool === 'gru') item = { id, kind: 'gru', p: p0, radius: 25, name: `Gru GT-0${project.siteLogistics.filter((s) => s.kind === 'gru').length + 1}` };
      if (tool === 'mezzo') item = { id, kind: 'mezzo', p: p0, rotation: 0, vehicle };
      if (tool === 'percorso') item = { id, kind: 'percorso', points, width: 4, name: 'Viabilità' };
      if (!item) return;
      const it = item;
      edit((d) => void d.siteLogistics.push(it));
      select('cantiere', [id]);
      if (tool !== 'mezzo' && tool !== 'area') setTool('select');
    },
    onDelete: (ids) => edit((d) => void (d.siteLogistics = d.siteLogistics.filter((s) => !ids.includes(s.id)))),
  });

  const bounds = useMemo(() => {
    const all: Vec2[] = [...project.site.lot, ...footprintPoints(project)];
    for (const s of project.siteLogistics) all.push(...('points' in s ? s.points : [s.p]));
    const b = all.length ? bbox(all) : { minX: -20, minY: -20, maxX: 20, maxY: 20 };
    return { minX: b.minX - 6, minY: b.minY - 6, maxX: b.maxX + 6, maxY: b.maxY + 6 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sel = project.siteLogistics.find((s) => s.id === editor.selectedIds[0]);

  return (
    <div className="workspace">
      <aside className="side side-left">
        <div className="side-scroll">
          <div className="side-title">
            <span className="phase-num">05</span> Cantiere
          </div>
          <div className="toolgrid">
            {CTOOLS.map((t) => (
              <button key={t.id} className={`tool ${tool === t.id ? 'on' : ''}`} onClick={() => setTool(t.id)} title={t.hint}>
                <Icon name={t.icon} size={20} />
                <span>{t.label}</span>
              </button>
            ))}
          </div>
          {tool === 'area' && <SelectField label="Destinazione dell’area" value={areaUse} options={USES} onChange={setAreaUse} />}
          {tool === 'mezzo' && <SelectField label="Mezzo" value={vehicle} options={VEHICLES} onChange={setVehicle} />}
          <button
            className="btn btn-block"
            disabled={project.site.lot.length < 3}
            onClick={() => {
              const lot = project.site.lot;
              edit((d) => void d.siteLogistics.push({ id: uid('cn'), kind: 'recinzione', height: 2, points: [...lot, lot[0]] }));
            }}
          >
            Recinzione sul perimetro del lotto
          </button>

          <div className="subhead">Apprestamenti</div>
          <div className="elist">
            {project.siteLogistics.map((s) => (
              <button key={s.id} className={`elist-row ${editor.selectedIds.includes(s.id) ? 'on' : ''}`} onClick={() => { setTool('select'); select('cantiere', [s.id]); }}>
                <span className="mono elist-code">{s.kind.slice(0, 3).toUpperCase()}</span>
                <span>{siteItemLabel(s)}</span>
              </button>
            ))}
          </div>
          <p className="note">Lotto, strade ed edifici confinanti provengono da 01 · Inquadramento; l’impronta dell’edificio da 02 · Modellazione.</p>
        </div>
      </aside>

      <main className="stage">
        <div className="stage-bar">
          <div className="stage-bar-left">
            <span className="chip">Planimetria di cantiere</span>
            <span className="chip chip-live">● Contesto da 01 · Edificio da 02</span>
          </div>
          <div className="stage-bar-right">
            <button className={`tab ${editor.ortho ? 'on' : ''}`} onClick={() => editor.setOrtho(!editor.ortho)}>Ortogonale</button>
          </div>
        </div>
        <div className="stage-body">
          <Canvas2D bounds={bounds} onPointer={editor.onPointer} cursor={tool === 'select' ? 'default' : 'crosshair'}>
            {(z) => {
              const mm = 3 / z;
              return (
                <>
                  <SiteView project={project} mm={mm} logistics selectedIds={editor.selectedIds} />
                  <SelectionHandles items={project.siteLogistics} ids={editor.selectedIds} mm={mm} />
                  <SiteDraft draft={editor.draft} cursor={def.draw ? editor.cursor : null} mm={mm} closed={def.draw === 'polygon'} />
                </>
              );
            }}
          </Canvas2D>
        </div>
        <div className="prompt">
          <span className="prompt-label">{def.label}</span>
          <span className="prompt-text">{def.hint}</span>
        </div>
      </main>

      <aside className="side side-right">
        <div className="side-scroll">{sel ? <SiteItemInspector item={sel} /> : <SiteSummary project={project} />}</div>
      </aside>
    </div>
  );
}

function SiteItemInspector({ item }: { item: SiteItem }) {
  const edit = useStore((s) => s.edit);
  const select = useStore((s) => s.select);
  const project = useStore((s) => s.project);
  const upd = (fn: (x: SiteItem) => void) =>
    edit((d) => {
      const x = d.siteLogistics.find((s) => s.id === item.id);
      if (x) fn(x);
    });
  const titles: Record<SiteItemKind, string> = { recinzione: 'Recinzione', accesso: 'Accesso', area: 'Area', gru: 'Gru a torre', mezzo: 'Mezzo d’opera', percorso: 'Viabilità' };
  return (
    <div className="inspector">
      <div className="insp-kicker">{titles[item.kind]}</div>
      <h2 className="insp-title">{siteItemLabel(item)}</h2>
      {'name' in item && <TextField label="Nome" value={item.name} onChange={(v) => upd((x) => 'name' in x && (x.name = v))} />}
      {item.kind === 'recinzione' && (
        <>
          <NumberField label="Altezza" unit="m" value={item.height} min={1} onChange={(v) => upd((x) => x.kind === 'recinzione' && (x.height = v))} />
          <div className="kv-grid">
            <div><span>Sviluppo</span><b className="mono">{fmt(polygonPerimeter(item.points, false))} m</b></div>
            <div><span>Chiusa</span><b>{dist(item.points[0], item.points[item.points.length - 1]) < 0.01 ? 'Sì' : 'No'}</b></div>
          </div>
        </>
      )}
      {item.kind === 'accesso' && (
        <div className="fields fields-2">
          <NumberField label="Larghezza" unit="m" value={item.width} min={0.8} onChange={(v) => upd((x) => x.kind === 'accesso' && (x.width = v))} />
          <NumberField label="Rotazione" unit="°" digits={0} step={15} value={item.rotation} onChange={(v) => upd((x) => x.kind === 'accesso' && (x.rotation = v))} />
        </div>
      )}
      {item.kind === 'area' && (
        <>
          <SelectField label="Destinazione" value={item.use} options={USES} onChange={(v) => upd((x) => x.kind === 'area' && (x.use = v))} />
          <div className="kv-grid">
            <div><span>Superficie</span><b className="mono">{fmt(polygonArea(item.points))} m²</b></div>
          </div>
        </>
      )}
      {item.kind === 'gru' && (() => {
        const cov = craneCoverage(project, item.p, item.radius);
        return (
          <>
            <NumberField label="Lunghezza braccio" unit="m" value={item.radius} min={5} onChange={(v) => upd((x) => x.kind === 'gru' && (x.radius = v))} />
            <div className={`check-row ${cov.all ? 'ok' : 'warn'}`}>
              <b>{cov.all ? '✓ Edificio interamente servito' : `! Edificio servito al ${fmt(cov.ratio * 100, 0)}%`}</b>
              <span className="mono">punto più lontano a {fmt(cov.far)} m</span>
            </div>
          </>
        );
      })()}
      {item.kind === 'mezzo' && (
        <>
          <SelectField label="Mezzo" value={item.vehicle} options={VEHICLES} onChange={(v) => upd((x) => x.kind === 'mezzo' && (x.vehicle = v))} />
          <NumberField label="Rotazione" unit="°" digits={0} step={15} value={item.rotation} onChange={(v) => upd((x) => x.kind === 'mezzo' && (x.rotation = v))} />
        </>
      )}
      {item.kind === 'percorso' && (
        <>
          <NumberField label="Larghezza" unit="m" value={item.width} min={2} onChange={(v) => upd((x) => x.kind === 'percorso' && (x.width = v))} />
          <div className="kv-grid">
            <div><span>Sviluppo</span><b className="mono">{fmt(polygonPerimeter(item.points, false))} m</b></div>
            <div><span>Superficie</span><b className="mono">{fmt(polygonPerimeter(item.points, false) * item.width)} m²</b></div>
          </div>
          {item.width < 3.5 && <div className="check-row warn"><b>! Larghezza ridotta</b><span>Per il transito dei mezzi pesanti si consigliano almeno 3,50 m.</span></div>}
        </>
      )}
      <div className="insp-actions">
        <button className="btn" onClick={() => select('cantiere', [])}>Chiudi</button>
        <button className="btn btn-danger" onClick={() => { edit((d) => void (d.siteLogistics = d.siteLogistics.filter((s) => s.id !== item.id))); select('cantiere', []); }}>
          <Icon name="trash" size={14} /> Elimina
        </button>
      </div>
    </div>
  );
}

function craneCoverage(p: Project, c: Vec2, r: number) {
  const pts = footprintPoints(p);
  if (!pts.length) return { all: true, ratio: 1, far: 0 };
  const inside = pts.filter((q) => dist(q, c) <= r).length;
  const far = Math.max(...pts.map((q) => dist(q, c)));
  return { all: inside === pts.length, ratio: inside / pts.length, far };
}

function SiteSummary({ project }: { project: Project }) {
  const setPhase = useStore((s) => s.setPhase);
  const items = project.siteLogistics;
  const fences = items.filter((s) => s.kind === 'recinzione');
  const fenceLen = fences.reduce((s, f) => s + (f.kind === 'recinzione' ? polygonPerimeter(f.points, false) : 0), 0);
  const closed = fences.some((f) => f.kind === 'recinzione' && f.points.length > 2 && dist(f.points[0], f.points[f.points.length - 1]) < 0.01);
  const accesses = items.filter((s) => s.kind === 'accesso');
  const cranes = items.filter((s) => s.kind === 'gru');
  const covered = cranes.some((c) => c.kind === 'gru' && craneCoverage(project, c.p, c.radius).all);
  const areas = items.filter((s) => s.kind === 'area');
  const hasHuts = areas.some((a) => a.kind === 'area' && a.use === 'baraccamenti');
  const hasStore = areas.some((a) => a.kind === 'area' && a.use === 'deposito');
  const safety = computeComputo(project).filter((l) => l.category === 'Cantiere e sicurezza');
  const total = safety.reduce((s, l) => s + l.amount, 0);
  return (
    <>
      <Panel title="Verifiche di cantiere">
        <Row ok={closed} label="Recinzione chiusa" value={`${fmt(fenceLen, 1)} m`} />
        <Row ok={accesses.length > 0} label="Accessi" value={`${accesses.length}`} />
        <Row ok={covered} label="Edificio servito dalla gru" value={cranes.length ? `${cranes.length} gru` : 'nessuna gru'} />
        <Row ok={hasHuts} label="Baraccamenti" value={hasHuts ? 'previsti' : 'mancanti'} />
        <Row ok={hasStore} label="Area di deposito" value={hasStore ? 'prevista' : 'mancante'} />
      </Panel>
      <Panel title="Oneri in computo" aside={<button className="link" onClick={() => setPhase('computo')}>Apri 04 →</button>}>
        {safety.map((l) => (
          <div key={l.code} className="kv-line">
            <span>{l.item?.description}</span>
            <b className="mono">{fmt(l.qty, 1)} {l.item?.unit}</b>
            <b className="mono">{fmtEuro(l.amount)}</b>
          </div>
        ))}
        <div className="kv-line kv-total">
          <span>Totale cantiere e sicurezza</span>
          <b />
          <b className="mono">{fmtEuro(total)}</b>
        </div>
      </Panel>
      <p className="note">Ogni apprestamento disegnato entra automaticamente nel computo (categoria «Cantiere e sicurezza»).</p>
    </>
  );
}

function Row({ ok, label, value }: { ok: boolean; label: string; value: string }) {
  return (
    <div className={`check-row ${ok ? 'ok' : 'warn'}`}>
      <b>{ok ? '✓' : '!'} {label}</b>
      <span className="mono">{value}</span>
    </div>
  );
}
