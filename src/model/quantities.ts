// Computo e abachi: funzioni pure del modello.
// Ogni volta che il modello cambia, quantità e importi vengono ricalcolati da qui.

import type { PriceItem, Project, WbsCategory } from './types';
import { wallGeom, wallOutline } from './walls';
import {
  bbox,
  byId,
  dist,
  elementCode,
  fmt,
  offsetPolygon,
  openingSpans,
  pointInPolygon,
  polygonArea,
  polygonPerimeter,
  sortedLevels,
  wallHeight,
  wallLength,
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
      const mode = wallMode(p, t);
      if (mode !== 'strati')
        push(t?.priceCode, base, {
          length: L,
          area: net,
          volume: net * th,
          f: { m: `L ${n2(L)}`, m2: fNet, m3: `(${fNet}) × ${n2(th)}` },
        });
      // strati con voce propria: m² = superficie netta, m³ = superficie × spessore dello strato
      for (const layer of mode === 'pacchetto' ? [] : t?.layers ?? []) {
        if (!layer.priceCode) continue;
        push(
          layer.priceCode,
          { ...base, label: `${label} · ${layer.name}` },
          { length: L, area: net, volume: net * layer.thickness, f: { m: `L ${n2(L)}`, m2: fNet, m3: `(${fNet}) × ${n2(layer.thickness)}` } },
        );
      }
    } else if (e.kind === 'slab') {
      const t = byId(p.catalog.slab, e.typeId);
      const A = polygonArea(e.points);
      const th = t?.thickness ?? 0.3;
      // senza stratigrafia la modalità «strati» non ha voci: si torna al pacchetto (più il pavimento)
      const mode = t?.layers?.length ? wallMode(p, t) : wallMode(p, t) === 'strati' ? 'misto' : wallMode(p, t);
      const fA = `A poligono ${n2(A)}`;
      if (mode !== 'strati')
        push(t?.priceCode, base, {
          area: A,
          volume: A * th,
          length: polygonPerimeter(e.points),
          f: { m2: fA, m3: `${n2(A)} × ${n2(th)}`, m: 'perimetro' },
        });
      if (t?.layers?.length) {
        // strati con voce propria: m² = superficie, m³ = superficie × spessore dello strato
        if (mode !== 'pacchetto')
          for (const layer of t.layers)
            if (layer.priceCode)
              push(layer.priceCode, { ...base, label: `${label} · ${layer.name}` }, { area: A, volume: A * layer.thickness, f: { m2: fA, m3: `${n2(A)} × ${n2(layer.thickness)}` } });
      } else if (t?.finishPriceCode && mode !== 'pacchetto')
        // tipologie senza stratigrafia: pavimento a parte
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
      const th = t?.thickness ?? 0.3;
      const mode = wallMode(p, t);
      const fA = e.shape === 'falde' ? `A orizz. con sporto / cos ${e.pitch}°` : 'A con sporto';
      if (mode !== 'strati' || !t?.layers?.length)
        push(t?.priceCode, base, { area: A, volume: A * th, f: { m2: fA, m3: `${n2(A)} × ${n2(th)}` } });
      if (mode !== 'pacchetto')
        for (const layer of t?.layers ?? [])
          if (layer.priceCode)
            push(layer.priceCode, { ...base, label: `${label} · ${layer.name}` }, { area: A, volume: A * layer.thickness, f: { m2: fA, m3: `${n2(A)} × ${n2(layer.thickness)}` } });
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

/** Modalità di computo effettiva di una tipologia di muro (tiene conto della scelta globale del computo) */
export function wallMode(p: Project, t: { computeMode?: 'pacchetto' | 'strati' | 'misto' } | undefined) {
  const o = p.wallComputeOverride;
  if (o === 'pacchetto' || o === 'strati') return o;
  return t?.computeMode ?? 'misto';
}

/** Costo al m² di una tipologia di muro: pacchetto e somma degli strati (per il confronto nell'editor) */
export function wallTypeUnitCosts(p: Project, t: { priceCode: string; layers: { thickness: number; priceCode?: string }[] }) {
  const perM2 = (code: string | undefined, thickness: number) => {
    const it = code ? p.prices.find((x) => x.code === code) : undefined;
    if (!it) return null;
    if (it.unit === 'm²') return it.price;
    if (it.unit === 'm³') return it.price * thickness;
    return null;
  };
  const total = t.layers.reduce((s, l) => s + l.thickness, 0);
  const pack = perM2(t.priceCode, total);
  let layers = 0;
  let priced = 0;
  for (const l of t.layers) {
    const v = perM2(l.priceCode, l.thickness);
    if (v !== null) {
      layers += v;
      priced++;
    }
  }
  return { pack, layers: priced ? layers : null, priced, count: t.layers.length };
}

export function roofSurface(points: { x: number; y: number }[], shape: 'piana' | 'falde', pitch: number, overhang: number) {
  // sporto con gli spigoli: il contorno scostato, non A + P·sporto (che omette gli angoli)
  if (shape === 'piana') return polygonArea(offsetPolygon(points, overhang));
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

/**
 * Superficie lorda di un livello: muri più ambienti chiusi dai muri.
 * Rilievo su griglia: i muri occupano le celle, lo spazio esterno si «allaga» dal bordo,
 * ciò che resta è racchiuso. Un ambito racchiuso conta se è coperto in buona parte da solai
 * del livello (un cortile a cielo aperto no, un vano con il foro scala sì).
 * Rientranze e spazi tra edifici separati restano esterni.
 */
export function levelGrossArea(p: Project, levelId: string): number {
  const outlines = p.elements.flatMap((e) => (e.kind === 'wall' && e.levelId === levelId ? [wallOutline(wallGeom(p, e))] : []));
  if (!outlines.length) return 0;
  const slabs = p.elements.flatMap((e) => (e.kind === 'slab' && e.levelId === levelId ? [e.points] : []));
  const all = outlines.flat();
  const b = bbox(all);
  const cell = Math.max(0.05, Math.max(b.w, b.h) / 700);
  const pad = 2;
  const nx = Math.ceil(b.w / cell) + 2 * pad;
  const ny = Math.ceil(b.h / cell) + 2 * pad;
  const x0 = b.minX - pad * cell;
  const y0 = b.minY - pad * cell;
  const WALL = 1;
  const OUT = 2;
  const grid = new Uint8Array(nx * ny);
  const center = (i: number, j: number) => ({ x: x0 + (i + 0.5) * cell, y: y0 + (j + 0.5) * cell });
  // muri: per ogni contorno si provano solo le celle del suo ingombro
  for (const poly of outlines) {
    const pb = bbox(poly);
    const i0 = Math.max(0, Math.floor((pb.minX - x0) / cell) - 1);
    const i1 = Math.min(nx - 1, Math.ceil((pb.maxX - x0) / cell) + 1);
    const j0 = Math.max(0, Math.floor((pb.minY - y0) / cell) - 1);
    const j1 = Math.min(ny - 1, Math.ceil((pb.maxY - y0) / cell) + 1);
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) if (!grid[j * nx + i] && pointInPolygon(center(i, j), poly)) grid[j * nx + i] = WALL;
  }
  // allagamento dall'esterno
  const stack: number[] = [0];
  grid[0] = OUT;
  while (stack.length) {
    const k = stack.pop()!;
    const i = k % nx;
    const j = (k - i) / nx;
    const nb = [i > 0 ? k - 1 : -1, i < nx - 1 ? k + 1 : -1, j > 0 ? k - nx : -1, j < ny - 1 ? k + nx : -1];
    for (const q of nb) if (q >= 0 && grid[q] === 0) {
      grid[q] = OUT;
      stack.push(q);
    }
  }
  // ambiti racchiusi: si contano se coperti per almeno metà da solai del livello
  let cells = 0;
  const seen = new Uint8Array(nx * ny);
  for (let k = 0; k < grid.length; k++) {
    if (grid[k] === WALL) cells++;
    if (grid[k] !== 0 || seen[k]) continue;
    const comp: number[] = [];
    const st = [k];
    seen[k] = 1;
    while (st.length) {
      const c = st.pop()!;
      comp.push(c);
      const i = c % nx;
      const nb = [i > 0 ? c - 1 : -1, i < nx - 1 ? c + 1 : -1, c - nx, c + nx];
      for (const q of nb) if (q >= 0 && q < grid.length && grid[q] === 0 && !seen[q]) {
        seen[q] = 1;
        st.push(q);
      }
    }
    // campionamento della copertura dei solai (al massimo ~400 punti per ambito)
    const step = Math.max(1, Math.floor(comp.length / 400));
    let covered = 0;
    let tested = 0;
    for (let t = 0; t < comp.length; t += step) {
      const c = comp[t];
      const i = c % nx;
      const pt = center(i, (c - i) / nx);
      tested++;
      if (slabs.some((sl) => pointInPolygon(pt, sl))) covered++;
    }
    if (!slabs.length || covered / tested >= 0.5) cells += comp.length;
  }
  return cells * cell * cell;
}

export function projectMetrics(p: Project) {
  let sul = 0;
  let volume = 0;
  let footprint = 0;
  for (const lvl of sortedLevels(p)) {
    if (lvl.kind === 'copertura') continue;
    const a = levelGrossArea(p, lvl.id);
    if (!a) continue;
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
