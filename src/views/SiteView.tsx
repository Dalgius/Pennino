// Planimetria: lotto, contesto e impronta dell'edificio (fase 01),
// con l'eventuale sovrapposizione della logistica di cantiere (fase 05).

import type { Project, SiteItem, Vec2, VehicleKind } from '../model/types';
import {
  add,
  bbox,
  byId,
  centroid,
  fmt,
  mul,
  norm,
  perp,
  polygonArea,
  sortedLevels,
  sub,
  wallLength,
  wallSegmentQuad,
  wallThickness,
} from '../model/geometry';
import { pts } from './PlanView';

export const VEHICLE_SIZE: Record<VehicleKind, [number, number]> = {
  autobetoniera: [9, 2.5],
  autocarro: [8, 2.5],
  escavatore: [6.5, 3],
  autogru: [12, 2.8],
  pompa: [10.5, 2.5],
};

export const AREA_COLORS: Record<string, string> = {
  deposito: '#c9a24a',
  baraccamenti: '#5b9bd5',
  parcheggio: '#8a8f98',
  rifiuti: '#b56b5a',
  lavorazione: '#7fa36b',
};

interface Props {
  project: Project;
  mm: number;
  logistics?: boolean;
  selectedIds?: string[];
  showNorth?: boolean;
  showLabels?: boolean;
}

export function SiteView({ project: p, mm, logistics, selectedIds = [], showNorth = true, showLabels = true }: Props) {
  const sel = new Set(selectedIds);
  const levels = sortedLevels(p);
  const ground = levels.find((l) => l.elevation >= -0.01) ?? levels[0];
  const roofs = p.elements.filter((e) => e.kind === 'roof');
  const lotBox = p.site.lot.length ? bbox(p.site.lot) : { minX: 0, maxX: 10, minY: 0, maxY: 10, w: 10, h: 10 };

  return (
    <g className="site">
      {/* Contesto */}
      {p.site.context.map((c) => {
        const isSel = sel.has(c.id);
        if (c.kind === 'strada') {
          return (
            <g key={c.id} className={isSel ? 'sv-selected' : ''}>
              <polyline points={pts(c.points)} className="sv-road" strokeWidth={c.width} />
              <polyline points={pts(c.points)} className="sv-road-axis" strokeWidth={0.18 * mm} strokeDasharray={`${4 * mm} ${3 * mm}`} />
              {showLabels && c.points.length > 1 && (
                <text {...labelAt(centroid(c.points.slice(0, 2)), 0)} fontSize={2.4 * mm} className="sv-text sv-text-strong" textAnchor="middle" dy={0.8 * mm}>
                  {c.name}
                </text>
              )}
            </g>
          );
        }
        if (c.kind === 'edificio') {
          const cc = centroid(c.points);
          return (
            <g key={c.id} className={isSel ? 'sv-selected' : ''}>
              <polygon points={pts(c.points)} className="sv-context" strokeWidth={0.25 * mm} />
              {showLabels && (
                <text x={cc.x} y={-cc.y} fontSize={2 * mm} textAnchor="middle" className="sv-text">
                  <tspan x={cc.x}>{c.name}</tspan>
                  <tspan x={cc.x} dy={2.6 * mm}>
                    h {fmt(c.height, 1)} m
                  </tspan>
                </text>
              )}
            </g>
          );
        }
        return (
          <g key={c.id} className={isSel ? 'sv-selected' : ''}>
            <circle cx={c.p.x} cy={-c.p.y} r={c.radius} className="sv-tree" strokeWidth={0.18 * mm} />
            <circle cx={c.p.x} cy={-c.p.y} r={0.25} className="sv-tree-trunk" />
          </g>
        );
      })}

      {/* Lotto */}
      {p.site.lot.length > 2 && (
        <g className={sel.has('lot') ? 'sv-selected' : ''}>
          <polygon
            points={pts(p.site.lot)}
            className="sv-lot"
            strokeWidth={0.5 * mm}
            strokeDasharray={`${6 * mm} ${1.2 * mm} ${1 * mm} ${1.2 * mm}`}
          />
          {showLabels && (
            <text
              x={lotBox.minX + 1.5 * mm}
              y={-lotBox.maxY + 4 * mm}
              fontSize={2 * mm}
              className="sv-text"
            >
              LOTTO · {fmt(polygonArea(p.site.lot), 0)} m² · {p.site.cadastre}
            </text>
          )}
        </g>
      )}

      {/* Logistica di cantiere sotto all'edificio */}
      {logistics &&
        p.siteLogistics
          .filter((s) => s.kind === 'area' || s.kind === 'percorso')
          .map((s) => <SiteLogisticsItem key={s.id} item={s} mm={mm} selected={sel.has(s.id)} showLabels={showLabels} />)}

      {/* Edificio di progetto */}
      <g className="sv-building">
        {roofs.map((r) => {
          if (r.kind !== 'roof') return null;
          const b = bbox(r.points);
          const o = r.overhang;
          const outline =
            r.shape === 'falde'
              ? [
                  { x: b.minX - o, y: b.minY - o },
                  { x: b.maxX + o, y: b.minY - o },
                  { x: b.maxX + o, y: b.maxY + o },
                  { x: b.minX - o, y: b.maxY + o },
                ]
              : r.points;
          return <polygon key={r.id} points={pts(outline)} className="sv-roof" strokeWidth={0.35 * mm} />;
        })}
        {p.elements.map((e) => {
          if (e.kind === 'slab' && ground && e.levelId === ground.id)
            return <polygon key={e.id} points={pts(e.points)} className="sv-slab" strokeWidth={0.13 * mm} />;
          return null;
        })}
        {p.elements.map((e) => {
          if (e.kind !== 'wall' || !ground || e.levelId !== ground.id) return null;
          const th = wallThickness(byId(p.catalog.wall, e.typeId));
          return <polygon key={e.id} points={pts(wallSegmentQuad(e, th, -th / 2, wallLength(e) + th / 2))} className="sv-wall" />;
        })}
      </g>

      {logistics &&
        p.siteLogistics
          .filter((s) => s.kind !== 'area' && s.kind !== 'percorso')
          .map((s) => <SiteLogisticsItem key={s.id} item={s} mm={mm} selected={sel.has(s.id)} showLabels={showLabels} />)}

      {showNorth && (
        <NorthArrow at={{ x: lotBox.maxX - 9 * mm, y: lotBox.maxY - 11 * mm }} angle={p.site.trueNorth} mm={mm} />
      )}
    </g>
  );
}

const labelAt = (c: Vec2, dy: number) => ({ x: c.x, y: -c.y + dy });

export function NorthArrow({ at, angle, mm }: { at: Vec2; angle: number; mm: number }) {
  const r = 6 * mm;
  return (
    <g transform={`translate(${at.x} ${-at.y}) rotate(${angle})`} className="sv-north">
      <circle r={r} strokeWidth={0.18 * mm} className="sv-north-ring" />
      <path d={`M0,${-r} L${r * 0.32},${r * 0.55} L0,${r * 0.3} z`} className="sv-north-fill" />
      <path d={`M0,${-r} L${-r * 0.32},${r * 0.55} L0,${r * 0.3} z`} className="sv-north-open" strokeWidth={0.18 * mm} />
      <text y={-r - 1.5 * mm} fontSize={3 * mm} textAnchor="middle" className="sv-text sv-text-strong">
        N
      </text>
    </g>
  );
}

export function SiteLogisticsItem({
  item: s,
  mm,
  selected,
  showLabels = true,
}: {
  item: SiteItem;
  mm: number;
  selected: boolean;
  showLabels?: boolean;
}) {
  const cls = selected ? 'sv-selected' : '';
  switch (s.kind) {
    case 'recinzione':
      return (
        <g className={cls}>
          <polyline points={pts(s.points)} className="sv-fence" strokeWidth={0.7 * mm} />
          <polyline points={pts(s.points)} className="sv-fence-dash" strokeWidth={0.7 * mm} strokeDasharray={`${0.6 * mm} ${2.4 * mm}`} />
        </g>
      );
    case 'accesso': {
      const ang = (s.rotation * Math.PI) / 180;
      const d = { x: Math.cos(ang), y: Math.sin(ang) };
      const n = perp(d);
      const a = add(s.p, mul(d, -s.width / 2));
      const b = add(s.p, mul(d, s.width / 2));
      const tip = add(s.p, mul(n, 3));
      const tail = add(s.p, mul(n, -4));
      return (
        <g className={cls}>
          <polyline points={pts([a, b])} className="sv-gate" strokeWidth={1.4 * mm} />
          <polyline points={pts([tail, tip])} className="sv-gate-arrow" strokeWidth={0.35 * mm} markerEnd="url(#sv-arrow)" />
          {showLabels && (
            <text x={tail.x} y={-tail.y + 3 * mm} fontSize={2 * mm} textAnchor="middle" className="sv-text sv-text-strong">
              {s.name} · {fmt(s.width, 1)} m
            </text>
          )}
          <defs>
            <marker id="sv-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto">
              <path d="M0,0 L10,5 L0,10 z" className="sv-arrowhead" />
            </marker>
          </defs>
        </g>
      );
    }
    case 'area': {
      const c = centroid(s.points);
      const color = AREA_COLORS[s.use] ?? '#999';
      return (
        <g className={cls}>
          <polygon points={pts(s.points)} fill={color} fillOpacity={0.18} stroke={color} strokeWidth={0.35 * mm} />
          {showLabels && (
            <text x={c.x} y={-c.y} fontSize={2 * mm} textAnchor="middle" className="sv-text sv-text-strong">
              <tspan x={c.x}>{s.name}</tspan>
              <tspan x={c.x} dy={2.6 * mm} className="sv-text">
                {fmt(polygonArea(s.points), 1)} m²
              </tspan>
            </text>
          )}
        </g>
      );
    }
    case 'gru':
      return (
        <g className={cls}>
          <circle cx={s.p.x} cy={-s.p.y} r={s.radius} className="sv-crane-radius" strokeWidth={0.35 * mm} strokeDasharray={`${3 * mm} ${1.5 * mm}`} />
          <rect x={s.p.x - 1} y={-s.p.y - 1} width={2} height={2} className="sv-crane" strokeWidth={0.35 * mm} />
          <line x1={s.p.x - 1} y1={-s.p.y - 1} x2={s.p.x + 1} y2={-s.p.y + 1} className="sv-crane" strokeWidth={0.25 * mm} />
          <line x1={s.p.x + 1} y1={-s.p.y - 1} x2={s.p.x - 1} y2={-s.p.y + 1} className="sv-crane" strokeWidth={0.25 * mm} />
          {showLabels && (
            <text x={s.p.x} y={-s.p.y - s.radius - 1.2 * mm} fontSize={2 * mm} textAnchor="middle" className="sv-text sv-text-strong">
              {s.name} · R {fmt(s.radius, 1)} m
            </text>
          )}
        </g>
      );
    case 'mezzo': {
      const [L, W] = VEHICLE_SIZE[s.vehicle];
      return (
        <g className={cls} transform={`translate(${s.p.x} ${-s.p.y}) rotate(${-s.rotation})`}>
          <rect x={-L / 2} y={-W / 2} width={L} height={W} className="sv-vehicle" strokeWidth={0.25 * mm} />
          <rect x={L / 2 - 2} y={-W / 2} width={2} height={W} className="sv-vehicle-cab" />
          {showLabels && (
            <text y={0.7 * mm} fontSize={1.8 * mm} textAnchor="middle" className="sv-text sv-text-strong">
              {s.vehicle}
            </text>
          )}
        </g>
      );
    }
    case 'percorso': {
      const first = s.points[0];
      const second = s.points[1] ?? first;
      const d = norm(sub(second, first));
      const lab = add(centroid([first, second]), mul(perp(d), s.width / 2 + 1));
      return (
        <g className={cls}>
          <polyline points={pts(s.points)} className="sv-path" strokeWidth={s.width} />
          <polyline points={pts(s.points)} className="sv-path-axis" strokeWidth={0.2 * mm} strokeDasharray={`${2 * mm} ${2 * mm}`} />
          {showLabels && (
            <text x={lab.x} y={-lab.y} fontSize={1.8 * mm} className="sv-text">
              {s.name}
            </text>
          )}
        </g>
      );
    }
  }
}
