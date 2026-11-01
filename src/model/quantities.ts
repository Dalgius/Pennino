// Computo e abachi: funzioni pure del modello.
// Ogni volta che il modello cambia, quantità e importi vengono ricalcolati da qui.

import type { PriceItem, Project, WbsCategory } from './types';
import {
  bbox,
  byId,
  convexHull,
  dist,
  elementCode,
  fmt,
  openingSpans,
  polygonArea,
  polygonPerimeter,
  sortedLevels,
  wallHeight,
  wallLength,
  wallSegmentQuad,
  wallThickness,
} from './geometry';

export interface Measurement {
  /** Elemento del modello o del cantiere da cui deriva la misura */
  sourceId: string;
  source: 'modello' | 'cantiere';
  label: string;
  level: string;
  formula: string;
  qty: number;
}

export interface ComputoLine {
  code: string;
  item: PriceItem | undefined;
  category: WbsCategory;
  measurements: Measurement[];
  qty: number;
  amount: number;
}

export const WBS: WbsCategory[] = [
  'Strutture',
  'Murature',
  'Solai',
  'Coperture',
  'Serramenti',
  'Scale',
  'Finiture',
  'Cantiere e sicurezza',
];

interface Geo {
  length?: number;
  area?: number;
  volume?: number;
  /** descrizioni della formula per unità */
  f: { m?: string; m2?: string; m3?: string };
}

function pick(unit: PriceItem['unit'] | undefined, g: Geo): { qty: number; formula: string } {
  switch (unit) {
    case 'm':
      return { qty: g.length ?? 0, formula: g.f.m ?? '' };
    case 'm²':
      return { qty: g.area ?? 0, formula: g.f.m2 ?? '' };
    case 'm³':
      return { qty: g.volume ?? 0, formula: g.f.m3 ?? '' };
    default:
      return { qty: 1, formula: '1 cad' };
  }
}

const n2 = (x: number) => fmt(x, 2);

export function computeComputo(p: Project): ComputoLine[] {
  const lines = new Map<string, ComputoLine>();
  const priceOf = (code: string) => p.prices.find((x) => x.code === code);

  const push = (code: string | undefined, m: Omit<Measurement, 'qty' | 'formula'>, g: Geo) => {
    if (!code) return;
    const item = priceOf(code);
    const { qty, formula } = pick(item?.unit, g);
    if (qty <= 0) return;
    let line = lines.get(code);
    if (!line) {
      line = { code, item, category: item?.category ?? 'Finiture', measurements: [], qty: 0, amount: 0 };
      lines.set(code, line);
    }
    line.measurements.push({ ...m, qty, formula });
  };

  for (const e of p.elements) {
    const lvl = 'levelId' in e ? byId(p.levels, e.levelId) : undefined;
    const level = lvl?.name ?? '—';
    const label = elementCode(p, e);
    const base = { sourceId: e.id, source: 'modello' as const, label, level };

    if (e.kind === 'wall') {
      const t = byId(p.catalog.wall, e.typeId);
      const L = wallLength(e);
      const H = wallHeight(p, e);
      const th = wallThickness(t);
      const holes = openingSpans(p, e).reduce(
        (s, o) => s + (o.end - o.start) * Math.max(0, Math.min(o.type.height, H - o.type.sill)),
        0,
      );
      const net = L * H - holes;
      const fNet = `${n2(L)} × ${n2(H)}${holes > 0 ? ` − ${n2(holes)} aperture` : ''}`;
      push(t?.priceCode, base, {
        length: L,
        area: net,
        volume: net * th,
        f: { m: `L ${n2(L)}`, m2: fNet, m3: `(${fNet}) × ${n2(th)}` },
      });
      for (const layer of t?.layers ?? []) {
        if (layer.role === 'finitura' && layer.priceCode)
          push(layer.priceCode, { ...base, label: `${label} · ${layer.name}` }, { area: net, f: { m2: fNet } });
      }
    } else if (e.kind === 'slab') {
      const t = byId(p.catalog.slab, e.typeId);
      const A = polygonArea(e.points);
      const th = t?.thickness ?? 0.3;
      push(t?.priceCode, base, {
        area: A,
        volume: A * th,
        length: polygonPerimeter(e.points),
        f: { m2: `A poligono ${n2(A)}`, m3: `${n2(A)} × ${n2(th)}`, m: 'perimetro' },
      });
      if (t?.finishPriceCode)
        push(t.finishPriceCode, { ...base, label: `${label} · ${t.finishName}` }, { area: A, f: { m2: `A ${n2(A)}` } });
    } else if (e.kind === 'column') {
      const t = byId(p.catalog.column, e.typeId);
      const H = lvl?.height ?? 3;
      const w = t?.width ?? 0.3;
      const d = t?.depth ?? 0.3;
      push(t?.priceCode, base, {
        length: H,
        area: w * d,
        volume: w * d * H,
        f: { m: `H ${n2(H)}`, m2: `${n2(w)} × ${n2(d)}`, m3: `${n2(w)} × ${n2(d)} × ${n2(H)}` },
      });
    } else if (e.kind === 'beam') {
      const t = byId(p.catalog.beam, e.typeId);
      const L = dist(e.a, e.b);
      const w = t?.width ?? 0.3;
      const h = t?.height ?? 0.4;
      push(t?.priceCode, base, {
        length: L,
        volume: w * h * L,
        f: { m: `L ${n2(L)}`, m3: `${n2(w)} × ${n2(h)} × ${n2(L)}` },
      });
    } else if (e.kind === 'opening') {
      const t = byId(p.catalog.opening, e.typeId);
      const wall = p.elements.find((x) => x.id === e.wallId);
      const wl = wall && 'levelId' in wall ? byId(p.levels, wall.levelId)?.name : '—';
      push(
        t?.priceCode,
        { ...base, level: wl ?? '—' },
        { area: (t?.width ?? 0) * (t?.height ?? 0), f: { m2: `${n2(t?.width ?? 0)} × ${n2(t?.height ?? 0)}` } },
      );
    } else if (e.kind === 'stair') {
      push('SCA.01', base, { length: dist(e.a, e.b), f: { m: `L ${n2(dist(e.a, e.b))}` } });
    } else if (e.kind === 'roof') {
      const t = byId(p.catalog.roof, e.typeId);
      const A = roofSurface(e.points, e.shape, e.pitch, e.overhang);
      push(t?.priceCode, base, {
        area: A,
        volume: A * (t?.thickness ?? 0.3),
        f: {
          m2: e.shape === 'falde' ? `A orizz. con sporto / cos ${e.pitch}°` : 'A con sporto',
          m3: `${n2(A)} × ${n2(t?.thickness ?? 0.3)}`,
        },
      });
    }
  }

  // Cantiere (fase 05): opere provvisionali e sicurezza
  for (const s of p.siteLogistics) {
    const base = { sourceId: s.id, source: 'cantiere' as const, label: siteItemLabel(s), level: 'Cantiere' };
    if (s.kind === 'recinzione') {
      const L = polygonPerimeter(s.points, false);
      push('CAN.01', base, { length: L, f: { m: `sviluppo ${n2(L)}` } });
    } else if (s.kind === 'accesso') push('CAN.02', base, { f: {} });
    else if (s.kind === 'gru') push('CAN.05', base, { f: {} });
    else if (s.kind === 'area') {
      const A = polygonArea(s.points);
      const code = s.use === 'baraccamenti' ? 'CAN.03' : s.use === 'deposito' ? 'CAN.04' : 'CAN.07';
      push(code, base, { area: A, f: { m2: `A ${n2(A)}` } });
    } else if (s.kind === 'percorso') {
      const L = polygonPerimeter(s.points, false);
      push('CAN.06', base, { area: L * s.width, f: { m2: `${n2(L)} × ${n2(s.width)}` } });
    }
  }

  const out = [...lines.values()];
  for (const l of out) {
    l.qty = l.measurements.reduce((s, m) => s + m.qty, 0);
    l.amount = l.qty * (l.item?.price ?? 0);
  }
  return out.sort((a, b) => WBS.indexOf(a.category) - WBS.indexOf(b.category) || a.code.localeCompare(b.code));
}

export function roofSurface(points: { x: number; y: number }[], shape: 'piana' | 'falde', pitch: number, overhang: number) {
  if (shape === 'piana') return polygonArea(points) + polygonPerimeter(points) * overhang;
  const b = bbox(points);
  const A = (b.w + 2 * overhang) * (b.h + 2 * overhang);
  return A / Math.cos((pitch * Math.PI) / 180);
}

export function siteItemLabel(s: Project['siteLogistics'][number]): string {
  switch (s.kind) {
    case 'recinzione':
      return 'Recinzione';
    case 'accesso':
    case 'area':
    case 'gru':
    case 'percorso':
      return s.name;
    case 'mezzo':
      return s.vehicle[0].toUpperCase() + s.vehicle.slice(1);
  }
}

// ───────────── Indicatori ─────────────

export function projectMetrics(p: Project) {
  let sul = 0;
  let volume = 0;
  let footprint = 0;
  for (const lvl of sortedLevels(p)) {
    if (lvl.kind === 'copertura') continue;
    const pts: { x: number; y: number }[] = [];
    for (const e of p.elements)
      if (e.kind === 'wall' && e.levelId === lvl.id) {
        const t = wallThickness(byId(p.catalog.wall, e.typeId));
        pts.push(...wallSegmentQuad(e, t, 0, wallLength(e)));
      }
    if (pts.length < 3) continue;
    const a = polygonArea(convexHull(pts));
    sul += a;
    volume += a * lvl.height;
    if (lvl.elevation <= 0.01) footprint = Math.max(footprint, a);
  }
  const lotArea = p.site.lot.length > 2 ? polygonArea(p.site.lot) : 0;
  return { sul, volume, footprint, lotArea, coverage: lotArea ? footprint / lotArea : 0 };
}

// ───────────── Abachi ─────────────

export interface OpeningScheduleRow {
  typeId: string;
  mark: string;
  name: string;
  category: 'porta' | 'finestra';
  width: number;
  height: number;
  sill: number;
  count: number;
  area: number;
  uw?: number;
  levels: string;
  ids: string[];
}

export function openingSchedule(p: Project): OpeningScheduleRow[] {
  const seq = { porta: 0, finestra: 0 };
  return p.catalog.opening
    .map((t) => {
      const n = ++seq[t.category];
      const inst = p.elements.filter((e) => e.kind === 'opening' && e.typeId === t.id);
      const levels = new Set<string>();
      for (const o of inst) {
        if (o.kind !== 'opening') continue;
        const w = p.elements.find((x) => x.id === o.wallId);
        if (w && w.kind === 'wall') levels.add(byId(p.levels, w.levelId)?.name ?? '');
      }
      return {
        typeId: t.id,
        mark: `${t.category === 'porta' ? 'P' : 'F'}${String(n).padStart(2, '0')}`,
        name: t.name,
        category: t.category,
        width: t.width,
        height: t.height,
        sill: t.sill,
        count: inst.length,
        area: inst.length * t.width * t.height,
        uw: t.uw,
        levels: [...levels].join(', '),
        ids: inst.map((x) => x.id),
      };
    })
    .filter((r) => r.count > 0);
}

export interface WallScheduleRow {
  id: string;
  mark: string;
  type: string;
  level: string;
  length: number;
  height: number;
  thickness: number;
  openings: number;
  netArea: number;
  volume: number;
}

export function wallSchedule(p: Project): WallScheduleRow[] {
  return p.elements.flatMap((e) => {
    if (e.kind !== 'wall') return [];
    const t = byId(p.catalog.wall, e.typeId);
    const L = wallLength(e);
    const H = wallHeight(p, e);
    const th = wallThickness(t);
    const spans = openingSpans(p, e);
    const holes = spans.reduce((s, o) => s + (o.end - o.start) * Math.max(0, Math.min(o.type.height, H - o.type.sill)), 0);
    return [
      {
        id: e.id,
        mark: elementCode(p, e),
        type: t?.name ?? '—',
        level: byId(p.levels, e.levelId)?.name ?? '—',
        length: L,
        height: H,
        thickness: th,
        openings: spans.length,
        netArea: L * H - holes,
        volume: (L * H - holes) * th,
      },
    ];
  });
}
