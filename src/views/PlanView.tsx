// Pianta di un livello generata dal modello.
// Usata sia dall'editor (fase 02) sia dai fogli di stampa (fase 03): stesso disegno, stessi dati.
// Coordinate in metri; l'asse Y del modello è ribaltato per l'SVG.

import type { Opening, OpeningType, Project, Stair, Vec2, Wall } from '../model/types';
import { SectionMark } from './SectionView';
import { RoofSymbols } from './SiteView';
import { HatchDefs, hatchFill, hatchOf, mainHatch, structHatch, useHatchPrefix } from './hatch';
import { computeDimensions, segmentEdit, type DimChain } from '../model/dimensions';
import { fixtureSpec, leafSpans } from '../model/openings';
import { bandPolygon, endAt, layerBands, levelCenter, startAt, wallGeom, wallOutline, wallPieces, type WallGeom } from '../model/walls';
import {
  add,
  roofBase,
  roofOutline,
  roofEave,
  roofWithEave,
  slabOutline,
  slabHoles,
  bbox,
  byId,
  centroid,
  columnQuad,
  dist,
  levelAbove,
  projectOnSegment,
  dot,
  sortedLevels,
  stairLayout,
  stairFootprints,
  flightQuad,
  mul,
  norm,
  openingSpans,
  sub,
  wallLength,
  wallSegmentQuad,
  wallThickness,
} from '../model/geometry';

export const Y = (p: Vec2) => -p.y;
export const pts = (list: Vec2[]) => list.map((p) => `${p.x},${-p.y}`).join(' ');

interface Props {
  project: Project;
  levelId: string;
  /** Metri corrispondenti a 1 mm di carta (o all'equivalente a schermo) */
  mm: number;
  showDimensions?: boolean;
  showLabels?: boolean;
  selectedIds?: string[];
  ghostLevelId?: string;
  /** Ingrandimento dei testi a schermo (1 = dimensione di stampa) */
  textScale?: number;
  /** Quote modificabili: clic su una cifra */
  onDimEdit?: (t: DimTarget) => void;
  activeDim?: string;
}

export function PlanView({ project: p, levelId, mm, showDimensions, showLabels, selectedIds = [], ghostLevelId, textScale = 1, onDimEdit, activeDim }: Props) {
  const ts = textScale;
  const els = p.elements;
  const onLevel = <T extends { levelId: string }>(e: T) => e.levelId === levelId;
  const walls = els.filter((e): e is Wall => e.kind === 'wall' && onLevel(e));
  const slabs = els.filter((e) => e.kind === 'slab' && onLevel(e));
  const columns = els.filter((e) => e.kind === 'column' && onLevel(e));
  const beams = els.filter((e) => e.kind === 'beam' && onLevel(e));
  const stairs = els.filter((e) => e.kind === 'stair' && onLevel(e));
  // scale che salgono dal livello sottostante e arrivano qui
  const below = sortedLevels(p).filter((l) => l.elevation < (byId(p.levels, levelId)?.elevation ?? 0) - 1e-6).pop();
  const arriving =
    below && byId(p.levels, levelId)?.kind !== 'copertura' ? els.filter((e) => e.kind === 'stair' && e.levelId === below.id) : [];
  const lvlRoof = byId(p.levels, levelId);
  // sul livello delle coperture compaiono anche i tetti impostati alla sua quota ma assegnati al piano sotto
  const roofs = els.filter(
    (e) =>
      e.kind === 'roof' &&
      (onLevel(e) || (lvlRoof?.kind === 'copertura' && Math.abs(roofBase(p, e) - lvlRoof.elevation) < 0.01)),
  );
  const sel = new Set(selectedIds);
  const lvl = byId(p.levels, levelId);
  const center = levelCenter(p, levelId);

  const thin = 0.13 * mm;
  const med = 0.25 * mm;
  const hp = useHatchPrefix();

  return (
    <g className="plan">
      <HatchDefs prefix={hp} u={mm} />
      {ghostLevelId && lvl?.kind !== 'copertura' && <GhostWalls project={p} levelId={ghostLevelId} mm={mm} />}

      {/* pilastri e travi del piano sottostante: in vista dove nessun solaio li copre,
          tratteggiati sotto il solaio quando è attivo il sottostante */}
      {lvl?.kind !== 'copertura' && below && <BelowStructure project={p} levelId={levelId} belowId={below.id} mm={mm} hp={hp} showHidden={!!ghostLevelId} />}

      {/* solai del piano superiore (balconi, pensiline): tratteggiati, sotto i muri */}
      {lvl?.kind !== 'copertura' &&
        (() => {
          const up = levelAbove(p, levelId);
          if (!up || up.kind === 'copertura') return null;
          return els
            .filter((e) => e.kind === 'slab' && e.levelId === up.id)
            .map((e) => e.kind === 'slab' && <polygon key={`up${e.id}`} points={pts(slabOutline(p, e))} className="pv-slab-above" strokeWidth={0.18 * mm} strokeDasharray={`${2.5 * mm} ${1.2 * mm}`} />);
        })()}

      {slabs.map(
        (s) =>
          s.kind === 'slab' && (
            <path
              key={s.id}
              d={[slabOutline(p, s), ...slabHoles(p, s)].map((r) => `M${pts(r).replace(/ /g, ' L')} Z`).join(' ')}
              fillRule="evenodd"
              className="pv-slab"
              strokeWidth={thin}
            />
          ),
      )}

      {lvl?.kind === 'copertura' ? (
        // livello delle coperture: piano delle coperture completo
        <>
          <RoofSymbols project={p} roofs={roofs} mm={mm} ts={ts} showLabels />
          {/* muri del piano sottostante come linee nascoste */}
          {ghostLevelId && <GhostWalls project={p} levelId={ghostLevelId} mm={mm} />}
        </>
      ) : (
        roofs.map((r) => {
        if (r.kind !== 'roof') return null;
        const b = bbox(r.points);
        const o = roofEave(p, r);
        const outline = roofOutline(roofWithEave(p, r));
        const alongX = b.w >= b.h;
        return (
          <g key={r.id} className="pv-roof" strokeWidth={med} strokeDasharray={`${3 * mm} ${1.5 * mm}`}>
            <polygon points={pts(outline)} />
            {r.shape === 'falde' &&
              (alongX ? (
                <line x1={b.minX - o} y1={-(b.minY + b.h / 2)} x2={b.maxX + o} y2={-(b.minY + b.h / 2)} />
              ) : (
                <line x1={b.minX + b.w / 2} y1={-(b.minY - o)} x2={b.minX + b.w / 2} y2={-(b.maxY + o)} />
              ))}
          </g>
        );
        })
      )}

      {stairs.map((s) => s.kind === 'stair' && <StairPlan key={s.id} project={p} stair={s} mode="partenza" mm={mm} />)}
      {arriving.map((s) => s.kind === 'stair' && <StairPlan key={`arr${s.id}`} project={p} stair={s} mode="arrivo" mm={mm} />)}
      {/* bordi dei fori scala: linea continua del solaio tagliato */}
      {slabs.flatMap((s) =>
        s.kind === 'slab' ? slabHoles(p, s).map((h, i) => <polygon key={`hole${s.id}${i}`} points={pts(h)} className="pv-slab-hole" strokeWidth={med} />) : [],
      )}

      {walls.map((w) => (
        <WallPlan key={w.id} project={p} wall={w} mm={mm} center={center} hp={hp} />
      ))}

      {columns.map((c) => {
        if (c.kind !== 'column') return null;
        return (
          <polygon
            key={c.id}
            points={pts(columnQuad(c, byId(p.catalog.column, c.typeId)))}
            className="pv-column"
            style={mm > 0.25 ? undefined : { fill: hatchFill(hp, structHatch(byId(p.catalog.column, c.typeId))) }}
            strokeWidth={0.35 * mm}
          />
        );
      })}

      {/* pilastri annegati nei muri: le finiture del muro passano davanti al pilastro */}
      {mm < 0.08 &&
        walls.map((w) => <WallCoversOverColumns key={`wc${w.id}`} project={p} wall={w} columns={columns} mm={mm} center={center} hp={hp} />)}

      {beams.map((b) => {
        if (b.kind !== 'beam') return null;
        const t = byId(p.catalog.beam, b.typeId);
        const q = wallSegmentQuad({ ...b, kind: 'wall', typeId: '', levelId: '' } as Wall, t?.width ?? 0.3, 0, dist(b.a, b.b));
        return (
          <polygon
            key={b.id}
            points={pts(q)}
            className="pv-beam"
            strokeWidth={med}
            strokeDasharray={`${2 * mm} ${1 * mm}`}
          />
        );
      })}

      {showDimensions && <DimChains project={p} levelId={levelId} mm={mm} ts={ts} onEdit={onDimEdit} activeKey={activeDim} />}

      {showLabels &&
        walls.map((w) => {
          const c = centroid([w.a, w.b]);
          const t = byId(p.catalog.wall, w.typeId);
          return (
            <text
              key={`l${w.id}`}
              x={c.x}
              y={-c.y - wallThickness(t) / 2 - 1.2 * mm}
              className="pv-label"
              fontSize={2 * mm * ts}
              textAnchor="middle"
            >
              {wallLength(w).toFixed(2)}
            </text>
          );
        })}

      {/* Tracce di sezione */}
      {(p.sections ?? []).map((sec) => (
        <SectionMark key={sec.id} section={sec} mm={mm} ts={ts} selected={sel.has(sec.id)} />
      ))}

      {/* Evidenziazione selezione */}
      {els
        .filter((e) => sel.has(e.id))
        .map((e) => (
          <SelectionOutline key={`sel${e.id}`} project={p} id={e.id} mm={mm} levelId={levelId} />
        ))}
      <defs>
        <marker id="pv-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="pv-arrowhead" />
        </marker>
      </defs>
    </g>
  );
}

/** Pilastri e travi del livello sottostante visti dall'alto, mascherati dai solai di questo livello */
function BelowStructure({ project: p, levelId, belowId, mm, hp, showHidden }: { project: Project; levelId: string; belowId: string; mm: number; hp: string; showHidden: boolean }) {
  const quads: Vec2[][] = [];
  for (const e of p.elements) {
    if (!('levelId' in e) || e.levelId !== belowId) continue;
    if (e.kind === 'column') quads.push(columnQuad(e, byId(p.catalog.column, e.typeId)));
    else if (e.kind === 'beam') quads.push(wallSegmentQuad(e as unknown as Wall, byId(p.catalog.beam, e.typeId)?.width ?? 0.3, 0, dist(e.a, e.b)));
  }
  if (!quads.length) return null;
  const slabs = p.elements.filter((e) => e.kind === 'slab' && e.levelId === levelId);
  const path = (r: Vec2[]) => `M${pts(r).replace(/ /g, ' L')} Z`;
  const covered = slabs.map((s) => (s.kind === 'slab' ? [slabOutline(p, s), ...slabHoles(p, s)].map(path).join(' ') : '')).join(' ');
  const all = quads.flat();
  const bb = bbox(all);
  const big = { x: bb.minX - 5, y: -(bb.maxY + 5), w: bb.w + 10, h: bb.h + 10 };
  const vis = `${hp}-below-vis`;
  const hid = `${hp}-below-hid`;
  return (
    <g className="pv-below">
      <defs>
        {/* visibile: fuori dai solai (e nei fori scala) */}
        <mask id={vis} maskUnits="userSpaceOnUse" x={big.x} y={big.y} width={big.w} height={big.h}>
          <rect x={big.x} y={big.y} width={big.w} height={big.h} fill="#fff" />
          {covered && <path d={covered} fillRule="evenodd" fill="#000" />}
        </mask>
        <mask id={hid} maskUnits="userSpaceOnUse" x={big.x} y={big.y} width={big.w} height={big.h}>
          {covered && <path d={covered} fillRule="evenodd" fill="#fff" />}
        </mask>
      </defs>
      <g mask={`url(#${vis})`}>
        {quads.map((q, i) => (
          <polygon key={`v${i}`} points={pts(q)} className="pv-below-line" strokeWidth={0.18 * mm} />
        ))}
      </g>
      {showHidden && (
        <g mask={`url(#${hid})`}>
          {quads.map((q, i) => (
            <polygon key={`h${i}`} points={pts(q)} className="pv-below-line" strokeWidth={0.15 * mm} strokeDasharray={`${1.5 * mm} ${1 * mm}`} />
          ))}
        </g>
      )}
    </g>
  );
}

/** Altezza del piano di taglio della pianta */
export const PLAN_CUT = 1.2;

/**
 * Scala in pianta secondo la convenzione: al piano di partenza è continua fino al piano di taglio,
 * poi linea di interruzione obliqua e tratteggio; al piano di arrivo il contrario.
 */
function StairPlan({ project: p, stair: s, mode, mm }: { project: Project; stair: Stair; mode: 'partenza' | 'arrivo'; mm: number }) {
  const lvl = byId(p.levels, s.levelId);
  const next = levelAbove(p, s.levelId);
  if (!lvl || dist(s.a, s.b) < 1e-6) return null;
  const lay = stairLayout(p, s);
  const { h, tread, n, width: W } = lay;
  const hasBreak = !!next && lay.rise > PLAN_CUT;
  if (!hasBreak && mode === 'arrivo') return null;
  const solidLow = mode === 'partenza';
  const thin = 0.13 * mm;
  const med = 0.25 * mm;
  const dash = `${1.6 * mm} ${1 * mm}`;
  const seg = (a: Vec2, b: Vec2, solid: boolean, key: string, w = thin) => (
    <line key={key} x1={a.x} y1={-a.y} x2={b.x} y2={-b.y} strokeWidth={w} strokeDasharray={solid ? undefined : dash} />
  );
  // gradino tagliato dal piano di taglio; se cade sul pianerottolo si sposta alla rampa successiva
  let c = Math.min(n - 1, Math.max(1, Math.ceil(PLAN_CUT / h)));
  let fi = lay.flights.findIndex((f) => c >= f.first && c < f.first + f.steps);
  if (fi < 0) {
    fi = lay.flights.findIndex((f) => f.first > c);
    if (fi >= 0) c = lay.flights[fi].first + Math.min(1, lay.flights[fi].steps - 1);
  }
  const vis = (low: boolean) => (low ? solidLow : !solidLow);
  const out: React.ReactNode[] = [];
  // fondo bianco per coprire il pavimento
  for (const [k, q] of [...lay.flights.map((f) => flightQuad(f, W)), ...lay.landings.map((l) => l.poly)].entries())
    out.push(<polygon key={`bg${k}`} points={pts(q)} stroke="none" />);
  let breakPt: Vec2 | null = null;
  lay.flights.forEach((f, k) => {
    const P = (along: number, u: number) => add(add(f.a, mul(f.d, along)), mul(f.n, W / 2 - u * W)); // u: 0 lato sinistro, 1 lato destro
    const split = hasBreak && k === fi;
    if (!split) {
      const low = !hasBreak || f.first + f.steps <= c;
      const sol = !hasBreak || vis(low);
      out.push(seg(P(0, 0), P(f.len, 0), sol, `f${k}s0`), seg(P(0, 1), P(f.len, 1), sol, `f${k}s1`));
      out.push(seg(P(0, 0), P(0, 1), sol, `f${k}a`), seg(P(f.len, 0), P(f.len, 1), sol, `f${k}b`));
      for (let j = 1; j < f.steps; j++) out.push(seg(P(j * tread, 0), P(j * tread, 1), sol, `f${k}t${j}`));
      return;
    }
    const sc = (c - f.first) * tread;
    const span = Math.min(0.35 * W, sc, f.len - sc);
    const sb = (u: number) => sc - span + 2 * span * u;
    for (let j = 1; j < f.steps; j++) {
      const si = j * tread;
      const uc = Math.min(1, Math.max(0, (si - sc + span) / (2 * span || 1)));
      if (uc > 0) out.push(seg(P(si, 0), P(si, uc), vis(false), `f${k}tu${j}`));
      if (uc < 1) out.push(seg(P(si, uc), P(si, 1), vis(true), `f${k}tl${j}`));
    }
    out.push(seg(P(0, 0), P(sb(0), 0), vis(true), `f${k}0l`), seg(P(sb(0), 0), P(f.len, 0), vis(false), `f${k}0u`));
    out.push(seg(P(0, 1), P(sb(1), 1), vis(true), `f${k}1l`), seg(P(sb(1), 1), P(f.len, 1), vis(false), `f${k}1u`));
    out.push(seg(P(0, 0), P(0, 1), vis(true), `f${k}start`), seg(P(f.len, 0), P(f.len, 1), vis(false), `f${k}end`));
    out.push(seg(P(sb(0), 0), P(sb(1), 1), true, `f${k}brk`, med));
    breakPt = P(sc, 0.5);
  });
  lay.landings.forEach((l, k) => {
    const sol = !hasBreak || vis(l.step < c);
    l.poly.forEach((q, i) => out.push(seg(q, l.poly[(i + 1) % l.poly.length], sol, `l${k}e${i}`)));
  });
  // freccia di salita lungo l'asse, nel tratto visibile
  const ax = lay.axis;
  const d0 = norm(sub(ax[1], ax[0]));
  const dn = norm(sub(ax[ax.length - 1], ax[ax.length - 2]));
  const start = add(ax[0], mul(d0, tread * 0.4));
  const end = sub(ax[ax.length - 1], mul(dn, tread * 0.4));
  const path = [start, ...ax.slice(1, -1), end];
  let arrow = path;
  if (hasBreak && breakPt) {
    const bp: Vec2 = breakPt;
    // la rampa tagliata è la prima (primo tratto dell'asse) o l'ultima (ultimo tratto)
    if (fi === 0) arrow = mode === 'partenza' ? [start, bp] : [bp, ...path.slice(1)];
    else arrow = mode === 'partenza' ? [...path.slice(0, -1), bp] : [bp, end];
  }
  return (
    <g className="pv-stair">
      {out}
      <polyline points={pts(arrow)} strokeWidth={med} markerEnd="url(#pv-arrow)" />
      {mode === 'partenza' && <circle cx={arrow[0].x} cy={-arrow[0].y} r={0.6 * mm} className="pv-stair-dot" />}
    </g>
  );
}

function WallPlan({ project: p, wall: w, mm, center, hp }: { project: Project; wall: Wall; mm: number; center: Vec2; hp: string }) {
  const t = byId(p.catalog.wall, w.typeId);
  const g = wallGeom(p, w, center);
  const spans = openingSpans(p, w);
  const pieces = wallPieces(g, spans);
  const isLayered = mm < 0.08 && t && t.layers.length > 1; // a scala ≥ 1:50 si vedono gli strati
  const bands = t ? layerBands(g, t.layers) : [];
  const isFinish = (j: number) => (t ? !inCore(t.layers, j) : false);
  const lw = 0.35 * mm;
  const at = (sv: number, o: number) => add(add(w.a, mul(g.d, sv)), mul(g.n, o));
  // angoli tra muri: nuclei con nuclei, rivestimenti che girano l'angolo (stesso risultato se il tipo è uguale)
  const cutA = g.a.kind === 'angolo' ? cornerCut(p, w, g, 'a', center) : null;
  const cutB = g.b.kind === 'angolo' ? cornerCut(p, w, g, 'b', center) : null;
  const sA = (sv: number | 'inizio', o: number) => (sv === 'inizio' ? (cutA ? cutA(o) : startAt(g, o)) : sv);
  const sB = (sv: number | 'fine', o: number) => (sv === 'fine' ? (cutB ? cutB(o) : endAt(g, o)) : sv);
  // innesti a T su questo muro: la faccia si interrompe su tutto il tramezzo, le finiture sulla sua struttura
  const tJ = tJunctions(p, w, g, center);
  // estremi a T di questo muro: la struttura attraversa la finitura del muro ospite
  const extA = g.a.kind === 'T' ? hostFinishDepth(p, g, 'a', center) : 0;
  const extB = g.b.kind === 'T' ? hostFinishDepth(p, g, 'b', center) : 0;

  const cut = (a: number, b: number, gaps: { s0: number; s1: number }[]) => {
    let segs: [number, number][] = [[Math.min(a, b), Math.max(a, b)]];
    for (const gap of gaps)
      segs = segs.flatMap(([x, y]) => (gap.s1 <= x || gap.s0 >= y ? [[x, y] as [number, number]] : ([[x, gap.s0], [gap.s1, y]] as [number, number][]).filter(([u, v]) => v - u > 1e-4)));
    return segs;
  };
  const line = (P: Vec2, Q: Vec2, key: string, cls: string, width: number, cap?: 'square') => (
    <line key={key} x1={P.x} y1={-P.y} x2={Q.x} y2={-Q.y} className={cls} strokeWidth={width} strokeLinecap={cap} />
  );
  // sta lo scostamento o nella zona delle finiture del lato σ (tra la faccia e la struttura)?
  const inFinishZone = (o: number, side: number) => {
    const d = finishDepthOn(p, w, g, side);
    return d > 0 && side * o > g.half - d - 1e-6;
  };
  const faceGaps = (side: number) => tJ.filter((j) => j.side === side).map((j) => ({ s0: j.s0, s1: j.s1 }));
  const coreGaps = (side: number) => tJ.filter((j) => j.side === side).map((j) => ({ s0: j.c0, s1: j.c1 }));

  // linee di contorno di un tratto: facce, estremi liberi e spalle delle aperture (non i giunti)
  const edges = (s0: number | 'inizio', s1: number | 'fine', key: string) => {
    const out: React.ReactNode[] = [];
    for (const o of [g.half, -g.half])
      cut(sA(s0, o), sB(s1, o), faceGaps(Math.sign(o))).forEach(([x, y], k) => out.push(line(at(x, o), at(y, o), `${key}f${o > 0 ? 'p' : 'm'}${k}`, 'pv-wall-line', lw)));
    if (s0 !== 'inizio' || g.a.kind === 'libero') out.push(line(at(sA(s0, g.half), g.half), at(sA(s0, -g.half), -g.half), `${key}e0`, 'pv-wall-line', lw, 'square'));
    if (s1 !== 'fine' || g.b.kind === 'libero') out.push(line(at(sB(s1, g.half), g.half), at(sB(s1, -g.half), -g.half), `${key}e1`, 'pv-wall-line', lw, 'square'));
    return out;
  };

  return (
    <g>
      {pieces.map(({ s0, s1 }, i) => {
        if (mm > 0.25 || !t) return <polygon key={i} points={pts(bandPolygon(g, g.half, -g.half, s0, s1))} className="pv-wall" />;
        if (isLayered) {
          const eA = s0 === 'inizio' ? extA : 0;
          const eB = s1 === 'fine' ? extB : 0;
          const out: React.ReactNode[] = [];
          bands.forEach((band, j) => {
            const fill = hatchFill(hp, hatchOf(t.layers[j]));
            const core = !isFinish(j);
            // struttura: prosegue nella finitura del muro ospite; finitura: si ferma alla faccia
            const xa = (o: number) => sA(s0, o) - (core ? eA : 0);
            const xb = (o: number) => sB(s1, o) + (core ? eB : 0);
            // finiture di questo muro: interrotte dove entra la struttura di un tramezzo
            const mid = (band.o0 + band.o1) / 2;
            const side = Math.sign(mid);
            const gaps = !core && inFinishZone(mid, side) ? coreGaps(side) : [];
            const lo = Math.min(xa(band.o0), xa(band.o1));
            const hi = Math.max(xb(band.o0), xb(band.o1));
            const segs = gaps.length ? cut(lo, hi, gaps) : [[lo, hi] as [number, number]];
            segs.forEach(([x, y], k) => {
              const poly = [
                at(Math.max(x, xa(band.o0)), band.o0),
                at(Math.min(y, xb(band.o0)), band.o0),
                at(Math.min(y, xb(band.o1)), band.o1),
                at(Math.max(x, xa(band.o1)), band.o1),
              ];
              out.push(<polygon key={`b${j}-${k}`} points={pts(poly)} fill={fill} stroke={fill} strokeWidth={0.06 * mm} />);
            });
          });
          // separazioni tra gli strati: girano gli angoli; quelle della struttura entrano nel muro ospite
          bands.slice(0, -1).forEach((band, j) => {
            const o = band.o1;
            const touchesCore = !isFinish(j) || !isFinish(j + 1);
            const a = sA(s0, o) - (touchesCore ? (s0 === 'inizio' ? extA : 0) : 0);
            const b = sB(s1, o) + (touchesCore ? (s1 === 'fine' ? extB : 0) : 0);
            const side = Math.sign(o);
            const gaps = inFinishZone(o, side) ? coreGaps(side) : [];
            cut(a, b, gaps).forEach(([x, y], k) => out.push(line(at(x, o), at(y, o), `l${j}-${k}`, 'pv-layer-line', 0.1 * mm)));
          });
          // fianchi della struttura dentro la finitura del muro ospite
          if (eA > 0 || eB > 0) {
            const coreIdx = bands.map((_, j) => j).filter((j) => !isFinish(j));
            if (coreIdx.length) {
              const os = coreIdx.flatMap((j) => [bands[j].o0, bands[j].o1]);
              for (const o of [Math.max(...os), Math.min(...os)]) {
                if (eA > 0) out.push(line(at(sA(s0, o) - eA, o), at(sA(s0, o), o), `ca${o}`, 'pv-layer-line', 0.1 * mm));
                if (eB > 0) out.push(line(at(sB(s1, o), o), at(sB(s1, o) + eB, o), `cb${o}`, 'pv-layer-line', 0.1 * mm));
              }
            }
          }
          out.push(...edges(s0, s1, `e${i}`));
          return <g key={i}>{out}</g>;
        }
        // scale piccole: retino dello strato portante su tutto lo spessore
        const fill = hatchFill(hp, mainHatch(t.layers));
        return (
          <g key={i}>
            <polygon points={pts(bandPolygon(g, g.half, -g.half, s0, s1))} fill={fill} stroke={fill} strokeWidth={0.06 * mm} />
            {edges(s0, s1, `e${i}`)}
          </g>
        );
      })}
      {spans.map(({ opening: o, type, start, end }) => (
        <OpeningPlan key={o.id} project={p} wall={w} g={g} opening={o} type={type} start={start} end={end} mm={mm} detail={mm < 0.08} />
      ))}
    </g>
  );
}

/**
 * Nucleo strutturale di una stratigrafia: dal primo all'ultimo strato «struttura» (comprese
 * intercapedini e strati intermedi). Fuori dal nucleo stanno i rivestimenti, posati dopo:
 * isolanti a cappotto e finiture, uno o più per lato. Senza strati strutturali tutto è nucleo.
 */
function inCore(layers: { role: string }[], j: number) {
  const first = layers.findIndex((l) => l.role === 'struttura');
  if (first < 0) return true;
  let last = first;
  layers.forEach((l, i) => l.role === 'struttura' && (last = i));
  return j >= first && j <= last;
}

/**
 * Zone di un muro misurate verso l'esterno dell'angolo (q = σ·o, σ = lato esterno):
 * [faccia esterna, faccia esterna del nucleo, faccia interna del nucleo, faccia interna].
 */
function cornerZones(p: Project, w: Wall, g: WallGeom, sOut: number): number[] {
  const t = byId(p.catalog.wall, w.typeId);
  const h = g.half;
  if (!t || t.layers.length < 2) return [h, h, -h, -h];
  const lb = layerBands(g, t.layers);
  const qs = lb.flatMap((b, j) => (inCore(t.layers, j) ? [sOut * b.o0, sOut * b.o1] : []));
  if (!qs.length) return [h, h, -h, -h];
  return [h, Math.max(...qs), Math.min(...qs), -h];
}

/**
 * Taglio d'angolo per strati: lo scostamento o del muro si accoppia a quello dell'altro muro nella
 * zona corrispondente (rivestimento esterno, nucleo, rivestimento interno, in proporzione); il taglio
 * è l'incrocio delle due rette. Restituisce s(o) lungo il muro, oppure null.
 */
function cornerCut(p: Project, w: Wall, g: WallGeom, end: 'a' | 'b', center: Vec2): ((o: number) => number) | null {
  const ec = end === 'a' ? g.a : g.b;
  const other = p.elements.find((e): e is Wall => e.kind === 'wall' && e.id === ec.otherId);
  if (!other) return null;
  const P = end === 'a' ? w.a : w.b;
  const go = wallGeom(p, other, center);
  const uA = end === 'a' ? g.d : mul(g.d, -1); // dal nodo dentro questo muro
  const atA = dist(other.a, P) < dist(other.b, P);
  const uB = atA ? go.d : mul(go.d, -1);
  if (Math.abs(g.d.x * go.d.y - g.d.y * go.d.x) < 0.05) return null; // quasi allineati
  const sOutA = dot(g.n, uB) < 0 ? 1 : -1;
  const sOutB = dot(go.n, uA) < 0 ? 1 : -1;
  const zA = cornerZones(p, w, g, sOutA);
  const zB = cornerZones(p, other, go, sOutB);
  const mapQ = (q: number) => {
    for (let i = 0; i < 3; i++) {
      const a0 = zA[i];
      const a1 = zA[i + 1];
      if (q <= a0 + 1e-9 && q >= a1 - 1e-9) {
        const t = Math.abs(a0 - a1) < 1e-9 ? 0 : (a0 - q) / (a0 - a1);
        return zB[i] + (zB[i + 1] - zB[i]) * t;
      }
    }
    return q > zA[0] ? zB[0] : zB[3];
  };
  return (o: number) => {
    const qB = mapQ(sOutA * o);
    const oB = sOutB * qB;
    // incrocio tra la retta a scostamento o di questo muro e quella a scostamento oB dell'altro
    const p0 = add(w.a, mul(g.n, o));
    const p1 = add(other.a, mul(go.n, oB));
    const den = g.d.x * go.d.y - g.d.y * go.d.x;
    const r = sub(p1, p0);
    const s = (r.x * go.d.y - r.y * go.d.x) / den;
    return s;
  };
}

/**
 * Rivestimenti di un muro (finiture, cappotto) davanti ai pilastri annegati: il pilastro interrompe
 * la struttura del muro, i rivestimenti gli passano davanti; dove il pilastro sporge dalla faccia
 * resta in vista il suo contorno.
 */
function WallCoversOverColumns({
  project: p,
  wall: w,
  columns,
  mm,
  center,
  hp,
}: {
  project: Project;
  wall: Wall;
  columns: Project['elements'];
  mm: number;
  center: Vec2;
  hp: string;
}) {
  const t = byId(p.catalog.wall, w.typeId);
  if (!t || t.layers.length < 2) return null;
  const g = wallGeom(p, w, center);
  const bands = layerBands(g, t.layers);
  const out: React.ReactNode[] = [];
  const at = (sv: number, o: number) => add(add(w.a, mul(g.d, sv)), mul(g.n, o));
  const spans = openingSpans(p, w);
  for (const c of columns) {
    if (c.kind !== 'column') continue;
    const q = columnQuad(c, byId(p.catalog.column, c.typeId));
    const ss = q.map((v) => dot(sub(v, w.a), g.d));
    const os = q.map((v) => dot(sub(v, w.a), g.n));
    const oMin = Math.min(...os);
    const oMax = Math.max(...os);
    const lo = Math.max(0, Math.min(...ss));
    const hi = Math.min(g.L, Math.max(...ss));
    if (hi - lo < 1e-3 || oMax < -g.half + 1e-3 || oMin > g.half - 1e-3) continue;
    const outPlus = oMax > g.half + 1e-3; // il pilastro sporge dalla faccia +n
    const outMinus = oMin < -g.half - 1e-3;
    const covered = (side: number) => (side > 0 ? !outPlus : !outMinus);
    // solo dove il muro è pieno (non nelle aperture)
    let segs: [number, number][] = [[lo, hi]];
    for (const sp of spans)
      segs = segs.flatMap(([x, y]) => (sp.end <= x || sp.start >= y ? [[x, y] as [number, number]] : ([[x, sp.start], [sp.end, y]] as [number, number][]).filter(([u, v]) => v - u > 1e-4)));
    segs.forEach(([s0, s1], si) => {
      const key = `${c.id}-${si}`;
      bands.forEach((b, j) => {
        if (inCore(t.layers, j) || !covered(Math.sign((b.o0 + b.o1) / 2))) return;
        const fill = hatchFill(hp, hatchOf(t.layers[j]));
        const poly = [at(s0, b.o0), at(s1, b.o0), at(s1, b.o1), at(s0, b.o1)];
        out.push(<polygon key={`${key}b${j}`} points={pts(poly)} fill={fill} stroke={fill} strokeWidth={0.06 * mm} />);
      });
      // linee tra gli strati e facce, dove il rivestimento copre il pilastro
      bands.slice(0, -1).forEach((b, j) => {
        const cover = !inCore(t.layers, j) || !inCore(t.layers, j + 1);
        if (!cover || !covered(Math.sign(b.o1))) return;
        const P = at(s0, b.o1);
        const Q = at(s1, b.o1);
        out.push(<line key={`${key}l${j}`} x1={P.x} y1={-P.y} x2={Q.x} y2={-Q.y} className="pv-layer-line" strokeWidth={0.1 * mm} />);
      });
      for (const o of [g.half, -g.half]) {
        if (!covered(Math.sign(o))) continue;
        const P = at(s0, o);
        const Q = at(s1, o);
        out.push(<line key={`${key}f${o}`} x1={P.x} y1={-P.y} x2={Q.x} y2={-Q.y} className="pv-wall-line" strokeWidth={0.35 * mm} />);
      }
    });
  }
  return out.length ? <g>{out}</g> : null;
}

/** Spessore dei rivestimenti (finiture e isolanti esterni al nucleo) sul lato σ di un muro (dalla faccia fino al primo strato non di finitura) */
function finishDepthOn(p: Project, w: Wall, g: WallGeom, side: number) {
  const t = byId(p.catalog.wall, w.typeId);
  if (!t) return 0;
  const bands = layerBands(g, t.layers).map((b, j) => ({ ...b, j }));
  // dalla faccia σ verso l'interno
  const outer = (x: { o0: number; o1: number }) => Math.max(side * x.o0, side * x.o1);
  bands.sort((x, y) => outer(y) - outer(x));
  let d = 0;
  for (const b of bands) {
    if (inCore(t.layers, b.j)) break;
    d += Math.abs(b.o0 - b.o1);
  }
  return d;
}

/** Quanto la struttura di un muro innestato a T entra nella finitura del muro ospite, lungo il suo asse */
function hostFinishDepth(p: Project, g: WallGeom, end: 'a' | 'b', center: Vec2) {
  const cutEnd = end === 'a' ? g.a : g.b;
  const host = p.elements.find((e): e is Wall => e.kind === 'wall' && e.id === cutEnd.otherId);
  if (!host) return 0;
  const gh = wallGeom(p, host, center);
  const into = end === 'a' ? g.d : mul(g.d, -1); // dal giunto verso il muro innestato
  const c = dot(into, gh.n);
  if (Math.abs(c) < 0.2) return 0;
  return finishDepthOn(p, host, gh, Math.sign(c)) / Math.abs(c);
}

/**
 * Innesti a T sul muro: per ciascuno il lato σ, l'intervallo dell'intero tramezzo [s0, s1] e quello
 * della sua parte strutturale [c0, c1] lungo il muro.
 */
function tJunctions(p: Project, w: Wall, g: WallGeom, center: Vec2) {
  const out: { side: number; s0: number; s1: number; c0: number; c1: number }[] = [];
  for (const o of p.elements) {
    if (o.kind !== 'wall' || o.id === w.id || o.levelId !== w.levelId) continue;
    for (const [P, Q] of [
      [o.a, o.b],
      [o.b, o.a],
    ] as const) {
      const pr = projectOnSegment(P, w.a, w.b);
      if (pr.d > 0.02 || pr.t <= 1e-3 || pr.t >= 1 - 1e-3) continue;
      const dO = norm(sub(Q, P));
      const c = dot(dO, g.n);
      const side = Math.sign(c);
      if (!side || Math.abs(c) < 0.2) continue;
      const go = wallGeom(p, o, center);
      const to = byId(p.catalog.wall, o.typeId);
      const sc = pr.t * g.L;
      // scostamento o del tramezzo → ascissa lungo questo muro
      const k = dot(go.n, g.d) / Math.abs(c);
      const sOf = (off: number) => sc + off * k;
      const ends = [sOf(go.half), sOf(-go.half)];
      let core = ends;
      if (to && to.layers.length > 1) {
        const lb = layerBands(go, to.layers);
        const os = lb.flatMap((b, j) => (inCore(to.layers, j) ? [b.o0, b.o1] : []));
        if (os.length) core = [sOf(Math.max(...os)), sOf(Math.min(...os))];
      }
      out.push({ side, s0: Math.min(...ends), s1: Math.max(...ends), c0: Math.min(...core), c1: Math.max(...core) });
    }
  }
  return out;
}

/** Arco d'apertura in SVG (centro c, da a verso b, raggio r) */
function arcPath(c: Vec2, a: Vec2, b: Vec2, r: number) {
  const ax = a.x - c.x;
  const ay = -(a.y - c.y);
  const bx = b.x - c.x;
  const by = -(b.y - c.y);
  const sweep = ax * by - ay * bx > 0 ? 1 : 0;
  return `M${a.x},${-a.y} A${r},${r} 0 0 ${sweep} ${b.x},${-b.y}`;
}

/**
 * Serramento in pianta. A scala di dettaglio (≥ 1:50 circa): controtelaio, telaio fisso, ante con
 * vetro e apertura, davanzale o soglia. A scala 1:100: telaio, vetro e apertura semplificati.
 */
function OpeningPlan({
  project: p,
  wall: w,
  g,
  opening: o,
  type,
  start,
  end,
  mm,
  detail,
}: {
  project: Project;
  wall: Wall;
  g: WallGeom;
  opening: Opening;
  type: OpeningType;
  start: number;
  end: number;
  mm: number;
  detail: boolean;
}) {
  const spec = fixtureSpec(p, w, g, o, type);
  const P = (s0: number, oo: number) => add(add(w.a, mul(g.d, s0)), mul(g.n, oo));
  const R = (s0: number, s1: number, o0: number, o1: number) => pts([P(s0, o0), P(s1, o0), P(s1, o1), P(s0, o1)]);
  const sg = g.extSign;
  const fo = spec.fc - spec.fd / 2;
  const fi = spec.fc + spec.fd / 2;
  const outerFrame = spec.fc + sg * (spec.fd / 2); // faccia del telaio verso l'esterno
  const leaves = leafSpans(spec, start, end);
  const isDoor = type.category === 'porta';
  const thin = 0.13 * mm;
  const med = 0.25 * mm;

  const base = (
    <>
      {spec.hasSill && (
        <>
          <polygon points={pts(bandPolygon(g, g.half, -g.half, start, end))} className="pv-parapet" strokeWidth={thin} />
          {/* davanzale: 4 cm oltre il filo esterno, 3 cm oltre gli stipiti */}
          <polygon points={R(start - 0.03, end + 0.03, outerFrame, sg * (g.half + 0.04))} className="pv-sill" strokeWidth={med * 0.8} />
        </>
      )}
      {spec.hasThreshold && <polygon points={R(start, end, outerFrame, sg * (g.half + 0.02))} className="pv-sill" strokeWidth={med * 0.8} />}
    </>
  );

  if (!detail) {
    return (
      <g className={isDoor ? 'pv-door' : 'pv-window'}>
        {base}
        {!isDoor && (
          <>
            <polygon points={R(start, end, fo, fi)} className="pv-frame" strokeWidth={med * 0.8} />
            <polyline points={pts([P(start, spec.fc), P(end, spec.fc)])} className="pv-glass" strokeWidth={med} />
          </>
        )}
        {isDoor &&
          leaves.map((l, i) => {
            const wL = Math.abs(l.s1 - l.s0);
            const oh = spec.fc + spec.openDir * (spec.fd / 2);
            const tip = P(l.hinge, oh + spec.openDir * wL);
            return (
              <g key={i} strokeWidth={0.18 * mm}>
                <polyline points={pts([P(l.hinge, oh), tip])} strokeWidth={0.35 * mm} />
                <path d={arcPath(P(l.hinge, oh), tip, P(l.free, oh), wL)} strokeDasharray={`${0.8 * mm} ${0.6 * mm}`} />
              </g>
            );
          })}
      </g>
    );
  }

  // ── dettaglio ──
  const jambs = [
    { s: start, dir: 1 },
    { s: end, dir: -1 },
  ];
  return (
    <g className={isDoor ? 'pv-door' : 'pv-window'}>
      {base}
      {jambs.map((j, i) => {
        const ct0 = j.s;
        const ct1 = j.s + j.dir * spec.ct;
        const tf1 = ct1 + j.dir * spec.tf;
        const proud = isDoor && !spec.exterior ? 0.012 : 0; // coprifili delle porte interne
        return (
          <g key={i}>
            <polygon points={R(Math.min(ct0, ct1), Math.max(ct0, ct1), fo - 0.01, fi + 0.01)} className="pv-ct" strokeWidth={thin} />
            <polygon points={R(Math.min(ct1, tf1), Math.max(ct1, tf1), fo - proud, fi + proud)} className="pv-frame" strokeWidth={med * 0.8} />
          </g>
        );
      })}
      {leaves.map((l, i) => {
        const wL = Math.abs(l.s1 - l.s0);
        const toFree = Math.sign(l.free - l.hinge) || 1;
        if (isDoor) {
          // anta aperta a 90° sulla faccia del telaio, arco fino alla battuta
          const oh = spec.fc + spec.openDir * (spec.fd / 2);
          const tip = P(l.hinge, oh + spec.openDir * wL);
          return (
            <g key={i}>
              <polygon points={R(l.hinge, l.hinge + toFree * spec.leafT, oh, oh + spec.openDir * wL)} className="pv-leaf" strokeWidth={med * 0.8} />
              <path d={arcPath(P(l.hinge, oh), tip, P(l.free, oh), wL)} className="pv-swing" strokeWidth={thin} strokeDasharray={`${0.8 * mm} ${0.6 * mm}`} />
            </g>
          );
        }
        // anta di finestra chiusa, vetro, apertura verso l'interno
        const half = spec.leafT / 2;
        const oh = spec.fc + spec.openDir * half;
        const tip = P(l.hinge, oh + spec.openDir * wL);
        return (
          <g key={i}>
            <polygon points={R(l.s0, l.s1, spec.fc - half, spec.fc + half)} className="pv-leaf" strokeWidth={med * 0.8} />
            <polyline points={pts([P(l.s0 + 0.045, spec.fc), P(l.s1 - 0.045, spec.fc)])} className="pv-glass" strokeWidth={med} />
            <polyline points={pts([P(l.hinge, oh), tip])} className="pv-swing" strokeWidth={thin} />
            <path d={arcPath(P(l.hinge, oh), tip, P(l.free, oh), wL)} className="pv-swing" strokeWidth={thin} strokeDasharray={`${0.8 * mm} ${0.6 * mm}`} />
          </g>
        );
      })}
    </g>
  );
}

function GhostWalls({ project: p, levelId, mm }: { project: Project; levelId: string; mm: number }) {
  return (
    <g className="pv-ghost" strokeWidth={0.18 * mm}>
      {p.elements.map((e) => {
        if (e.kind !== 'wall' || e.levelId !== levelId) return null;
        // solo le facce e gli estremi liberi: niente linee dei giunti
        const g = wallGeom(p, e);
        const at = (sv: number, o: number) => add(add(e.a, mul(g.d, sv)), mul(g.n, o));
        const segs: [Vec2, Vec2][] = [
          [at(startAt(g, g.half), g.half), at(endAt(g, g.half), g.half)],
          [at(startAt(g, -g.half), -g.half), at(endAt(g, -g.half), -g.half)],
        ];
        if (g.a.kind === 'libero') segs.push([at(startAt(g, g.half), g.half), at(startAt(g, -g.half), -g.half)]);
        if (g.b.kind === 'libero') segs.push([at(endAt(g, g.half), g.half), at(endAt(g, -g.half), -g.half)]);
        return (
          <g key={e.id}>
            {segs.map(([P, Q], i) => (
              <line key={i} x1={P.x} y1={-P.y} x2={Q.x} y2={-Q.y} />
            ))}
          </g>
        );
      })}
    </g>
  );
}

export interface DimTarget {
  chain: DimChain;
  k: number;
  value: number;
  at: Vec2;
}

/**
 * Catene di quote. Fila 1 (parziali) a 6 mm dalla faccia, fila 2 (totale) a 13 mm.
 * Le cifre dei segmenti stretti vengono sfalsate per non sovrapporsi.
 */
function DimChains({
  project: p,
  levelId,
  mm,
  ts,
  onEdit,
  activeKey,
}: {
  project: Project;
  levelId: string;
  mm: number;
  ts: number;
  onEdit?: (t: DimTarget) => void;
  activeKey?: string;
}) {
  const chains = computeDimensions(p, levelId);
  const font = 2 * mm * ts;
  const charW = font * 0.62;
  return (
    <g className="pv-dim" strokeWidth={0.13 * mm}>
      {chains.map((c) => {
        const off = (c.row === 1 ? 6 : 13) * mm * ts;
        const P = (s: number, extra = 0) => add(add(c.origin, mul(c.dir, s)), mul(c.out, off + extra));
        const s0 = c.marks[0].s;
        const s1 = c.marks[c.marks.length - 1].s;
        const a = P(s0);
        const b = P(s1);
        let ang = (Math.atan2(-c.dir.y, c.dir.x) * 180) / Math.PI;
        // testo leggibile da sotto o da destra
        const flipText = ang > 90 || ang <= -90;
        if (flipText) ang += 180;
        const tick = 1.1 * mm * ts;
        let lastEnd = -Infinity;
        let stagger = 0;
        return (
          <g key={c.id}>
            <line x1={a.x} y1={-a.y} x2={b.x} y2={-b.y} />
            {c.marks.map((m, i) => {
              const f = add(c.origin, mul(c.dir, m.s));
              const q = P(m.s);
              const t1 = add(q, mul(add(c.dir, c.out), tick * 0.7));
              const t2 = sub(q, mul(add(c.dir, c.out), tick * 0.7));
              const e2 = add(q, mul(c.out, tick));
              const e1 = add(f, mul(c.out, 1.2 * mm));
              return (
                <g key={i}>
                  {c.row === 1 && <line x1={e1.x} y1={-e1.y} x2={e2.x} y2={-e2.y} className="pv-dim-ext" />}
                  <line x1={t1.x} y1={-t1.y} x2={t2.x} y2={-t2.y} strokeWidth={0.35 * mm} />
                </g>
              );
            })}
            {c.marks.slice(0, -1).map((m, k) => {
              const len = c.marks[k + 1].s - m.s;
              if (len < 0.005) return null;
              const label = len.toFixed(2);
              const mid = (m.s + c.marks[k + 1].s) / 2;
              const w = label.length * charW;
              const segPaper = len;
              // sfalsa la cifra se si sovrappone alla precedente
              const start = mid - w / 2;
              stagger = start < lastEnd + charW * 0.5 && segPaper < w * 1.1 ? (stagger ? 0 : 1) : 0;
              lastEnd = mid + w / 2;
              const q = P(mid, font * 0.35 + stagger * font * 1.15);
              const editable = !!onEdit && !!segmentEdit(c, k);
              const key = `${c.id}#${k}`;
              return (
                <text
                  key={`t${k}`}
                  x={q.x}
                  y={-q.y}
                  fontSize={font}
                  textAnchor="middle"
                  className={`pv-dimtext ${c.row === 1 && c.marks.length > 2 ? 'pv-dimpartial' : ''} ${editable ? 'pv-dim-editable' : ''} ${activeKey === key ? 'pv-dim-active' : ''}`}
                  transform={`rotate(${ang} ${q.x} ${-q.y})`}
                  onPointerDown={
                    editable
                      ? (e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          onEdit!({ chain: c, k, value: len, at: q });
                        }
                      : undefined
                  }
                >
                  {editable && <title>Clic per scrivere la misura: {segmentEdit(c, k)}</title>}
                  {label}
                </text>
              );
            })}
          </g>
        );
      })}
    </g>
  );
}

function SelectionOutline({ project: p, id, mm, levelId }: { project: Project; id: string; mm: number; levelId: string }) {
  const e = p.elements.find((x) => x.id === id);
  if (!e) return null;
  const sw = 0.5 * mm;
  // la scala si evidenzia anche al piano di arrivo
  const arrives = e.kind === 'stair' && levelAbove(p, e.levelId)?.id === levelId;
  if ('levelId' in e && e.levelId !== levelId && !arrives) return null;
  switch (e.kind) {
    case 'wall': {
      return (
        <g className="pv-sel" strokeWidth={sw}>
          <polygon points={pts(wallOutline(wallGeom(p, e)))} />
          <circle cx={e.a.x} cy={-e.a.y} r={1.2 * mm} className="pv-handle" />
          <circle cx={e.b.x} cy={-e.b.y} r={1.2 * mm} className="pv-handle" />
        </g>
      );
    }
    case 'opening': {
      const w = p.elements.find((x) => x.id === e.wallId);
      const t = byId(p.catalog.opening, e.typeId);
      if (!w || w.kind !== 'wall' || !t || w.levelId !== levelId) return null;
      const th = wallThickness(byId(p.catalog.wall, w.typeId)) + 0.1;
      return (
        <g className="pv-sel" strokeWidth={sw}>
          <polygon points={pts(wallSegmentQuad(w, th, e.offset - t.width / 2, e.offset + t.width / 2))} />
        </g>
      );
    }
    case 'slab':
    case 'roof':
      return (
        <g className="pv-sel" strokeWidth={sw}>
          {e.kind === 'slab' ? (
            // il foro scala resta vuoto anche nella selezione
            <path d={[e.points, ...slabHoles(p, e)].map((r) => `M${pts(r).replace(/ /g, ' L')} Z`).join(' ')} fillRule="evenodd" />
          ) : (
            // copertura: tutto l'ingombro, sporto compreso
            <polygon points={pts(roofOutline(roofWithEave(p, e)))} />
          )}
          {e.points.map((q, i) => (
            <circle key={i} cx={q.x} cy={-q.y} r={1.2 * mm} className="pv-handle" />
          ))}
        </g>
      );
    case 'column':
      return (
        <g className="pv-sel" strokeWidth={sw}>
          <polygon points={pts(columnQuad(e, byId(p.catalog.column, e.typeId)))} />
        </g>
      );
    case 'beam':
    case 'stair': {
      const wdt = e.kind === 'stair' ? e.width : byId(p.catalog.beam, e.typeId)?.width ?? 0.3;
      return (
        <g className="pv-sel" strokeWidth={sw}>
          {e.kind === 'stair' ? (
            stairFootprints(p, e).map((q, i) => <polygon key={i} points={pts(q)} />)
          ) : (
            <polygon points={pts(wallSegmentQuad(e as unknown as Wall, wdt, 0, dist(e.a, e.b)))} />
          )}
          <circle cx={e.a.x} cy={-e.a.y} r={1.2 * mm} className="pv-handle" />
          <circle cx={e.b.x} cy={-e.b.y} r={1.2 * mm} className="pv-handle" />
        </g>
      );
    }
  }
}
