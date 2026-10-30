import { useStore } from '../model/store';
import type { Catalog, LayerRole, Project, Wall, WallLayer } from '../model/types';
import {
  add,
  byId,
  dist,
  elementCode,
  elementLabel,
  fmt,
  levelAbove,
  mul,
  norm,
  openingSpans,
  polygonArea,
  polygonPerimeter,
  sortedLevels,
  sub,
  wallHeight,
  wallLength,
  wallThickness,
} from '../model/geometry';
import { deleteElements } from '../model/edit';
import { roofSurface } from '../model/quantities';
import { NumberField, SelectField, TextField } from '../ui/controls';
import { Icon } from '../ui/icons';

export type CatalogKey = keyof Catalog;

export function Inspector({ ids, onEditType }: { ids: string[]; onEditType: (k: CatalogKey, id: string) => void }) {
  const project = useStore((s) => s.project);
  const edit = useStore((s) => s.edit);
  const select = useStore((s) => s.select);
  const els = ids.map((id) => project.elements.find((e) => e.id === id)).filter(Boolean);
  if (!els.length) return null;

  const remove = () => {
    edit((d) => deleteElements(d, ids));
    select('modello', []);
  };

  if (els.length > 1) {
    return (
      <div className="inspector">
        <div className="insp-kicker">Selezione multipla</div>
        <h2 className="insp-title">{els.length} elementi</h2>
        <p className="note">Trascina per spostarli insieme.</p>
        <button className="btn btn-danger btn-block" onClick={remove}>
          <Icon name="trash" size={14} /> Elimina selezione
        </button>
      </div>
    );
  }

  const e = els[0]!;
  const upd = (fn: (x: typeof e) => void) =>
    edit((d) => {
      const x = d.elements.find((q) => q.id === e.id);
      if (x) fn(x as typeof e);
    });
  const levelOptions = sortedLevels(project).map((l) => ({ value: l.id, label: l.name }));
  const typeSelect = (key: CatalogKey, value: string, filter?: (t: { id: string; category?: string }) => boolean) => (
    <div className="type-row">
      <SelectField
        label="Tipologia"
        value={value}
        options={(project.catalog[key] as { id: string; name: string; category?: string }[]).filter((t) => !filter || filter(t)).map((t) => ({ value: t.id, label: t.name }))}
        onChange={(v) => upd((x) => ((x as { typeId: string }).typeId = v))}
      />
      <button className="icon-btn" title="Modifica la tipologia" onClick={() => onEditType(key, value)}>
        <Icon name="edit" size={14} />
      </button>
    </div>
  );

  return (
    <div className="inspector">
      <div className="insp-head">
        <div>
          <div className="insp-kicker">{elementLabel(e)}</div>
          <h2 className="insp-title">{elementCode(project, e)}</h2>
        </div>
        <span className="badge mono">{e.id.slice(-6)}</span>
      </div>

      {e.kind === 'wall' && <WallInspector project={project} id={e.id} typeSelect={typeSelect} levelOptions={levelOptions} />}

      {e.kind === 'opening' && (() => {
        const t = byId(project.catalog.opening, e.typeId);
        const w = project.elements.find((x) => x.id === e.wallId);
        const L = w && w.kind === 'wall' ? wallLength(w) : 0;
        return (
          <>
            {typeSelect('opening', e.typeId)}
            <div className="fields">
              <NumberField label="Distanza dall’inizio muro" unit="m" value={e.offset} min={(t?.width ?? 0) / 2} max={L - (t?.width ?? 0) / 2} onChange={(v) => upd((x) => x.kind === 'opening' && (x.offset = v))} />
            </div>
            {t?.category === 'porta' && (
              <div className="door-tools">
                <button className="btn" onClick={() => upd((x) => x.kind === 'opening' && (x.flip = !x.flip))} title="L’anta apre verso l’altro lato del muro">
                  ⇅ Inverti verso
                </button>
                <button className="btn" onClick={() => upd((x) => x.kind === 'opening' && (x.mirror = !x.mirror))} title="Sposta la cerniera sull’altro stipite">
                  ⇆ Specchia cerniera
                </button>
              </div>
            )}
            <div className="kv-grid">
              <div><span>Luce netta</span><b className="mono">{fmt(t?.width ?? 0)} × {fmt(t?.height ?? 0)} m</b></div>
              <div><span>Davanzale</span><b className="mono">{fmt(t?.sill ?? 0)} m</b></div>
              <div><span>Superficie</span><b className="mono">{fmt((t?.width ?? 0) * (t?.height ?? 0))} m²</b></div>
              {t?.uw !== undefined && <div><span>Uw</span><b className="mono">{fmt(t.uw)} W/m²K</b></div>}
              <div><span>Muro ospite</span><b className="mono">{w ? elementCode(project, w) : '—'}</b></div>
            </div>
          </>
        );
      })()}

      {e.kind === 'slab' && (() => {
        const t = byId(project.catalog.slab, e.typeId);
        const A = polygonArea(e.points);
        return (
          <>
            {typeSelect('slab', e.typeId)}
            <SelectField label="Livello" value={e.levelId} options={levelOptions} onChange={(v) => upd((x) => x.kind === 'slab' && (x.levelId = v))} />
            <div className="kv-grid">
              <div><span>Superficie</span><b className="mono">{fmt(A)} m²</b></div>
              <div><span>Perimetro</span><b className="mono">{fmt(polygonPerimeter(e.points))} m</b></div>
              <div><span>Spessore</span><b className="mono">{fmt(t?.thickness ?? 0)} m</b></div>
              <div><span>Volume</span><b className="mono">{fmt(A * (t?.thickness ?? 0))} m³</b></div>
              <div><span>Pavimento</span><b>{t?.finishName}</b></div>
              <div><span>Vertici</span><b className="mono">{e.points.length}</b></div>
            </div>
          </>
        );
      })()}

      {e.kind === 'column' && (() => {
        const t = byId(project.catalog.column, e.typeId);
        const lvl = byId(project.levels, e.levelId);
        return (
          <>
            {typeSelect('column', e.typeId)}
            <SelectField label="Livello" value={e.levelId} options={levelOptions} onChange={(v) => upd((x) => x.kind === 'column' && (x.levelId = v))} />
            <div className="fields fields-2">
              <NumberField label="X" unit="m" value={e.p.x} onChange={(v) => upd((x) => x.kind === 'column' && (x.p = { ...x.p, x: v }))} />
              <NumberField label="Y" unit="m" value={e.p.y} onChange={(v) => upd((x) => x.kind === 'column' && (x.p = { ...x.p, y: v }))} />
            </div>
            <div className="kv-grid">
              <div><span>Sezione</span><b className="mono">{fmt(t?.width ?? 0)} × {fmt(t?.depth ?? 0)} m</b></div>
              <div><span>Altezza</span><b className="mono">{fmt(lvl?.height ?? 0)} m</b></div>
              <div><span>Volume</span><b className="mono">{fmt((t?.width ?? 0) * (t?.depth ?? 0) * (lvl?.height ?? 0), 3)} m³</b></div>
              <div><span>Materiale</span><b>{t?.material}</b></div>
            </div>
          </>
        );
      })()}

      {e.kind === 'beam' && (() => {
        const t = byId(project.catalog.beam, e.typeId);
        const L = dist(e.a, e.b);
        return (
          <>
            {typeSelect('beam', e.typeId)}
            <SelectField label="Livello" value={e.levelId} options={levelOptions} onChange={(v) => upd((x) => x.kind === 'beam' && (x.levelId = v))} />
            <NumberField label="Luce" unit="m" value={L} min={0.1} onChange={(v) => upd((x) => x.kind === 'beam' && (x.b = add(x.a, mul(norm(sub(x.b, x.a)), v))))} />
            <div className="kv-grid">
              <div><span>Sezione</span><b className="mono">{fmt(t?.width ?? 0)} × {fmt(t?.height ?? 0)} m</b></div>
              <div><span>Volume</span><b className="mono">{fmt((t?.width ?? 0) * (t?.height ?? 0) * L, 3)} m³</b></div>
            </div>
          </>
        );
      })()}

      {e.kind === 'stair' && (() => {
        const lvl = byId(project.levels, e.levelId);
        const next = levelAbove(project, e.levelId);
        const rise = next && lvl ? next.elevation - lvl.elevation : lvl?.height ?? 3;
        const L = dist(e.a, e.b);
        const n = Math.max(2, Math.ceil(rise / 0.18));
        const a = rise / n;
        const p = L / n;
        const blondel = 2 * a + p;
        const ok = blondel >= 0.6 && blondel <= 0.66;
        return (
          <>
            <SelectField label="Livello di partenza" value={e.levelId} options={levelOptions} onChange={(v) => upd((x) => x.kind === 'stair' && (x.levelId = v))} />
            <div className="fields fields-2">
              <NumberField label="Larghezza rampa" unit="m" value={e.width} min={0.6} onChange={(v) => upd((x) => x.kind === 'stair' && (x.width = v))} />
              <NumberField label="Sviluppo" unit="m" value={L} min={0.5} onChange={(v) => upd((x) => x.kind === 'stair' && (x.b = add(x.a, mul(norm(sub(x.b, x.a)), v))))} />
            </div>
            <div className="kv-grid">
              <div><span>Dislivello</span><b className="mono">{fmt(rise)} m</b></div>
              <div><span>Gradini</span><b className="mono">{n}</b></div>
              <div><span>Alzata</span><b className="mono">{fmt(a * 100, 1)} cm</b></div>
              <div><span>Pedata</span><b className="mono">{fmt(p * 100, 1)} cm</b></div>
            </div>
            <div className={`check-row ${ok ? 'ok' : 'warn'}`}>
              <b>2a + p = {fmt(blondel * 100, 1)} cm</b>
              <span>{ok ? 'Regola di Blondel rispettata (60–66 cm)' : 'Fuori dall’intervallo 60–66 cm: modifica lo sviluppo'}</span>
            </div>
          </>
        );
      })()}

      {e.kind === 'roof' && (() => {
        const t = byId(project.catalog.roof, e.typeId);
        return (
          <>
            {typeSelect('roof', e.typeId)}
            <SelectField label="Su livello" value={e.levelId} options={levelOptions} onChange={(v) => upd((x) => x.kind === 'roof' && (x.levelId = v))} />
            <SelectField label="Forma" value={e.shape} options={[{ value: 'falde', label: 'A due falde' }, { value: 'piana', label: 'Piana' }]} onChange={(v) => upd((x) => x.kind === 'roof' && (x.shape = v))} />
            <div className="fields fields-2">
              {e.shape === 'falde' && <NumberField label="Pendenza" unit="°" digits={1} step={1} value={e.pitch} min={0} max={60} onChange={(v) => upd((x) => x.kind === 'roof' && (x.pitch = v))} />}
              <NumberField label="Sporto di gronda" unit="m" value={e.overhang} min={0} onChange={(v) => upd((x) => x.kind === 'roof' && (x.overhang = v))} />
            </div>
            <div className="kv-grid">
              <div><span>Superficie di falda</span><b className="mono">{fmt(roofSurface(e.points, e.shape, e.pitch, e.overhang))} m²</b></div>
              <div><span>Pendenza</span><b className="mono">{fmt(Math.tan((e.pitch * Math.PI) / 180) * 100, 0)} %</b></div>
              <div><span>Spessore pacchetto</span><b className="mono">{fmt(t?.thickness ?? 0)} m</b></div>
            </div>
          </>
        );
      })()}

      <div className="insp-actions">
        <button className="btn btn-danger" onClick={remove}>
          <Icon name="trash" size={14} /> Elimina
        </button>
      </div>
    </div>
  );
}

function WallInspector({
  project,
  id,
  typeSelect,
  levelOptions,
}: {
  project: Project;
  id: string;
  typeSelect: (k: CatalogKey, v: string) => React.ReactNode;
  levelOptions: { value: string; label: string }[];
}) {
  const edit = useStore((s) => s.edit);
  const w = project.elements.find((e) => e.id === id);
  if (!w || w.kind !== 'wall') return null;
  const t = byId(project.catalog.wall, w.typeId);
  const L = wallLength(w);
  const H = wallHeight(project, w);
  const th = wallThickness(t);
  const spans = openingSpans(project, w);
  const holes = spans.reduce((s, o) => s + (o.end - o.start) * Math.max(0, Math.min(o.type.height, H - o.type.sill)), 0);
  const upd = (fn: (x: Wall) => void) =>
    edit((d) => {
      const x = d.elements.find((q) => q.id === id);
      if (x && x.kind === 'wall') fn(x);
    });
  const lvl = byId(project.levels, w.levelId);
  return (
    <>
      {typeSelect('wall', w.typeId)}
      <SelectField label="Livello" value={w.levelId} options={levelOptions} onChange={(v) => upd((x) => (x.levelId = v))} />
      <div className="fields fields-2">
        <NumberField label="Lunghezza" unit="m" value={L} min={0.05} onChange={(v) => upd((x) => (x.b = add(x.a, mul(norm(sub(x.b, x.a)), v))))} />
        <NumberField label="Altezza" unit="m" value={H} min={0.1} onChange={(v) => upd((x) => (x.height = Math.abs(v - (lvl?.height ?? 0)) < 1e-6 ? undefined : v))} />
      </div>
      <p className="note">{w.height ? 'Altezza personalizzata.' : `Segue l’interpiano di «${lvl?.name}».`}{' '}
        {w.height && <button className="link" onClick={() => upd((x) => (x.height = undefined))}>Ripristina</button>}
      </p>
      <div className="fields fields-2">
        <NumberField label="Inizio X" unit="m" value={w.a.x} onChange={(v) => upd((x) => (x.a = { ...x.a, x: v }))} />
        <NumberField label="Inizio Y" unit="m" value={w.a.y} onChange={(v) => upd((x) => (x.a = { ...x.a, y: v }))} />
        <NumberField label="Fine X" unit="m" value={w.b.x} onChange={(v) => upd((x) => (x.b = { ...x.b, x: v }))} />
        <NumberField label="Fine Y" unit="m" value={w.b.y} onChange={(v) => upd((x) => (x.b = { ...x.b, y: v }))} />
      </div>

      <div className="subhead">
        Stratigrafia · {fmt(th * 100, 1)} cm
        <button className="link" onClick={() => upd((x) => (x.flip = !x.flip))} title="Scambia lato esterno e lato interno">
          Inverti lati ⇄
        </button>
      </div>
      <p className="note">Dall’alto in basso: dal lato esterno al lato interno.</p>
      <div className="strata">
        {t?.layers.map((l, i) => (
          <div key={i} className="strata-row">
            <span className="strata-chip" style={{ background: l.color }} />
            <span className="strata-name">{l.name}</span>
            <span className="mono">{fmt(l.thickness * 100, 1)} cm</span>
          </div>
        ))}
      </div>

      <div className="subhead">Quantità</div>
      <div className="kv-grid">
        <div><span>Superficie lorda</span><b className="mono">{fmt(L * H)} m²</b></div>
        <div><span>Aperture ({spans.length})</span><b className="mono">− {fmt(holes)} m²</b></div>
        <div><span>Superficie netta</span><b className="mono accent">{fmt(L * H - holes)} m²</b></div>
        <div><span>Volume</span><b className="mono">{fmt((L * H - holes) * th, 3)} m³</b></div>
      </div>
    </>
  );
}

// ───────── Editor delle tipologie ─────────

const ROLES: { value: LayerRole; label: string }[] = [
  { value: 'finitura', label: 'Finitura' },
  { value: 'isolante', label: 'Isolante' },
  { value: 'struttura', label: 'Struttura' },
  { value: 'altro', label: 'Altro' },
];

export function TypeEditor({ catKey, id, onClose }: { catKey: CatalogKey; id: string; onClose: () => void }) {
  const project = useStore((s) => s.project);
  const edit = useStore((s) => s.edit);
  const list = project.catalog[catKey] as { id: string; name: string }[];
  const t = list.find((x) => x.id === id);
  if (!t) return null;
  const instances = project.elements.filter((e) => 'typeId' in e && e.typeId === id).length;
  const upd = (fn: (x: never) => void) =>
    edit((d) => {
      const x = (d.catalog[catKey] as { id: string }[]).find((q) => q.id === id);
      if (x) fn(x as never);
    });
  const priceOptions = [{ value: '', label: '— nessuna voce —' }, ...project.prices.map((p) => ({ value: p.code, label: `${p.code} · ${p.description}` }))];

  return (
    <div className="inspector">
      <div className="insp-head">
        <div>
          <div className="insp-kicker">Tipologia · {instances} istanze</div>
          <h2 className="insp-title">{t.name}</h2>
        </div>
        <button className="btn" onClick={onClose}>Chiudi</button>
      </div>
      <p className="note">Le modifiche alla tipologia si propagano a tutte le istanze nel modello, nei fogli e nel computo.</p>
      <TextField label="Nome" value={t.name} onChange={(v) => upd((x: { name: string }) => (x.name = v))} />

      {catKey === 'wall' && (() => {
        const wt = byId(project.catalog.wall, id)!;
        const total = wallThickness(wt);
        const setLayer = (i: number, patch: Partial<WallLayer>) => upd((x: { layers: WallLayer[] }) => Object.assign(x.layers[i], patch));
        return (
          <>
            <SelectField label="Voce di computo (muratura)" value={wt.priceCode} options={priceOptions} onChange={(v) => upd((x: { priceCode: string }) => (x.priceCode = v))} />
            <div className="subhead">Stratigrafia (dall’esterno all’interno) · {fmt(total * 100, 1)} cm</div>
            <div className="strata-bar">
              {wt.layers.map((l, i) => (
                <span key={i} style={{ background: l.color, flexGrow: l.thickness }} title={l.name} />
              ))}
            </div>
            {wt.layers.map((l, i) => (
              <div key={i} className="layer-card">
                <div className="layer-top">
                  <input type="color" value={l.color} onChange={(e) => setLayer(i, { color: e.target.value })} />
                  <TextField label="Strato" value={l.name} onChange={(v) => setLayer(i, { name: v })} />
                  <div className="layer-tools">
                    <button className="icon-btn" disabled={i === 0} title="Sposta verso l’esterno" onClick={() => upd((x: { layers: WallLayer[] }) => x.layers.splice(i - 1, 0, x.layers.splice(i, 1)[0]))}>↑</button>
                    <button className="icon-btn" disabled={i === wt.layers.length - 1} title="Sposta verso l’interno" onClick={() => upd((x: { layers: WallLayer[] }) => x.layers.splice(i + 1, 0, x.layers.splice(i, 1)[0]))}>↓</button>
                    <button className="icon-btn" disabled={wt.layers.length < 2} title="Rimuovi strato" onClick={() => upd((x: { layers: WallLayer[] }) => x.layers.splice(i, 1))}>×</button>
                  </div>
                </div>
                <div className="fields fields-2">
                  <NumberField label="Spessore" unit="cm" digits={1} step={0.5} value={l.thickness * 100} min={0.1} onChange={(v) => setLayer(i, { thickness: v / 100 })} />
                  <SelectField label="Funzione" value={l.role} options={ROLES} onChange={(v) => setLayer(i, { role: v })} />
                </div>
                {l.role === 'finitura' && (
                  <SelectField label="Voce di computo finitura" value={l.priceCode ?? ''} options={priceOptions} onChange={(v) => setLayer(i, { priceCode: v || undefined })} />
                )}
              </div>
            ))}
            <button
              className="btn btn-block"
              onClick={() => upd((x: { layers: WallLayer[] }) => x.layers.push({ name: 'Nuovo strato', thickness: 0.05, role: 'altro', color: '#cccccc' }))}
            >
              <Icon name="plus" size={14} /> Aggiungi strato
            </button>
          </>
        );
      })()}

      {catKey === 'slab' && (() => {
        const st = byId(project.catalog.slab, id)!;
        return (
          <>
            <NumberField label="Spessore pacchetto" unit="cm" digits={1} value={st.thickness * 100} min={1} onChange={(v) => upd((x: { thickness: number }) => (x.thickness = v / 100))} />
            <SelectField label="Voce di computo (solaio)" value={st.priceCode} options={priceOptions} onChange={(v) => upd((x: { priceCode: string }) => (x.priceCode = v))} />
            <TextField label="Pavimento" value={st.finishName} onChange={(v) => upd((x: { finishName: string }) => (x.finishName = v))} />
            <SelectField label="Voce di computo (pavimento)" value={st.finishPriceCode ?? ''} options={priceOptions} onChange={(v) => upd((x: { finishPriceCode?: string }) => (x.finishPriceCode = v || undefined))} />
          </>
        );
      })()}

      {catKey === 'opening' && (() => {
        const ot = byId(project.catalog.opening, id)!;
        return (
          <>
            <SelectField label="Categoria" value={ot.category} options={[{ value: 'porta', label: 'Porta' }, { value: 'finestra', label: 'Finestra' }]} onChange={(v) => upd((x: { category: string }) => (x.category = v))} />
            <div className="fields fields-2">
              <NumberField label="Larghezza" unit="cm" digits={0} step={5} value={ot.width * 100} min={30} onChange={(v) => upd((x: { width: number }) => (x.width = v / 100))} />
              <NumberField label="Altezza" unit="cm" digits={0} step={5} value={ot.height * 100} min={30} onChange={(v) => upd((x: { height: number }) => (x.height = v / 100))} />
              <NumberField label="Davanzale" unit="cm" digits={0} step={5} value={ot.sill * 100} min={0} onChange={(v) => upd((x: { sill: number }) => (x.sill = v / 100))} />
              {ot.category === 'finestra' && <NumberField label="Uw" unit="W/m²K" value={ot.uw ?? 1.3} min={0.3} onChange={(v) => upd((x: { uw?: number }) => (x.uw = v))} />}
            </div>
            <SelectField label="Voce di computo" value={ot.priceCode} options={priceOptions} onChange={(v) => upd((x: { priceCode: string }) => (x.priceCode = v))} />
          </>
        );
      })()}

      {catKey === 'column' && (() => {
        const ct = byId(project.catalog.column, id)!;
        return (
          <>
            <div className="fields fields-2">
              <NumberField label="Base" unit="cm" digits={0} step={5} value={ct.width * 100} min={10} onChange={(v) => upd((x: { width: number }) => (x.width = v / 100))} />
              <NumberField label="Altezza sezione" unit="cm" digits={0} step={5} value={ct.depth * 100} min={10} onChange={(v) => upd((x: { depth: number }) => (x.depth = v / 100))} />
            </div>
            <TextField label="Materiale" value={ct.material} onChange={(v) => upd((x: { material: string }) => (x.material = v))} />
            <SelectField label="Voce di computo" value={ct.priceCode} options={priceOptions} onChange={(v) => upd((x: { priceCode: string }) => (x.priceCode = v))} />
          </>
        );
      })()}

      {catKey === 'beam' && (() => {
        const bt = byId(project.catalog.beam, id)!;
        return (
          <>
            <div className="fields fields-2">
              <NumberField label="Base" unit="cm" digits={0} step={5} value={bt.width * 100} min={10} onChange={(v) => upd((x: { width: number }) => (x.width = v / 100))} />
              <NumberField label="Altezza" unit="cm" digits={0} step={5} value={bt.height * 100} min={10} onChange={(v) => upd((x: { height: number }) => (x.height = v / 100))} />
            </div>
            <SelectField label="Voce di computo" value={bt.priceCode} options={priceOptions} onChange={(v) => upd((x: { priceCode: string }) => (x.priceCode = v))} />
          </>
        );
      })()}

      {catKey === 'roof' && (() => {
        const rt = byId(project.catalog.roof, id)!;
        return (
          <>
            <NumberField label="Spessore pacchetto" unit="cm" digits={1} value={rt.thickness * 100} min={1} onChange={(v) => upd((x: { thickness: number }) => (x.thickness = v / 100))} />
            <SelectField label="Voce di computo" value={rt.priceCode} options={priceOptions} onChange={(v) => upd((x: { priceCode: string }) => (x.priceCode = v))} />
          </>
        );
      })()}

      <div className="insp-actions">
        <button
          className="btn btn-danger"
          disabled={instances > 0 || list.length < 2}
          title={instances > 0 ? 'La tipologia è usata nel modello' : ''}
          onClick={() => {
            edit((d) => {
              const arr = d.catalog[catKey] as { id: string }[];
              arr.splice(arr.findIndex((x) => x.id === id), 1);
            });
            onClose();
          }}
        >
          <Icon name="trash" size={14} /> Elimina tipologia
        </button>
      </div>
    </div>
  );
}

