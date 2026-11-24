import { useState } from 'react';
import { useStore } from '../model/store';
import type { Catalog, LayerRole, Project, SlabEdge, Wall, WallComputeMode, WallLayer } from '../model/types';
import {
  add,
  byId,
  DEFAULT_HEADROOM,
  dist,
  elementCode,
  elementLabel,
  fmt,
  fmtEuro,
  mul,
  norm,
  openingSpans,
  polygonArea,
  polygonPerimeter,
  fmtLevel,
  slabHoles,
  slabNetArea,
  slabOutline,
  sortedLevels,
  stairAxisLength,
  stairSteps,
  stairLayout,
  sub,
  wallHeight,
  wallLength,
  wallThickness,
} from '../model/geometry';
import { copyElementsToLevel, deleteElements } from '../model/edit';
import { roofSurface, wallTypeUnitCosts } from '../model/quantities';
import { isConvexPolygon, isOrthogonal, ROOF_SHAPE_LABEL, roofTop } from '../model/roofs';
import { VAULT_SHAPE_LABEL, vaultFrame, vaultLevels, vaultQuantities, vaultSpans, vaultType } from '../model/vaults';
import { ARCH_LABEL, archRise, defaultRise, fixtureSpec, frameDepth, frameDistance, hasThreshold, isBareOpening, leavesOf, openingAreaIn } from '../model/openings';
import { isExteriorWall } from '../model/dimensions';
import { wallGeom } from '../model/walls';
import { NumberField, Segmented, SelectField, TextField } from '../ui/controls';
import { Icon } from '../ui/icons';
import { HATCH_KINDS, HATCH_LABEL, HatchSwatch, hatchOf } from '../views/hatch';
import type { ArchHead, VaultShape, BuildingElement, ElementStatus, FramePosition, HatchKind, Opening, OpeningType, Roof, Stair, WallRef } from '../model/types';
import { STATUS_LABEL, statusOf } from '../model/states';

export type CatalogKey = keyof Catalog;

/** Stato degli elementi nelle ristrutturazioni: esistente, da demolire, nuova costruzione */
function StatusField({ ids }: { ids: string[] }) {
  const project = useStore((s) => s.project);
  const edit = useStore((s) => s.edit);
  const found = project.elements.filter((e) => ids.includes(e.id)).map(statusOf);
  const same = found.every((x) => x === found[0]);
  const options = [
    ...(same ? [] : [{ value: 'misto' as const, label: 'Stati diversi' }]),
    ...(Object.keys(STATUS_LABEL) as ElementStatus[]).map((v) => ({ value: v, label: STATUS_LABEL[v] })),
  ];
  return (
    <SelectField<ElementStatus | 'misto'>
      label="Stato"
      value={same ? found[0] ?? 'nuovo' : 'misto'}
      options={options}
      onChange={(v) =>
        v !== 'misto' &&
        edit((d) => {
          for (const x of d.elements)
            if (ids.includes(x.id)) {
              if (v === 'nuovo') delete x.status;
              else x.status = v;
            }
        })
      }
    />
  );
}

/**
 * Riferimento di un muro esistente, detto con i suoi fili (esterno/interno) invece che con il verso
 * di disegno. Cambiarlo non sposta il muro: decide quale filo resta fermo se cambia lo spessore.
 */
function WallRefField({ project, wall: w, onChange }: { project: Project; wall: Wall; onChange: (r: WallRef) => void }) {
  const g = wallGeom(project, w);
  // il lato sinistro (+n) è l'esterno se extSign = +1
  const extRef: WallRef = g.extSign === 1 ? 'sinistra' : 'destra';
  const intRef: WallRef = extRef === 'sinistra' ? 'destra' : 'sinistra';
  const value = !w.ref || w.ref === 'asse' ? 'asse' : w.ref === extRef ? 'esterno' : 'interno';
  return (
    <SelectField<'asse' | 'esterno' | 'interno'>
      label="Riferimento (resta fermo se cambia lo spessore)"
      value={value}
      options={[
        { value: 'esterno', label: 'Filo esterno' },
        { value: 'asse', label: 'Asse' },
        { value: 'interno', label: 'Filo interno' },
      ]}
      onChange={(v) => onChange(v === 'asse' ? 'asse' : v === 'esterno' ? extRef : intRef)}
    />
  );
}

const FRAME_LABEL: Record<FramePosition, string> = {
  auto: 'Automatica',
  esterno: 'A filo esterno',
  asse: 'In asse al muro',
  interno: 'A filo interno',
  distanza: 'A distanza dal filo esterno',
};

/** Posizione del telaio nello spessore del muro, per questa apertura */
function FrameField({
  project,
  opening: o,
  wall: w,
  type: t,
  upd,
}: {
  project: Project;
  opening: Opening;
  wall: Wall;
  type: OpeningType;
  upd: (fn: (x: BuildingElement) => void) => void;
}) {
  const g = wallGeom(project, w);
  const spec = fixtureSpec(project, w, g, o, t);
  const thick = 2 * g.half;
  const dist = frameDistance(g, spec);
  const maxD = Math.max(0, thick - Math.min(frameDepth(t), thick));
  const pos = o.frame ?? 'auto';
  const set = (fn: (x: Opening) => void) => upd((x) => x.kind === 'opening' && fn(x));
  return (
    <>
      <SelectField<FramePosition>
        label="Telaio nello spessore del muro"
        value={pos}
        options={(Object.keys(FRAME_LABEL) as FramePosition[]).map((v) => ({ value: v, label: FRAME_LABEL[v] }))}
        onChange={(v) =>
          set((x) => {
            if (v === 'auto') {
              delete x.frame;
              delete x.frameOffset;
              return;
            }
            x.frame = v;
            // passando a «distanza» si parte dalla posizione attuale, così il telaio non salta
            if (v === 'distanza') x.frameOffset = +Math.min(maxD, Math.max(0, dist)).toFixed(3);
            else delete x.frameOffset;
          })
        }
      />
      {pos === 'distanza' && (
        <NumberField
          label="Distanza dal filo esterno"
          unit="cm"
          digits={1}
          step={1}
          min={0}
          max={maxD * 100}
          value={(o.frameOffset ?? 0) * 100}
          onChange={(v) => set((x) => (x.frameOffset = Math.min(maxD, Math.max(0, v / 100))))}
        />
      )}
      <p className="note">
        Telaio da {Math.round(spec.fd * 100)} cm: faccia esterna a {fmt(Math.max(0, dist) * 100, 1)} cm dal filo esterno, faccia interna a {fmt(Math.max(0, thick - dist - spec.fd) * 100, 1)} cm dal filo interno (muro da {fmt(thick * 100, 1)} cm).
      </p>
    </>
  );
}

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
        <div className="kv-grid kv-1">
          {Object.entries(
            els.reduce<Record<string, number>>((acc, x) => {
              const k = elementLabel(x!);
              acc[k] = (acc[k] ?? 0) + 1;
              return acc;
            }, {}),
          ).map(([k, n]) => (
            <div key={k}>
              <span>{k}</span>
              <b className="mono">{n}</b>
            </div>
          ))}
        </div>
        <StatusField ids={ids} />
        <p className="note">Trascina per spostarli insieme · Maiusc + clic o riquadro per aggiungere · Canc per eliminare.</p>
        <CopyToLevel ids={ids} />
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
      <StatusField ids={[e.id]} />

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
            {t?.category === 'porta' && t.leaves !== 0 && (
              <div className="door-tools">
                <button className="btn" onClick={() => upd((x) => x.kind === 'opening' && (x.flip = !x.flip))} title="L’anta apre verso l’altro lato del muro">
                  ⇅ Inverti verso
                </button>
                <button className="btn" onClick={() => upd((x) => x.kind === 'opening' && (x.mirror = !x.mirror))} title="Sposta la cerniera sull’altro stipite">
                  ⇆ Specchia cerniera
                </button>
              </div>
            )}
            {t && w && w.kind === 'wall' && !isBareOpening(t) && <FrameField project={project} opening={e} wall={w} type={t} upd={upd} />}
            {t && w && w.kind === 'wall' && t.sill === 0 && (
              <SelectField<'auto' | 'si' | 'no'>
                label="Soglia"
                value={e.threshold === undefined ? 'auto' : e.threshold ? 'si' : 'no'}
                options={[
                  { value: 'auto', label: `Automatica (${hasThreshold({}, t, isExteriorWall(project, w)) ? 'sì, muro perimetrale' : 'no, muro interno'})` },
                  { value: 'si', label: 'Sì · tutto lo spessore del muro' },
                  { value: 'no', label: 'No' },
                ]}
                onChange={(v) =>
                  upd((x) => {
                    if (x.kind !== 'opening') return;
                    if (v === 'auto') delete x.threshold;
                    else x.threshold = v === 'si';
                  })
                }
              />
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
        const outline = slabOutline(project, e);
        const holes = slabHoles(project, e);
        const A = slabNetArea(project, e);
        const edge = e.edge ?? 'auto';
        const lowest = sortedLevels(project)[0]?.id === e.levelId;
        return (
          <>
            {typeSelect('slab', e.typeId)}
            <SelectField label="Livello" value={e.levelId} options={levelOptions} onChange={(v) => upd((x) => x.kind === 'slab' && (x.levelId = v))} />
            <div className="subhead">Bordo sui muri</div>
            <Segmented<SlabEdge>
              small
              value={edge}
              options={[
                { value: 'auto', label: 'Auto', title: lowest ? 'Livello più basso: a filo esterno verso fuori' : 'Sull’asse dei muri' },
                { value: 'asse', label: 'Asse', title: 'Sull’asse dei muri, come disegnato' },
                { value: 'interno', label: 'Interno', title: 'A filo del muro dal lato del solaio' },
                { value: 'esterno', label: 'Esterno', title: 'A filo del muro dal lato opposto' },
                { value: 'distanza', label: 'Distanza', title: 'Scostamento libero dall’asse' },
              ]}
              onChange={(v) =>
                upd((x) => {
                  if (x.kind !== 'slab') return;
                  x.edge = v === 'auto' ? undefined : v;
                  if (v === 'distanza' && x.edgeOffset === undefined) x.edgeOffset = 0;
                })
              }
            />
            {edge === 'distanza' && (
              <NumberField
                label="Distanza dall’asse (+ verso l’esterno del solaio)"
                unit="cm"
                digits={1}
                step={1}
                value={(e.edgeOffset ?? 0) * 100}
                onChange={(v) => upd((x) => x.kind === 'slab' && (x.edgeOffset = v / 100))}
              />
            )}
            <p className="note">
              {edge === 'auto'
                ? lowest
                  ? 'Platea: sotto i muri perimetrali fino al filo esterno; le pavimentazioni esterne restano sull’asse.'
                  : 'Sull’asse dei muri.'
                : 'Vale per i lati appoggiati a un muro del livello (o di quello sotto); gli altri restano come disegnati.'}
            </p>
            <div className="kv-grid">
              <div><span>Superficie</span><b className="mono">{fmt(A)} m²</b></div>
              <div><span>Perimetro</span><b className="mono">{fmt(polygonPerimeter(outline))} m</b></div>
              <div><span>Spessore</span><b className="mono">{fmt(t?.thickness ?? 0)} m</b></div>
              <div><span>Volume</span><b className="mono">{fmt(A * (t?.thickness ?? 0))} m³</b></div>
              <div><span>Pavimento</span><b>{t?.finishName}</b></div>
              <div><span>Vertici</span><b className="mono">{e.points.length}</b></div>
              {holes.length > 0 && (
                <div><span>Fori scala</span><b className="mono">{holes.length} · {fmt(holes.reduce((t, h) => t + polygonArea(h), 0))} m²</b></div>
              )}
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
        const { rise, n, h: a, tread: p, L, k1, shape } = stairSteps(project, e);
        const blondel = 2 * a + p;
        const ok = blondel >= 0.6 && blondel <= 0.66;
        const setLength = (len: number) => upd((x) => x.kind === 'stair' && (x.b = add(x.a, mul(norm(sub(x.b, x.a)), Math.max(0.1, len)))));
        // cambiando le alzate la pedata resta quella: si allunga o si accorcia la rampa
        const setRisers = (k: number) =>
          upd((x) => {
            if (x.kind !== 'stair') return;
            const r = Math.max(2, Math.round(k));
            x.risers = r;
            x.b = add(x.a, mul(norm(sub(x.b, x.a)), Math.max(0.1, stairAxisLength(x, r, p))));
          });
        // forma e prima rampa: la pedata resta quella
        const reshape = (patch: Partial<Stair>) =>
          upd((x) => {
            if (x.kind !== 'stair') return;
            Object.assign(x, patch);
            x.b = add(x.a, mul(norm(sub(x.b, x.a)), Math.max(0.1, stairAxisLength(x, n, p))));
          });
        return (
          <>
            <SelectField label="Livello di partenza" value={e.levelId} options={levelOptions} onChange={(v) => upd((x) => x.kind === 'stair' && (x.levelId = v))} />
            <div className="subhead">Forma</div>
            <Segmented<'dritta' | 'L' | 'U'>
              small
              value={shape}
              options={[
                { value: 'dritta', label: 'Dritta' },
                { value: 'L', label: 'L' },
                { value: 'U', label: 'U' },
              ]}
              onChange={(v) => reshape({ shape: v === 'dritta' ? undefined : v, turn: e.turn ?? 'sinistra' })}
            />
            {shape !== 'dritta' && (
              <>
                <Segmented<'sinistra' | 'destra'>
                  small
                  value={e.turn ?? 'sinistra'}
                  options={[
                    { value: 'sinistra', label: 'Svolta a sinistra' },
                    { value: 'destra', label: 'Svolta a destra' },
                  ]}
                  onChange={(v) => reshape({ turn: v })}
                />
                {/* le due rampe: alzate (pianerottolo compreso nella prima) e lunghezze in pianta */}
                <div className="fields fields-2">
                  <NumberField label="Alzate 1ª rampa" digits={0} step={1} value={k1} min={2} max={n - 1} onChange={(v) => reshape({ firstRisers: Math.round(v) })} />
                  <NumberField label="Alzate 2ª rampa" digits={0} step={1} value={n - k1} min={1} max={n - 2} onChange={(v) => reshape({ firstRisers: n - Math.round(v) })} />
                </div>
                <div className="kv-grid">
                  {stairLayout(project, e).flights.map((f, i) => (
                    <div key={i}>
                      <span>{i === 0 ? '1ª' : '2ª'} rampa</span>
                      <b className="mono">
                        {f.steps} pedate · {fmt(f.len)} m
                      </b>
                    </div>
                  ))}
                </div>
                <div className="door-tools">
                  <button className="btn" onClick={() => reshape({ firstRisers: Math.ceil(n / 2) })} title="Stesse alzate (o quasi) nelle due rampe">
                    Rampe uguali
                  </button>
                  <button className="btn" onClick={() => reshape({ firstRisers: n - k1 + 1 })} disabled={n - k1 + 1 === k1} title="La rampa lunga diventa corta e viceversa">
                    Scambia le rampe
                  </button>
                </div>
                {shape === 'U' && (
                  <NumberField label="Pozzo tra le rampe" unit="cm" digits={0} step={5} value={(e.gap ?? 0.1) * 100} min={0} onChange={(v) => upd((x) => x.kind === 'stair' && (x.gap = v / 100))} />
                )}
              </>
            )}
            <div className="fields fields-2">
              <NumberField label="Larghezza rampa" unit="m" value={e.width} min={0.6} onChange={(v) => upd((x) => x.kind === 'stair' && (x.width = v))} />
              <NumberField label={shape === 'dritta' ? 'Sviluppo' : 'Prima rampa'} unit="m" value={L} min={0.1} onChange={setLength} />
            </div>
            <div className="subhead">
              Gradini · dislivello {fmt(rise)} m
              {e.risers ? (
                <button className="link" onClick={() => upd((x) => x.kind === 'stair' && (x.risers = undefined))} title="Torna al numero minimo con alzata ≤ 18 cm">
                  Automatico
                </button>
              ) : null}
            </div>
            <div className="fields fields-3">
              <NumberField label="Alzate" digits={0} step={1} value={n} min={2} onChange={setRisers} />
              <NumberField label="Alzata" unit="cm" digits={1} step={0.5} value={a * 100} min={10} max={25} onChange={(v) => setRisers(rise / (v / 100))} />
              <NumberField label="Pedata" unit="cm" digits={1} step={0.5} value={p * 100} min={15} onChange={(v) => setLength(stairAxisLength(e, n, v / 100))} />
            </div>
            <p className="note">
              L’alzata deve dividere il dislivello: scrivendola si sceglie il numero di alzate più vicino. Alzate e pedata cambiano lo
              sviluppo della rampa.
            </p>
            <button className="btn btn-block" onClick={() => setLength(stairAxisLength(e, n, Math.max(0.22, 0.63 - 2 * a)))}>
              Pedata secondo Blondel (2a + p = 63 cm)
            </button>
            <label className="check">
              <input type="checkbox" checked={e.hole !== false} onChange={(ev) => upd((x) => x.kind === 'stair' && (x.hole = ev.target.checked ? undefined : false))} />
              Foro automatico nel solaio di arrivo
            </label>
            {e.hole !== false && (
              <NumberField
                label="Altezza libera minima sui gradini"
                unit="m"
                value={e.headroom ?? DEFAULT_HEADROOM}
                min={1.8}
                onChange={(v) => upd((x) => x.kind === 'stair' && (x.headroom = v))}
              />
            )}
            <div className="kv-grid">
              <div><span>Dislivello</span><b className="mono">{fmt(rise)} m</b></div>
              <div><span>Gradini</span><b className="mono">{n}</b></div>
              <div><span>Alzata</span><b className="mono">{fmt(a * 100, 1)} cm</b></div>
              <div><span>Pedata</span><b className="mono">{fmt(p * 100, 1)} cm</b></div>
            </div>
            <div className={`check-row ${ok ? 'ok' : 'warn'}`}>
              <b>2a + p = {fmt(blondel * 100, 1)} cm</b>
              <span>{ok ? 'Regola di Blondel rispettata (60–66 cm)' : 'Fuori dall’intervallo 60–66 cm: modifica alzate o pedata'}</span>
            </div>
          </>
        );
      })()}

      {e.kind === 'vault' && (() => {
        const fr = vaultFrame(e);
        const sp = vaultSpans(e, fr);
        const lv = vaultLevels(project, e);
        const q = vaultQuantities(project, e);
        const lvl = byId(project.levels, e.levelId);
        const half = (e.shape === 'crociera' ? Math.min(fr.L1, fr.L2) : sp.span) / 2;
        const keyOver = lvl && lv.top > lvl.elevation + lvl.height + 1e-3;
        return (
          <>
            {typeSelect('vault', e.typeId)}
            <SelectField<VaultShape>
              label="Forma"
              value={e.shape}
              options={(Object.keys(VAULT_SHAPE_LABEL) as VaultShape[]).map((v) => ({ value: v, label: VAULT_SHAPE_LABEL[v] }))}
              onChange={(v) => upd((x) => x.kind === 'vault' && (x.shape = v))}
            />
            {e.shape === 'botte' && (
              <SelectField<'0' | '1'>
                label="Generatrici"
                value={String(sp.generatrix) as '0' | '1'}
                options={[
                  { value: '0', label: `Lungo il lato di ${fmt(fr.L1)} m (luce ${fmt(fr.L2)} m)` },
                  { value: '1', label: `Lungo il lato di ${fmt(fr.L2)} m (luce ${fmt(fr.L1)} m)` },
                ]}
                onChange={(v) => upd((x) => x.kind === 'vault' && (x.axis = Number(v) as 0 | 1))}
              />
            )}
            <div className="fields fields-2">
              <NumberField label="Imposta dal piano" unit="m" value={e.spring} step={0.05} min={0} onChange={(v) => upd((x) => x.kind === 'vault' && (x.spring = v))} />
              <NumberField label="Freccia" unit="cm" digits={0} step={5} value={lv.rise * 100} min={5} max={half * 100} onChange={(v) => upd((x) => x.kind === 'vault' && (x.rise = v / 100))} />
            </div>
            <button className="link" onClick={() => upd((x) => x.kind === 'vault' && (x.rise = half))}>
              Tutto sesto (freccia {fmt(half)} m)
            </button>
            <div className="kv-grid">
              <div><span>Campo</span><b className="mono">{fmt(fr.L1)} × {fmt(fr.L2)} m</b></div>
              <div><span>Chiave (intradosso)</span><b className={`mono ${keyOver ? 'warn' : ''}`}>{fmt(lv.key - (lvl?.elevation ?? 0))} m</b></div>
              <div><span>Superficie d’intradosso</span><b className="mono">{fmt(q.area)} m²</b></div>
              <div><span>Rinfianco</span><b className="mono">{vaultType(project, e)?.fillPriceCode ? `${fmt(q.fill)} m³` : '—'}</b></div>
            </div>
            {keyOver && <p className="note warn">La volta in chiave, con il suo spessore, supera l’altezza del piano: abbassa l’imposta o la freccia.</p>}
            <p className="note">
              Quote dal piano del livello. {e.shape === 'crociera' ? 'Le due botti hanno la stessa chiave: sul lato corto l’arco è di cerchio, sul lato lungo è lo stesso arco allungato (ellittico), così i costoloni stanno sulle diagonali.' : 'Gli archi sono di cerchio: a tutto sesto con la freccia pari a metà della luce, ribassati se minore.'} Trascina gli angoli per cambiare il campo.
            </p>
          </>
        );
      })()}

      {e.kind === 'roof' && (() => {
        const t = byId(project.catalog.roof, e.typeId);
        return (
          <>
            {typeSelect('roof', e.typeId)}
            <SelectField label="Su livello" value={e.levelId} options={levelOptions} onChange={(v) => upd((x) => x.kind === 'roof' && (x.levelId = v))} />
            <SelectField<Roof['shape']>
              label="Forma"
              value={e.shape}
              options={(Object.keys(ROOF_SHAPE_LABEL) as Roof['shape'][]).map((v) => ({ value: v, label: ROOF_SHAPE_LABEL[v] }))}
              onChange={(v) => upd((x) => x.kind === 'roof' && (x.shape = v))}
            />
            {e.shape === 'falde' && (
              <SelectField<'auto' | 'x' | 'y'>
                label="Colmo"
                value={e.ridge ?? 'auto'}
                options={[
                  { value: 'auto', label: 'Lungo il lato più lungo' },
                  { value: 'x', label: 'Est – ovest' },
                  { value: 'y', label: 'Nord – sud' },
                ]}
                onChange={(v) => upd((x) => x.kind === 'roof' && (v === 'auto' ? delete x.ridge : (x.ridge = v)))}
              />
            )}
            {e.shape === 'falda' && (
              <SelectField<'sud' | 'nord' | 'est' | 'ovest'>
                label="La falda scende verso"
                value={e.slopeTo ?? 'sud'}
                options={(['sud', 'nord', 'est', 'ovest'] as const).map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }))}
                onChange={(v) => upd((x) => x.kind === 'roof' && (x.slopeTo = v))}
              />
            )}
            <div className="fields fields-2">
              {e.shape !== 'piana' && <NumberField label="Pendenza" unit="°" digits={1} step={1} value={e.pitch} min={0} max={60} onChange={(v) => upd((x) => x.kind === 'roof' && (x.pitch = v))} />}
              <NumberField label="Sporto di gronda" unit="m" value={e.overhang} min={0} onChange={(v) => upd((x) => x.kind === 'roof' && (x.overhang = v))} />
            </div>
            {e.shape !== 'piana' && e.shape !== 'falda' && !isConvexPolygon(e.points) && (
              <p className="note">
                {isOrthogonal(e.points)
                  ? 'Pianta a L, a T o a U: ogni braccio ha le sue falde e dove si incontrano nascono i compluvi.'
                  : 'Pianta non ortogonale: le falde si costruiscono sul contorno convesso.'}
              </p>
            )}
            <div className="kv-grid">
              <div><span>Superficie di falda</span><b className="mono">{fmt(roofSurface(project, e))} m²</b></div>
              {e.shape !== 'piana' && <div><span>Colmo</span><b className="mono">{fmtLevel(roofTop(project, e))}</b></div>}
              <div><span>Pendenza</span><b className="mono">{fmt(Math.tan((e.pitch * Math.PI) / 180) * 100, 0)} %</b></div>
              <div><span>Spessore pacchetto</span><b className="mono">{fmt(t?.thickness ?? 0)} m</b></div>
            </div>
          </>
        );
      })()}

      {e.kind !== 'opening' && <CopyToLevel ids={ids} />}
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
  const holes = spans.reduce((s, o) => s + openingAreaIn(o.type, H, o.end - o.start), 0);
  const upd = (fn: (x: Wall) => void) =>
    edit((d) => {
      const x = d.elements.find((q) => q.id === id);
      if (x && x.kind === 'wall') fn(x);
    });
  const lvl = byId(project.levels, w.levelId);
  return (
    <>
      {typeSelect('wall', w.typeId)}
      <WallRefField project={project} wall={w} onChange={(r) => upd((x) => (r === 'asse' ? delete x.ref : (x.ref = r)))} />
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
      <p className="note">Dall’alto in basso: dal lato esterno al lato interno. Il nucleo strutturale (bordo pieno) va dal primo all’ultimo strato «Struttura»; gli altri sono rivestimenti, posati dopo.</p>
      <div className="strata">
        {t?.layers.map((l, i) => (
          <div key={i} className={`strata-row ${layerInCore(t.layers, i) ? 'strata-core' : 'strata-cover'}`}>
            <HatchSwatch kinds={[hatchOf(l)]} width={16} height={12} />
            <span className="strata-name">{l.name}</span>
            <span className="strata-role">{ROLES.find((r) => r.value === l.role)?.label}</span>
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

interface Packaged {
  priceCode: string;
  layers?: WallLayer[];
  computeMode?: WallComputeMode;
  thickness?: number;
}

/**
 * Stratigrafia e modalità di computo, comuni a muri, solai e coperture:
 * voce del pacchetto, voci degli strati, Pacchetto / Strati / Misto, confronto al m².
 */
function PackageEditor({
  kind,
  type,
  update,
  priceOptions,
  order,
  upLabel,
  downLabel,
  areaNote,
  syncThickness,
  starter,
}: {
  kind: 'muro' | 'solaio' | 'copertura';
  type: Packaged;
  update: (fn: (x: Packaged) => void) => void;
  priceOptions: { value: string; label: string }[];
  order: string;
  upLabel: string;
  downLabel: string;
  areaNote: string;
  /** Solai e coperture: lo spessore del pacchetto è la somma degli strati */
  syncThickness?: boolean;
  /** Primi strati proposti quando la tipologia non ha ancora una stratigrafia */
  starter?: () => WallLayer[];
}) {
  const project = useStore((s) => s.project);
  const layers = type.layers ?? [];
  const mode: WallComputeMode = type.computeMode ?? 'misto';
  const override = project.wallComputeOverride ?? 'tipologia';
  const costs = wallTypeUnitCosts(project, { priceCode: type.priceCode, layers });
  const total = layers.reduce((s, l) => s + l.thickness, 0);
  const sync = (x: Packaged) => {
    if (syncThickness && x.layers?.length) x.thickness = +x.layers.reduce((s, l) => s + l.thickness, 0).toFixed(4);
  };
  const edit = (fn: (x: Packaged & { layers: WallLayer[] }) => void) =>
    update((x) => {
      x.layers = x.layers ?? [];
      fn(x as Packaged & { layers: WallLayer[] });
      sync(x);
    });
  const setLayer = (i: number, patch: Partial<WallLayer>) => edit((x) => Object.assign(x.layers[i], patch));
  return (
    <>
      <div className="subhead">Computo {kind === 'muro' ? 'del muro' : kind === 'solaio' ? 'del solaio' : 'della copertura'}</div>
      <Segmented<WallComputeMode>
        value={mode}
        onChange={(v) => update((x) => (x.computeMode = v))}
        options={[
          { value: 'pacchetto', label: 'Pacchetto', title: 'Una sola voce per tutto il pacchetto' },
          { value: 'strati', label: 'Strati', title: 'Somma delle voci dei singoli strati' },
          { value: 'misto', label: 'Misto', title: 'Voce del pacchetto più gli strati con voce propria' },
        ]}
      />
      <p className="note">
        {mode === 'pacchetto' && 'Si computa con la sola voce del pacchetto; le voci degli strati restano memorizzate ma non contano.'}
        {mode === 'strati' && `Si computa come somma degli strati: m² = ${areaNote}, m³ = superficie × spessore dello strato.`}
        {mode === 'misto' && 'Voce del pacchetto più gli strati che hanno una voce propria (per esempio le finiture computate a parte).'}
      </p>
      {override !== 'tipologia' && (
        <div className="check-row warn">
          <b>! Nel computo è attiva la scelta globale «tutti {override === 'pacchetto' ? 'a pacchetto' : 'per strati'}»</b>
          <span>Si cambia in 04 · Computo.</span>
        </div>
      )}
      <div className={mode === 'strati' ? 'is-off' : ''}>
        <SelectField label="Voce del pacchetto" value={type.priceCode} options={priceOptions} onChange={(v) => update((x) => (x.priceCode = v))} />
      </div>
      <div className="kv-grid">
        <div>
          <span>Pacchetto</span>
          <b className="mono">{costs.pack !== null ? `${fmtEuro(costs.pack)} / m²` : '—'}</b>
        </div>
        <div>
          <span>Somma strati ({costs.priced}/{costs.count} con voce)</span>
          <b className="mono">{costs.layers !== null ? `${fmtEuro(costs.layers)} / m²` : '—'}</b>
        </div>
      </div>
      {mode === 'misto' && type.priceCode && layers.some((l) => l.priceCode && l.role !== 'finitura') && (
        <div className="check-row warn">
          <b>! Possibile doppio computo</b>
          <span>In modalità Misto la voce del pacchetto e quella di uno strato non di finitura potrebbero contare la stessa lavorazione due volte.</span>
        </div>
      )}
      {!layers.length && starter ? (
        <>
          <p className="note">Questa tipologia non ha ancora una stratigrafia: è un pacchetto unico con il suo spessore.</p>
          <button className="btn btn-block" onClick={() => edit((x) => (x.layers = starter()))}>
            <Icon name="plus" size={14} /> Crea stratigrafia
          </button>
        </>
      ) : (
        <>
          <div className="subhead">
            Stratigrafia ({order}) · {fmt(total * 100, 1)} cm
          </div>
          <div className="strata-bar">
            <HatchSwatch kinds={layers.map(hatchOf)} weights={layers.map((l) => l.thickness)} width={262} height={22} />
          </div>
          {kind === 'muro' && (
            <p className="note">
              Funzione «Struttura» = nucleo (dal primo all’ultimo strato strutturale, intercapedini comprese); finiture e isolanti
              fuori dal nucleo sono rivestimenti: negli innesti a T la struttura li attraversa.
            </p>
          )}
          {layers.map((l, i) => (
            <div key={i} className={`layer-card ${kind === 'muro' ? (layerInCore(layers, i) ? 'strata-core' : 'strata-cover') : ''}`}>
              <div className="layer-top">
                <HatchSwatch kinds={[hatchOf(l)]} width={26} height={26} />
                <TextField label="Strato" value={l.name} onChange={(v) => setLayer(i, { name: v })} />
                <div className="layer-tools">
                  <button className="icon-btn" disabled={i === 0} title={`Sposta ${upLabel}`} onClick={() => edit((x) => x.layers.splice(i - 1, 0, x.layers.splice(i, 1)[0]))}>↑</button>
                  <button className="icon-btn" disabled={i === layers.length - 1} title={`Sposta ${downLabel}`} onClick={() => edit((x) => x.layers.splice(i + 1, 0, x.layers.splice(i, 1)[0]))}>↓</button>
                  <button className="icon-btn" disabled={layers.length < 2} title="Rimuovi strato" onClick={() => edit((x) => x.layers.splice(i, 1))}>×</button>
                </div>
              </div>
              <div className="fields fields-2">
                <NumberField label="Spessore" unit="cm" digits={1} step={0.5} value={l.thickness * 100} min={0.1} onChange={(v) => setLayer(i, { thickness: v / 100 })} />
                <SelectField label="Funzione" value={l.role} options={ROLES} onChange={(v) => setLayer(i, { role: v })} />
              </div>
              <SelectField<HatchKind | ''>
                label="Campitura"
                value={l.hatch ?? ''}
                options={[{ value: '', label: `Automatica · ${HATCH_LABEL[hatchOf({ ...l, hatch: undefined })].split(' · ')[0]}` }, ...HATCH_KINDS.map((k) => ({ value: k, label: HATCH_LABEL[k] }))]}
                onChange={(v) => setLayer(i, { hatch: v || undefined })}
              />
              <div className={mode === 'pacchetto' ? 'is-off' : ''}>
                <SelectField label="Voce di computo dello strato" value={l.priceCode ?? ''} options={priceOptions} onChange={(v) => setLayer(i, { priceCode: v || undefined })} />
              </div>
            </div>
          ))}
          <button className="btn btn-block" onClick={() => edit((x) => x.layers.push({ name: 'Nuovo strato', thickness: 0.05, role: 'altro', color: '#cccccc' }))}>
            <Icon name="plus" size={14} /> Aggiungi strato
          </button>
        </>
      )}
    </>
  );
}

/** Copia degli elementi selezionati su un altro livello, nella stessa posizione (porte e finestre comprese) */
function CopyToLevel({ ids }: { ids: string[] }) {
  const project = useStore((s) => s.project);
  const edit = useStore((s) => s.edit);
  const select = useStore((s) => s.select);
  const setActiveLevel = useStore((s) => s.setActiveLevel);
  const setNotice = useStore((s) => s.setNotice);
  const levels = sortedLevels(project);
  const first = project.elements.find((e) => e.id === ids[0]);
  const from = first && 'levelId' in first ? first.levelId : undefined;
  const others = levels.filter((l) => l.id !== from);
  // destinazione proposta: il livello sopra quello di partenza (non le coperture), altrimenti il primo disponibile
  const idx = levels.findIndex((l) => l.id === from);
  const above = levels.slice(idx + 1).find((l) => l.kind !== 'copertura');
  const [to, setTo] = useState(above?.id ?? others[0]?.id ?? '');
  if (!others.length) return null;
  const target = others.find((l) => l.id === to) ?? others[0];
  const copy = () => {
    let made: string[] = [];
    edit((d) => {
      made = copyElementsToLevel(d, ids, target.id);
    });
    setActiveLevel(target.id);
    select('modello', made);
    setNotice(`${made.length} elementi copiati su «${target.name}».`);
  };
  return (
    <div className="copy-level">
      <div className="subhead">Copia su un altro livello</div>
      <div className="type-row">
        <SelectField label="Livello di destinazione" value={target.id} options={others.map((l) => ({ value: l.id, label: l.name }))} onChange={setTo} />
      </div>
      <button className="btn btn-block" onClick={copy}>
        Copia nella stessa posizione
      </button>
      <p className="note">Anche con Ctrl+C sul livello di partenza e Ctrl+V sul livello di arrivo.</p>
    </div>
  );
}

/**
 * Eliminazione di una tipologia. Se è usata, gli elementi passano alla tipologia scelta
 * (per porte e finestre si propongono quelle della stessa categoria).
 */
function DeleteType({ catKey, id, instances, onDone }: { catKey: CatalogKey; id: string; instances: number; onDone: () => void }) {
  const project = useStore((s) => s.project);
  const edit = useStore((s) => s.edit);
  const list = project.catalog[catKey] as { id: string; name: string; category?: string }[];
  const self = list.find((x) => x.id === id);
  const others = list.filter((x) => x.id !== id && (catKey !== 'opening' || x.category === self?.category));
  const [target, setTarget] = useState(others[0]?.id ?? '');
  const [asking, setAsking] = useState(false);
  const replacement = others.find((x) => x.id === target) ?? others[0];
  const remove = () => {
    edit((d) => {
      if (instances > 0 && replacement) for (const e of d.elements) if ('typeId' in e && e.typeId === id) e.typeId = replacement.id;
      const arr = d.catalog[catKey] as { id: string }[];
      arr.splice(arr.findIndex((x) => x.id === id), 1);
    });
    onDone();
  };
  if (!others.length)
    return (
      <p className="note">
        È l’unica tipologia {catKey === 'opening' ? 'di questa categoria' : 'disponibile'}: per eliminarla creane prima un’altra con «+ Nuova».
      </p>
    );
  return (
    <div className="delete-type">
      <div className="subhead">Elimina tipologia</div>
      {instances > 0 && (
        <>
          <p className="note">
            È usata da {instances} {instances === 1 ? 'elemento' : 'elementi'}: prima di eliminarla scegli con quale tipologia sostituirla.
          </p>
          <SelectField label="Sostituisci con" value={replacement?.id ?? ''} options={others.map((x) => ({ value: x.id, label: x.name }))} onChange={setTarget} />
        </>
      )}
      {asking ? (
        <div className="check-row warn">
          <b>
            Eliminare «{self?.name}»{instances > 0 ? ` e sostituirla con «${replacement?.name}»` : ''}?
          </b>
          <div className="door-tools">
            <button className="btn" onClick={() => setAsking(false)}>Annulla</button>
            <button className="btn btn-danger" onClick={remove}>
              <Icon name="trash" size={14} /> Elimina
            </button>
          </div>
        </div>
      ) : (
        <button className="btn btn-danger btn-block" onClick={() => setAsking(true)}>
          <Icon name="trash" size={14} /> {instances > 0 ? 'Elimina e sostituisci' : 'Elimina tipologia'}
        </button>
      )}
      <p className="note">Si può annullare con Ctrl+Z.</p>
    </div>
  );
}

/** Nucleo strutturale: dal primo all'ultimo strato «struttura»; fuori, i rivestimenti (posati dopo) */
function layerInCore(layers: { role: string }[], j: number) {
  const first = layers.findIndex((l) => l.role === 'struttura');
  if (first < 0) return true;
  let last = first;
  layers.forEach((l, i) => l.role === 'struttura' && (last = i));
  return j >= first && j <= last;
}

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
        return (
          <PackageEditor
            kind="muro"
            type={wt}
            update={(fn) => upd(fn as never)}
            priceOptions={priceOptions}
            order="dall’esterno all’interno"
            upLabel="verso l’esterno"
            downLabel="verso l’interno"
            areaNote="superficie netta del muro"
          />
        );
      })()}

      {catKey === 'slab' && (() => {
        const st = byId(project.catalog.slab, id)!;
        return (
          <>
            {!st.layers?.length && (
              <>
                <NumberField label="Spessore pacchetto" unit="cm" digits={1} value={st.thickness * 100} min={1} onChange={(v) => upd((x: { thickness: number }) => (x.thickness = v / 100))} />
                <TextField label="Pavimento" value={st.finishName} onChange={(v) => upd((x: { finishName: string }) => (x.finishName = v))} />
                <SelectField label="Voce di computo (pavimento)" value={st.finishPriceCode ?? ''} options={priceOptions} onChange={(v) => upd((x: { finishPriceCode?: string }) => (x.finishPriceCode = v || undefined))} />
              </>
            )}
            <PackageEditor
              kind="solaio"
              type={st}
              update={(fn) => upd(fn as never)}
              priceOptions={priceOptions}
              order="dall’alto al basso"
              upLabel="verso l’alto"
              downLabel="verso il basso"
              areaNote="superficie del solaio"
              syncThickness
              starter={() => [
                { name: st.finishName || 'Pavimento', thickness: 0.015, role: 'finitura', color: '#c9b79c', priceCode: st.finishPriceCode },
                { name: 'Solaio', thickness: Math.max(0.05, st.thickness - 0.015), role: 'struttura', color: '#9aa0a6' },
              ]}
            />
          </>
        );
      })()}

      {catKey === 'opening' && (() => {
        const ot = byId(project.catalog.opening, id)!;
        return (
          <>
            <SelectField
              label="Categoria"
              value={ot.category}
              options={[{ value: 'porta', label: 'Porta' }, { value: 'finestra', label: 'Finestra' }]}
              onChange={(v) =>
                upd((x: { category: string; leaves?: 0 | 1 | 2 }) => {
                  x.category = v;
                  // una finestra non può essere un vano senza serramento
                  if (v === 'finestra' && x.leaves === 0) x.leaves = undefined;
                })
              }
            />
            <SelectField
              label="Ante"
              value={ot.leaves === undefined ? 'auto' : String(ot.leaves)}
              options={[
                { value: 'auto', label: `Automatico (${leavesOf({ ...ot, leaves: undefined }) === 2 ? 'due ante' : 'un’anta'})` },
                { value: '1', label: 'Un’anta' },
                { value: '2', label: 'Due ante' },
                ...(ot.category === 'porta' ? [{ value: '0', label: 'Nessuna · vano senza porta' }] : []),
              ]}
              onChange={(v) =>
                upd((x: { leaves?: 0 | 1 | 2; priceCode: string }) => {
                  x.leaves = v === 'auto' ? undefined : (Number(v) as 0 | 1 | 2);
                  // un vano senza porta non ha serramento da computare
                  if (x.leaves === 0) x.priceCode = '';
                })
              }
            />
            {ot.leaves === 0 && <p className="note">Vano senza porta: in pianta il varco con l’architrave tratteggiata, nessun telaio né anta nelle altre viste e nel computo dei serramenti.</p>}
            <div className="fields fields-2">
              <NumberField label="Larghezza" unit="cm" digits={0} step={5} value={ot.width * 100} min={30} onChange={(v) => upd((x: { width: number }) => (x.width = v / 100))} />
              <NumberField label="Altezza" unit="cm" digits={0} step={5} value={ot.height * 100} min={30} onChange={(v) => upd((x: { height: number }) => (x.height = v / 100))} />
              <NumberField label="Davanzale" unit="cm" digits={0} step={5} value={ot.sill * 100} min={0} onChange={(v) => upd((x: { sill: number }) => (x.sill = v / 100))} />
              {ot.category === 'finestra' && <NumberField label="Uw" unit="W/m²K" value={ot.uw ?? 1.3} min={0.3} onChange={(v) => upd((x: { uw?: number }) => (x.uw = v))} />}
            </div>
            <div className="fields fields-2">
              <SelectField
                label="Testa"
                value={ot.head ?? 'piana'}
                options={(Object.keys(ARCH_LABEL) as ArchHead[]).map((h) => ({ value: h, label: ARCH_LABEL[h] }))}
                onChange={(v) =>
                  upd((x: { head?: ArchHead; rise?: number; width: number }) => {
                    if (v === 'piana') delete x.head;
                    else x.head = v;
                    if (v === 'ribassato' && x.rise === undefined) x.rise = defaultRise(x.width);
                  })
                }
              />
              {ot.head === 'ribassato' && (
                <NumberField label="Freccia" unit="cm" digits={0} step={5} value={archRise(ot) * 100} min={1} max={(ot.width / 2) * 100} onChange={(v) => upd((x: { rise?: number }) => (x.rise = v / 100))} />
              )}
            </div>
            {ot.head && ot.head !== 'piana' && (
              <p className="note">
                L’altezza è misurata in chiave: l’arco parte dall’imposta a {fmt(ot.sill + ot.height - archRise(ot))} m dal pavimento, con una freccia di {fmt(archRise(ot))} m
                {ot.head === 'tutto-sesto' ? ' (metà della luce)' : ''}.{ot.leaves !== 0 ? ' Sopra l’imposta il serramento ha una lunetta fissa.' : ''}
              </p>
            )}
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

      {catKey === 'vault' && (() => {
        const vt = byId(project.catalog.vault, id)!;
        return (
          <>
            <NumberField label="Spessore della volta" unit="cm" digits={0} step={1} value={vt.thickness * 100} min={3} onChange={(v) => upd((x: { thickness: number }) => (x.thickness = v / 100))} />
            <SelectField label="Voce di computo (volta, m² d’intradosso)" value={vt.priceCode} options={priceOptions} onChange={(v) => upd((x: { priceCode: string }) => (x.priceCode = v))} />
            <SelectField
              label="Rinfianco (m³)"
              value={vt.fillPriceCode ?? ''}
              options={[{ value: '', label: '— senza riempimento —' }, ...priceOptions.slice(1)]}
              onChange={(v) => upd((x: { fillPriceCode?: string }) => (x.fillPriceCode = v || undefined))}
            />
            <p className="note">Il rinfianco riempie lo spazio tra l’estradosso e il piano orizzontale per la chiave della volta.</p>
          </>
        );
      })()}

      {catKey === 'roof' && (() => {
        const rt = byId(project.catalog.roof, id)!;
        return (
          <>
            {!rt.layers?.length && (
              <NumberField label="Spessore pacchetto" unit="cm" digits={1} value={rt.thickness * 100} min={1} onChange={(v) => upd((x: { thickness: number }) => (x.thickness = v / 100))} />
            )}
            <PackageEditor
              kind="copertura"
              type={rt}
              update={(fn) => upd(fn as never)}
              priceOptions={priceOptions}
              order="dall’alto al basso"
              upLabel="verso l’alto"
              downLabel="verso il basso"
              areaNote="superficie di falda"
              syncThickness
              starter={() => [{ name: 'Pacchetto di copertura', thickness: rt.thickness, role: 'altro', color: '#9a5b45' }]}
            />
          </>
        );
      })()}

      <DeleteType catKey={catKey} id={id} instances={instances} onDone={onClose} />
    </div>
  );
}

