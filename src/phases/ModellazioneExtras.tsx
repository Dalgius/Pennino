// Pannelli dell'editor che non riguardano gli elementi costruttivi: livelli di visibilità,
// menu contestuale, locali e annotazioni.

import type { ReactNode } from 'react';
import type { Annotation, Project, ViewState } from '../model/types';
import { useStore } from '../model/store';
import { NumberField, SelectField, TextField } from '../ui/controls';
import { Icon } from '../ui/icons';
import { LAYER_KEYS, LAYER_LABEL, findAnnotation, findRoom, type LayerKey, type LayerMode, type Layers } from '../model/layers';
import { HABITABLE_USES, MIN_LIGHT_RATIO, MIN_ROOM_HEIGHT, ROOM_USES, isHabitable, roomInfo } from '../model/rooms';
import { VIEW_STATE_LABEL } from '../model/states';

const fmt = (v: number, d = 2) => v.toFixed(d).replace('.', ',');

const NEXT_MODE: Record<LayerMode, LayerMode> = { visibile: 'bloccato', bloccato: 'nascosto', nascosto: 'visibile' };
const MODE_HINT: Record<LayerMode, string> = {
  visibile: 'Visibile e modificabile',
  bloccato: 'Bloccato: si vede e ci si aggancia, ma non si seleziona',
  nascosto: 'Nascosto',
};

/** Pannello «Vista»: stato rappresentato, categorie visibili/bloccate/nascoste, quote nascoste */
export function LayersPanel({
  layers,
  onLayers,
  state,
  onState,
  hiddenDims,
  onShowDims,
  onClose,
}: {
  layers: Layers;
  onLayers: (l: Layers) => void;
  state: ViewState;
  onState: (s: ViewState) => void;
  hiddenDims: number;
  onShowDims: () => void;
  onClose: () => void;
}) {
  return (
    <div className="layers-panel" data-hud>
      <div className="layers-head">
        <b>Vista</b>
        <button className="link" onClick={onClose}>
          Chiudi
        </button>
      </div>
      <SelectField
        label="Stato"
        value={state}
        options={(Object.keys(VIEW_STATE_LABEL) as ViewState[]).map((v) => ({ value: v, label: VIEW_STATE_LABEL[v] }))}
        onChange={onState}
      />
      <div className="layers-list">
        {LAYER_KEYS.map((k: LayerKey) => (
          <div key={k} className={`layer-row layer-${layers[k]}`}>
            <span>{LAYER_LABEL[k]}</span>
            <button className="chip" title={`${MODE_HINT[layers[k]]} · clic per cambiare`} onClick={() => onLayers({ ...layers, [k]: k === 'quote' && layers[k] === 'visibile' ? 'nascosto' : NEXT_MODE[layers[k]] })}>
              {layers[k]}
            </button>
          </div>
        ))}
      </div>
      {hiddenDims > 0 && (
        <button className="btn" onClick={onShowDims}>
          Ripristina {hiddenDims} {hiddenDims === 1 ? 'catena di quote nascosta' : 'catene di quote nascoste'}
        </button>
      )}
      <p className="note">Alt+clic su una quota la nasconde. Le categorie bloccate restano agganciabili.</p>
    </div>
  );
}

export interface MenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}

/** Menu contestuale (clic destro) */
export function ContextMenu({ x, y, title, items, onClose }: { x: number; y: number; title?: ReactNode; items: MenuItem[]; onClose: () => void }) {
  return (
    <div className="ctx-menu" data-hud style={{ left: x, top: y }} onPointerDown={(e) => e.stopPropagation()}>
      {title && <div className="ctx-title">{title}</div>}
      {items.map((it) => (
        <button
          key={it.label}
          className={`ctx-item ${it.danger ? 'ctx-danger' : ''}`}
          disabled={it.disabled}
          onClick={() => {
            onClose();
            it.onClick();
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

export function RoomInspector({ id }: { id: string }) {
  const project = useStore((s) => s.project);
  const edit = useStore((s) => s.edit);
  const select = useStore((s) => s.select);
  const room = findRoom(project, id);
  if (!room) return null;
  const info = roomInfo(project, room);
  const upd = (fn: (r: NonNullable<Project['rooms']>[number]) => void) =>
    edit((d) => {
      const r = findRoom(d, id);
      if (r) fn(r);
    });
  const habitable = isHabitable(room);
  const lightOk = info.ratio >= MIN_LIGHT_RATIO - 1e-4;
  const heightOk = info.height >= MIN_ROOM_HEIGHT - 1e-4;
  return (
    <div className="inspector">
      <div className="insp-kicker">Locale</div>
      <h2 className="insp-title">{room.name}</h2>
      <TextField label="Nome" value={room.name} onChange={(v) => upd((r) => (r.name = v.trim() || r.name))} wide />
      <SelectField label="Destinazione" value={room.use} options={[...new Set([...ROOM_USES, room.use])].map((u) => ({ value: u, label: u }))} onChange={(v) => upd((r) => (r.use = v))} />
      {info.shape ? (
        <div className="kv-grid">
          <div><span>Superficie netta</span><b className="mono">{fmt(info.area)} m²</b></div>
          <div><span>Perimetro</span><b className="mono">{fmt(info.perimeter)} m</b></div>
          <div><span>Altezza netta</span><b className={`mono ${habitable && !heightOk ? 'warn' : ''}`}>{fmt(info.height)} m</b></div>
          <div><span>Volume</span><b className="mono">{fmt(info.area * info.height)} m³</b></div>
          <div><span>Finestre</span><b className="mono">{fmt(info.windowArea)} m²</b></div>
          <div>
            <span>Rapporto aeroilluminante</span>
            <b className={`mono ${habitable && !lightOk ? 'warn' : ''}`}>{info.ratio > 0 ? `1/${fmt(1 / info.ratio, 1)}` : '—'}</b>
          </div>
        </div>
      ) : (
        <p className="note warn">I muri attorno al punto del locale non chiudono un vano: sposta l’etichetta dentro un vano chiuso o completa i muri.</p>
      )}
      {info.shape && habitable && (
        <p className={`note ${lightOk && heightOk ? '' : 'warn'}`}>
          {lightOk && heightOk
            ? 'Rapporto aeroilluminante (minimo 1/8) e altezza (minimo 2,70 m) verificati.'
            : `${lightOk ? '' : 'Rapporto aeroilluminante sotto 1/8. '}${heightOk ? '' : 'Altezza sotto 2,70 m.'}`}
        </p>
      )}
      {info.shape && !habitable && <p className="note">Per «{room.use}» non si verificano rapporto aeroilluminante e altezza minima (valgono per {HABITABLE_USES.join(', ').toLowerCase()}).</p>}
      <p className="note">Il contorno segue i muri: la superficie si aggiorna quando li sposti. Trascina l’etichetta per riposizionarla.</p>
      <div className="insp-actions">
        <button
          className="btn btn-danger"
          onClick={() => {
            edit((d) => void (d.rooms = (d.rooms ?? []).filter((r) => r.id !== id)));
            select('modello', []);
          }}
        >
          <Icon name="trash" size={14} /> Elimina locale
        </button>
      </div>
    </div>
  );
}

const ANNOTATION_NAME: Record<Annotation['kind'], string> = { quota: 'Quota', testo: 'Testo', altimetrica: 'Quota altimetrica' };

export function AnnotationInspector({ id }: { id: string }) {
  const project = useStore((s) => s.project);
  const edit = useStore((s) => s.edit);
  const select = useStore((s) => s.select);
  const n = findAnnotation(project, id);
  if (!n) return null;
  const upd = (fn: (x: Annotation) => void) =>
    edit((d) => {
      const x = findAnnotation(d, id);
      if (x) fn(x);
    });
  return (
    <div className="inspector">
      <div className="insp-kicker">Annotazione</div>
      <h2 className="insp-title">{ANNOTATION_NAME[n.kind]}</h2>
      {n.kind === 'quota' && (
        <>
          <NumberField label="Distanza della linea" unit="m" value={n.offset} step={0.1} onChange={(v) => upd((x) => x.kind === 'quota' && (x.offset = v))} />
          <div className="kv-grid">
            <div><span>Misura</span><b className="mono">{fmt(Math.hypot(n.b.x - n.a.x, n.b.y - n.a.y))} m</b></div>
          </div>
          <p className="note">La quota misura la distanza tra i due punti cliccati: non segue gli elementi se li sposti.</p>
        </>
      )}
      {n.kind === 'testo' && (
        <>
          <label className="field field-wide">
            <span className="field-label">Testo</span>
            <span className="field-input">
              <textarea
                key={n.id}
                rows={4}
                defaultValue={n.text}
                onBlur={(e) => e.target.value !== n.text && upd((x) => x.kind === 'testo' && (x.text = e.target.value))}
              />
            </span>
          </label>
          {n.leader && (
            <button className="btn" onClick={() => upd((x) => x.kind === 'testo' && delete x.leader)}>
              Togli la linea di richiamo
            </button>
          )}
        </>
      )}
      {n.kind === 'altimetrica' && (
        <>
          <NumberField label="Dislivello dal piano" unit="m" value={n.dz} step={0.01} onChange={(v) => upd((x) => x.kind === 'altimetrica' && (x.dz = v))} />
          <p className="note">Mostra la quota del piano finito del livello più il dislivello indicato.</p>
        </>
      )}
      <div className="insp-actions">
        <button
          className="btn btn-danger"
          onClick={() => {
            edit((d) => void (d.annotations = (d.annotations ?? []).filter((x) => x.id !== id)));
            select('modello', []);
          }}
        >
          <Icon name="trash" size={14} /> Elimina annotazione
        </button>
      </div>
    </div>
  );
}
