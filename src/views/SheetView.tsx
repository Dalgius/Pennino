// Tavola di stampa in millimetri. Ogni vista è un riferimento al modello, non una copia:
// quando il modello cambia, la tavola si ridisegna.

import { useEffect, useState } from 'react';
import type { PaperFormat, Project, Sheet, Viewport } from '../model/types';
import { bbox, fmt, sortedLevels, wallThickness } from '../model/geometry';
import { openingSchedule, wallSchedule } from '../model/quantities';
import { getHandles } from '../model/edit';
import { PlanView } from './PlanView';
import { ElevationView, elevationExtents, elevationHeight } from './ElevationView';
import { SiteView } from './SiteView';
import { renderAxonometric, sceneBounds } from './scene3d';

export const PAPER: Record<PaperFormat, { w: number; h: number }> = {
  A3: { w: 420, h: 297 },
  A2: { w: 594, h: 420 },
  A1: { w: 841, h: 594 },
};

export const SCALES = [20, 50, 100, 200, 500];
const TITLE_H = 9; // spazio per il titolo sotto la vista (mm)

/** Ingombro della vista sul foglio (mm) e origine del disegno in metri */
export function viewportFrame(p: Project, vp: Viewport) {
  const k = 1000 / vp.scale; // mm di carta per metro
  if (vp.kind === 'pianta') {
    const pts = p.elements.flatMap((e) => ('levelId' in e && e.levelId === vp.levelId ? getHandles(e) : []));
    const b = pts.length ? bbox(pts) : { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    const m = vp.showDimensions ? 2.2 : 1;
    return { w: (b.maxX - b.minX + 2 * m) * k, h: (b.maxY - b.minY + 2 * m) * k, ox: b.minX - m, oy: b.maxY + m, k };
  }
  if (vp.kind === 'prospetto') {
    const ext = elevationExtents(p, vp.direction ?? 'sud');
    const h = elevationHeight(p);
    const extra = 26 / k; // etichette dei livelli
    return { w: (ext.max - ext.min + 2) * k + 26, h: (h.top - h.bottom + 0.5) * k, ox: ext.min - 1, oy: h.top + 0.3, k, extra };
  }
  if (vp.kind === 'planimetria') {
    // inquadratura sul lotto e sull'edificio; il contesto oltre il margine viene ritagliato
    const pts = [...p.site.lot, ...p.elements.flatMap((e) => ('levelId' in e ? getHandles(e) : []))];
    const b = pts.length ? bbox(pts) : { minX: -20, minY: -20, maxX: 20, maxY: 20 };
    const m = 6;
    return { w: (b.maxX - b.minX + 2 * m) * k, h: (b.maxY - b.minY + 2 * m) * k, ox: b.minX - m, oy: b.maxY + m, k };
  }
  if (vp.kind === 'assonometria') {
    const { w, h } = axoSize(p, vp.scale);
    return { w, h, ox: 0, oy: 0, k };
  }
  if (vp.kind === 'abaco') {
    const rows = vp.schedule === 'muri' ? wallSchedule(p).length : openingSchedule(p).length;
    const rowH = vp.schedule === 'muri' ? 6 : 26;
    return { w: vp.schedule === 'muri' ? 230 : 250, h: 12 + rows * rowH, ox: 0, oy: 0, k };
  }
  // legenda
  return { w: 140, h: 16 + p.catalog.wall.length * 9 + 5 * 8, ox: 0, oy: 0, k };
}

function axoSize(p: Project, scale: number) {
  const b = sceneBounds(p);
  const R = Math.max(b.w, b.h, b.top) * 0.85;
  const aspect = 1.4;
  const k = 1000 / scale;
  return { w: 2 * R * aspect * k, h: 2 * R * k, aspect };
}

// Cache delle immagini assonometriche per revisione del modello
const axoCache = new Map<string, string>();

function useAxonometric(p: Project, revision: number, wmm: number, hmm: number) {
  const key = `${revision}:${Math.round(wmm)}x${Math.round(hmm)}`;
  const [url, setUrl] = useState(() => axoCache.get(key) ?? '');
  useEffect(() => {
    if (axoCache.has(key)) return setUrl(axoCache.get(key)!);
    const t = window.setTimeout(() => {
      const px = Math.min(2400, Math.max(600, wmm * 6));
      const u = renderAxonometric(p, px, px * (hmm / wmm));
      if (axoCache.size > 24) axoCache.clear();
      axoCache.set(key, u);
      setUrl(u);
    }, 250);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return url;
}

interface Props {
  project: Project;
  sheet: Sheet;
  revision: number;
  selectedVp?: string | null;
  onViewportDown?: (vp: Viewport, e: React.PointerEvent) => void;
  className?: string;
  widthCss?: string;
  heightCss?: string;
}

export function SheetView({ project: p, sheet, revision, selectedVp, onViewportDown, className, widthCss, heightCss }: Props) {
  const { w: W, h: H } = PAPER[sheet.format];
  return (
    <svg
      className={`sheet-svg ${className ?? ''}`}
      viewBox={`0 0 ${W} ${H}`}
      width={widthCss ?? `${W}mm`}
      height={heightCss ?? `${H}mm`}
      xmlns="http://www.w3.org/2000/svg"
    >
      <style>{SHEET_CSS}</style>
      <rect x={0} y={0} width={W} height={H} className="sh-paper" />
      {/* Squadratura: margine di rilegatura 20 mm a sinistra */}
      <rect x={20} y={10} width={W - 30} height={H - 20} className="sh-frame" />
      {Array.from({ length: Math.floor((W - 30) / 50) + 1 }, (_, i) => (
        <line key={i} x1={20 + i * 50} y1={10} x2={20 + i * 50} y2={12} className="sh-tick" />
      ))}
      {sheet.viewports.map((vp) => (
        <ViewportBox key={vp.id} project={p} vp={vp} revision={revision} selected={selectedVp === vp.id} onDown={onViewportDown} index={sheet.viewports.indexOf(vp) + 1} />
      ))}
      <TitleBlock project={p} sheet={sheet} W={W} H={H} />
    </svg>
  );
}

function ViewportBox({
  project: p,
  vp,
  revision,
  selected,
  onDown,
  index,
}: {
  project: Project;
  vp: Viewport;
  revision: number;
  selected: boolean;
  onDown?: (vp: Viewport, e: React.PointerEvent) => void;
  index: number;
}) {
  const f = viewportFrame(p, vp);
  const mm = vp.scale / 1000; // metri per mm di carta
  const content = () => {
    switch (vp.kind) {
      case 'pianta':
        return (
          <g transform={`scale(${f.k}) translate(${-f.ox} ${f.oy})`}>
            <PlanView project={p} levelId={vp.levelId ?? ''} mm={mm} showDimensions={vp.showDimensions} />
          </g>
        );
      case 'prospetto':
        return (
          <g transform={`scale(${f.k}) translate(${-f.ox} ${f.oy})`}>
            <ElevationView project={p} direction={vp.direction ?? 'sud'} mm={mm} />
          </g>
        );
      case 'planimetria':
        return (
          <g transform={`scale(${f.k}) translate(${-f.ox} ${f.oy})`}>
            <SiteView project={p} mm={mm} />
          </g>
        );
      case 'assonometria':
        return <AxoImage project={p} revision={revision} w={f.w} h={f.h} />;
      case 'abaco':
        return vp.schedule === 'muri' ? <WallTable project={p} /> : <OpeningTable project={p} />;
      case 'legenda':
        return <Legend project={p} />;
    }
  };
  const showScale = vp.kind === 'pianta' || vp.kind === 'prospetto' || vp.kind === 'planimetria' || vp.kind === 'assonometria';
  return (
    <g transform={`translate(${vp.x} ${vp.y})`} className={`sh-vp ${selected ? 'sh-vp-sel' : ''}`} onPointerDown={(e) => onDown?.(vp, e)}>
      <rect x={-2} y={-2} width={f.w + 4} height={f.h + TITLE_H + 4} className="sh-vp-hit" />
      <svg x={0} y={0} width={f.w} height={f.h} overflow="hidden">
        {content()}
      </svg>
      <g transform={`translate(0 ${f.h + 5})`}>
        <circle cx={2.6} cy={0} r={2.6} className="sh-vp-num" />
        <text x={2.6} y={1.05} fontSize={2.8} textAnchor="middle" className="sh-text sh-text-inv">
          {index}
        </text>
        <text x={7.5} y={1.1} fontSize={3.2} className="sh-text sh-text-bold">
          {vp.title.toUpperCase()}
        </text>
        {showScale && (
          <text x={f.w} y={1.1} fontSize={2.6} textAnchor="end" className="sh-text sh-mono">
            {vp.kind === 'assonometria' ? `≈ 1:${vp.scale}` : `1:${vp.scale}`}
          </text>
        )}
        <line x1={7.5} y1={2.6} x2={f.w} y2={2.6} className="sh-line" />
      </g>
      {selected && <rect x={-2} y={-2} width={f.w + 4} height={f.h + TITLE_H + 4} className="sh-vp-outline" />}
    </g>
  );
}

function AxoImage({ project, revision, w, h }: { project: Project; revision: number; w: number; h: number }) {
  const url = useAxonometric(project, revision, w, h);
  return url ? (
    <image href={url} x={0} y={0} width={w} height={h} preserveAspectRatio="xMidYMid meet" />
  ) : (
    <text x={w / 2} y={h / 2} fontSize={3} textAnchor="middle" className="sh-text">
      Generazione vista…
    </text>
  );
}

function OpeningTable({ project: p }: { project: Project }) {
  const rows = openingSchedule(p);
  const cols = [
    { k: 'Sigla', w: 16 },
    { k: 'Prospetto 1:100', w: 34 },
    { k: 'Tipologia', w: 62 },
    { k: 'L × H cm', w: 28 },
    { k: 'Davanzale', w: 22 },
    { k: 'Q.tà', w: 14 },
    { k: 'Sup. m²', w: 20 },
    { k: 'Uw', w: 16 },
    { k: 'Livelli', w: 38 },
  ];
  const xs = cols.reduce<number[]>((acc, _c, i) => [...acc, (acc[i - 1] ?? 0) + (cols[i - 1]?.w ?? 0)], []);
  const rowH = 26;
  return (
    <g>
      <rect x={0} y={0} width={250} height={8} className="sh-th" />
      {cols.map((c, i) => (
        <text key={c.k} x={xs[i] + 1.5} y={5.4} fontSize={2.4} className="sh-text sh-text-bold">
          {c.k}
        </text>
      ))}
      {rows.map((r, i) => {
        const y = 12 + i * rowH;
        const sw = r.width * 10;
        const shh = r.height * 10;
        const sx = xs[1] + (cols[1].w - sw) / 2;
        const sy = y + (rowH - 4 - shh) / 2;
        return (
          <g key={r.typeId}>
            <line x1={0} y1={y + rowH - 4} x2={250} y2={y + rowH - 4} className="sh-line sh-line-soft" />
            <text x={xs[0] + 1.5} y={y + 10} fontSize={3} className="sh-text sh-text-bold">{r.mark}</text>
            <rect x={sx} y={sy} width={sw} height={shh} className="sh-elev" />
            {r.category === 'finestra' ? (
              <line x1={sx + sw / 2} y1={sy} x2={sx + sw / 2} y2={sy + shh} className="sh-line" />
            ) : (
              <polyline points={`${sx + sw},${sy} ${sx},${sy + shh / 2} ${sx + sw},${sy + shh}`} className="sh-line sh-dash" fill="none" />
            )}
            <text x={xs[2] + 1.5} y={y + 10} fontSize={2.6} className="sh-text">{r.name}</text>
            <text x={xs[3] + 1.5} y={y + 10} fontSize={2.6} className="sh-text sh-mono">{Math.round(r.width * 100)} × {Math.round(r.height * 100)}</text>
            <text x={xs[4] + 1.5} y={y + 10} fontSize={2.6} className="sh-text sh-mono">{Math.round(r.sill * 100)}</text>
            <text x={xs[5] + 1.5} y={y + 10} fontSize={2.6} className="sh-text sh-mono sh-text-bold">{r.count}</text>
            <text x={xs[6] + 1.5} y={y + 10} fontSize={2.6} className="sh-text sh-mono">{fmt(r.area)}</text>
            <text x={xs[7] + 1.5} y={y + 10} fontSize={2.6} className="sh-text sh-mono">{r.uw !== undefined ? fmt(r.uw) : '—'}</text>
            <text x={xs[8] + 1.5} y={y + 10} fontSize={2.4} className="sh-text">{r.levels}</text>
          </g>
        );
      })}
    </g>
  );
}

function WallTable({ project: p }: { project: Project }) {
  const rows = wallSchedule(p);
  const cols = [
    { k: 'Sigla', w: 16 },
    { k: 'Tipologia', w: 62 },
    { k: 'Livello', w: 30 },
    { k: 'L m', w: 18 },
    { k: 'H m', w: 18 },
    { k: 'Sp. cm', w: 18 },
    { k: 'Ap.', w: 12 },
    { k: 'Sup. netta m²', w: 30 },
    { k: 'Vol. m³', w: 26 },
  ];
  const xs = cols.reduce<number[]>((acc, _c, i) => [...acc, (acc[i - 1] ?? 0) + (cols[i - 1]?.w ?? 0)], []);
  return (
    <g>
      <rect x={0} y={0} width={230} height={8} className="sh-th" />
      {cols.map((c, i) => (
        <text key={c.k} x={xs[i] + 1.5} y={5.4} fontSize={2.4} className="sh-text sh-text-bold">{c.k}</text>
      ))}
      {rows.map((r, i) => {
        const y = 12 + i * 6;
        const vals = [r.mark, r.type, r.level, fmt(r.length), fmt(r.height), fmt(r.thickness * 100, 1), String(r.openings), fmt(r.netArea), fmt(r.volume)];
        return (
          <g key={r.id}>
            {vals.map((v, j) => (
              <text key={j} x={xs[j] + 1.5} y={y + 1.5} fontSize={2.4} className={`sh-text ${j >= 3 ? 'sh-mono' : ''} ${j === 0 ? 'sh-text-bold' : ''}`}>{v}</text>
            ))}
            <line x1={0} y1={y + 3.2} x2={230} y2={y + 3.2} className="sh-line sh-line-soft" />
          </g>
        );
      })}
    </g>
  );
}

function Legend({ project: p }: { project: Project }) {
  let y = 4;
  const items: React.ReactNode[] = [];
  items.push(<text key="h1" x={0} y={y} fontSize={2.8} className="sh-text sh-text-bold">TIPOLOGIE MURARIE</text>);
  y += 5;
  for (const t of p.catalog.wall) {
    const tot = wallThickness(t);
    let x = 0;
    items.push(
      <g key={t.id}>
        {t.layers.map((l, i) => {
          const w = (l.thickness / tot) * 20;
          const r = <rect key={i} x={x} y={y} width={w} height={5} fill={l.color} stroke="#222" strokeWidth={0.1} />;
          x += w;
          return r;
        })}
        <text x={24} y={y + 2.4} fontSize={2.4} className="sh-text sh-text-bold">{t.name}</text>
        <text x={24} y={y + 5} fontSize={2} className="sh-text sh-text-soft">{t.layers.map((l) => `${l.name} ${fmt(l.thickness * 100, 1)}`).join(' · ')}</text>
      </g>,
    );
    y += 9;
  }
  y += 2;
  items.push(<text key="h2" x={0} y={y} fontSize={2.8} className="sh-text sh-text-bold">SIMBOLI</text>);
  y += 4;
  const sym = [
    { k: 'Edificio di progetto', el: <rect x={0} y={0} width={20} height={4} className="sh-fill-dark" /> },
    { k: 'Edificio esistente (contesto)', el: <rect x={0} y={0} width={20} height={4} className="sh-hatch" /> },
    { k: 'Perimetro del lotto', el: <line x1={0} y1={2} x2={20} y2={2} className="sh-line sh-dashdot" /> },
    { k: 'Copertura / elementi sovrastanti', el: <rect x={0} y={0} width={20} height={4} className="sh-line sh-dash" fill="none" /> },
    { k: 'Pilastro in c.a.', el: <rect x={8} y={0} width={4} height={4} className="sh-fill-dark" /> },
  ];
  for (const s of sym) {
    items.push(
      <g key={s.k} transform={`translate(0 ${y})`}>
        {s.el}
        <text x={24} y={3} fontSize={2.4} className="sh-text">{s.k}</text>
      </g>,
    );
    y += 7;
  }
  return <g>{items}</g>;
}

function TitleBlock({ project: p, sheet, W, H }: { project: Project; sheet: Sheet; W: number; H: number }) {
  const tb = p.titleBlock;
  const w = 180;
  const h = 52;
  const x = W - 10 - w;
  const y = H - 10 - h;
  const scales = [...new Set(sheet.viewports.filter((v) => v.kind !== 'abaco' && v.kind !== 'legenda').map((v) => `1:${v.scale}`))].join(' · ') || '—';
  const levels = sortedLevels(p);
  return (
    <g transform={`translate(${x} ${y})`} className="sh-tb">
      <rect x={0} y={0} width={w} height={h} className="sh-tb-box" />
      <line x1={0} y1={12} x2={w} y2={12} className="sh-line" />
      <line x1={0} y1={28} x2={w} y2={28} className="sh-line" />
      <line x1={0} y1={40} x2={w} y2={40} className="sh-line" />
      <line x1={130} y1={28} x2={130} y2={h} className="sh-line" />
      <line x1={90} y1={12} x2={90} y2={28} className="sh-line" />
      <text x={3} y={5.5} fontSize={3.6} className="sh-text sh-text-bold">{tb.studio.toUpperCase()}</text>
      <text x={3} y={9.8} fontSize={2.2} className="sh-text sh-text-soft">{tb.designer}</text>
      <text x={w - 3} y={5.5} fontSize={2.2} textAnchor="end" className="sh-text sh-text-soft">COMMESSA</text>
      <text x={w - 3} y={9.8} fontSize={3} textAnchor="end" className="sh-text sh-mono sh-text-bold">{tb.projectCode}</text>

      <text x={3} y={16} fontSize={2} className="sh-text sh-text-soft">OPERA</text>
      <text x={3} y={20.5} fontSize={3.2} className="sh-text sh-text-bold">{p.name}</text>
      <text x={3} y={25} fontSize={2.2} className="sh-text">{p.site.address}, {p.site.municipality}</text>
      <text x={93} y={16} fontSize={2} className="sh-text sh-text-soft">COMMITTENTE</text>
      <text x={93} y={20.5} fontSize={2.6} className="sh-text">{tb.client}</text>
      <text x={93} y={25} fontSize={2.2} className="sh-text sh-text-soft">{tb.stage} · ±0.00 = {fmt(p.site.altitude, 2)} s.l.m.</text>

      <text x={3} y={32} fontSize={2} className="sh-text sh-text-soft">OGGETTO DELLA TAVOLA</text>
      <text x={3} y={37} fontSize={3.4} className="sh-text sh-text-bold">{sheet.title.toUpperCase()}</text>

      <text x={3} y={44} fontSize={2} className="sh-text sh-text-soft">SCALA</text>
      <text x={3} y={49} fontSize={2.8} className="sh-text sh-mono">{scales}</text>
      <text x={50} y={44} fontSize={2} className="sh-text sh-text-soft">DATA</text>
      <text x={50} y={49} fontSize={2.8} className="sh-text sh-mono">{sheet.date.split('-').reverse().join('.')}</text>
      <text x={80} y={44} fontSize={2} className="sh-text sh-text-soft">REV.</text>
      <text x={80} y={49} fontSize={2.8} className="sh-text sh-mono">{sheet.revision}</text>
      <text x={96} y={44} fontSize={2} className="sh-text sh-text-soft">FORMATO</text>
      <text x={96} y={49} fontSize={2.8} className="sh-text sh-mono">{sheet.format}</text>

      <rect x={130} y={28} width={50} height={24} className="sh-tb-num" />
      <text x={133} y={32.5} fontSize={2} className="sh-text sh-text-inv">TAVOLA</text>
      <text x={155} y={47} fontSize={11} textAnchor="middle" className="sh-text sh-text-inv sh-text-bold">{sheet.number}</text>
      <title>{levels.length} livelli</title>
    </g>
  );
}

export const SHEET_CSS = `
.sheet-svg { font-family: 'Inter', 'Helvetica Neue', Arial, sans-serif; }
.sheet-svg .sh-paper { fill: #ffffff; }
.sheet-svg .sh-frame { fill: none; stroke: #111; stroke-width: 0.5; }
.sheet-svg .sh-tick, .sheet-svg .sh-line { stroke: #111; stroke-width: 0.18; }
.sheet-svg .sh-line-soft { stroke: #bbb; stroke-width: 0.13; }
.sheet-svg .sh-dash { stroke-dasharray: 1.2 0.8; }
.sheet-svg .sh-dashdot { stroke-dasharray: 4 0.8 0.6 0.8; stroke-width: 0.35; }
.sheet-svg .sh-text { fill: #111; }
.sheet-svg .sh-text-bold { font-weight: 600; }
.sheet-svg .sh-text-soft { fill: #666; }
.sheet-svg .sh-text-inv { fill: #fff; }
.sheet-svg .sh-mono { font-family: 'JetBrains Mono', Menlo, monospace; }
.sheet-svg .sh-th { fill: #ececec; }
.sheet-svg .sh-elev { fill: #e5f0f7; stroke: #111; stroke-width: 0.25; }
.sheet-svg .sh-fill-dark { fill: #222; }
.sheet-svg .sh-hatch { fill: #d6d6d6; stroke: #555; stroke-width: 0.18; }
.sheet-svg .sh-tb-box { fill: #fff; stroke: #111; stroke-width: 0.5; }
.sheet-svg .sh-tb-num { fill: #111; }
.sheet-svg .sh-vp-num { fill: #111; }
.sheet-svg .sh-vp-hit { fill: transparent; }
.sheet-svg .sh-vp-outline { fill: none; stroke: #0ea5e9; stroke-width: 0.6; stroke-dasharray: 2 1; }
.sheet-svg .sh-vp { cursor: move; }
.sheet-svg .pv-slab { fill: #f2f2f2; stroke: #888; }
.sheet-svg .pv-wall { fill: #1a1a1a; }
.sheet-svg .pv-layer { stroke: #111; }
.sheet-svg .pv-wall-outline { fill: none; stroke: #111; }
.sheet-svg .pv-dim-ext { stroke: #555; }
.sheet-svg .pv-column { fill: #1a1a1a; }
.sheet-svg .pv-beam { fill: none; stroke: #333; }
.sheet-svg .pv-roof { fill: none; stroke: #555; }
.sheet-svg .pv-stair { fill: #fff; stroke: #222; }
.sheet-svg .pv-stair polyline { fill: none; }
.sheet-svg .pv-arrowhead { fill: #222; }
.sheet-svg .pv-window { stroke: #111; fill: none; }
.sheet-svg .pv-parapet { fill: #e9e9e9; stroke: #555; }
.sheet-svg .pv-sill { fill: #fff; stroke: #111; }
.sheet-svg .pv-frame { fill: #fff; stroke: #111; }
.sheet-svg .pv-glass { stroke: #111; }
.sheet-svg .pv-door { stroke: #111; fill: none; }
.sheet-svg .pv-dim { stroke: #333; }
.sheet-svg .pv-dimtext { fill: #111; font-family: 'JetBrains Mono', Menlo, monospace; }
.sheet-svg .pv-dimpartial { fill: #555; }
.sheet-svg .pv-label { fill: #555; }
.sheet-svg .ev-wall { fill: #f7f5f0; stroke: #111; }
.sheet-svg .ev-slab { fill: #cfcfcf; stroke: #111; }
.sheet-svg .ev-roof { fill: #8d8d8d; stroke: #111; }
.sheet-svg .ev-glass { fill: #dbe9f2; stroke: #111; }
.sheet-svg .ev-door { fill: #c9b79c; stroke: #111; }
.sheet-svg .ev-frame { stroke: #111; }
.sheet-svg .ev-ground { stroke: #111; }
.sheet-svg .ev-level line { stroke: #111; }
.sheet-svg .ev-level-mark { fill: #111; }
.sheet-svg .ev-text { fill: #111; font-family: 'JetBrains Mono', Menlo, monospace; }
.sheet-svg .ev-text-soft { fill: #666; font-family: 'Inter', sans-serif; }
.sheet-svg .sv-road { stroke: #e3e3e3; fill: none; stroke-linecap: butt; }
.sheet-svg .sv-road-axis { stroke: #999; fill: none; }
.sheet-svg .sv-context { fill: #d9d9d9; stroke: #555; }
.sheet-svg .sv-tree { fill: #eef3e8; stroke: #6b8a55; }
.sheet-svg .sv-tree-trunk { fill: #6b8a55; }
.sheet-svg .sv-lot { fill: none; stroke: #111; }
.sheet-svg .sv-roof { fill: #fff; stroke: #111; }
.sheet-svg .sv-slab { fill: #f0f0f0; stroke: #888; }
.sheet-svg .sv-wall { fill: #1a1a1a; }
.sheet-svg .sv-walltop { fill: #e6e6e6; stroke: #555; }
.sheet-svg .sv-roof-inner { fill: none; stroke: #555; }
.sheet-svg .sv-ridge { stroke: #111; fill: none; }
.sheet-svg .sv-slope line { stroke: #333; }
.sheet-svg .sv-slope polygon { fill: #333; }
.sheet-svg .sv-text { fill: #333; }
.sheet-svg .sv-text-strong { fill: #111; font-weight: 600; }
.sheet-svg .sv-north-ring { fill: none; stroke: #111; }
.sheet-svg .sv-north-fill { fill: #111; }
.sheet-svg .sv-north-open { fill: #fff; stroke: #111; }
.sheet-svg .sv-fence { stroke: #111; fill: none; }
.sheet-svg .sv-fence-dash { stroke: #fff; fill: none; }
.sheet-svg .sv-gate { stroke: #c2410c; }
.sheet-svg .sv-gate-arrow { stroke: #c2410c; }
.sheet-svg .sv-arrowhead { fill: #c2410c; }
.sheet-svg .sv-crane-radius { fill: rgba(234,179,8,0.06); stroke: #b45309; }
.sheet-svg .sv-crane { fill: none; stroke: #b45309; }
.sheet-svg .sv-vehicle { fill: #fff; stroke: #111; }
.sheet-svg .sv-vehicle-cab { fill: #111; }
.sheet-svg .sv-path { stroke: rgba(0,0,0,0.08); fill: none; stroke-linejoin: round; }
.sheet-svg .sv-path-axis { stroke: #555; fill: none; }
`;

