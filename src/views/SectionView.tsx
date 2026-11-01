// Sezione verticale generata dal modello.
// Ciò che sta oltre il piano è disegnato in vista (motore dei prospetti); ciò che il piano taglia
// (muri, solai, coperture, pilastri, travi, scale) è campito. Le aperture tagliate interrompono il muro.

import type { Project, SectionLine, Vec2, Wall } from '../model/types';
import { add, bbox, byId, columnQuad, dist, dot, levelAbove, mul, norm, openingSpans, perp, roofRidgeRise, sub, wallHeight, wallLength, wallSegmentQuad } from '../model/geometry';
import { fixtureSpec } from '../model/openings';
import { wallGeom, wallOutline } from '../model/walls';
import { ElevationView, type ViewFrame } from './ElevationView';

export function sectionFrame(s: SectionLine): ViewFrame {
  const a = s.flip ? s.b : s.a;
  const b = s.flip ? s.a : s.b;
  const u = norm(sub(b, a));
  return { u, depth: perp(u), origin: a, near: 0, far: s.depth };
}

export const sectionLength = (s: SectionLine) => dist(s.a, s.b);

/** Intervalli (in u) in cui il piano di sezione attraversa il poligono */
function cutIntervals(poly: Vec2[], f: ViewFrame): [number, number][] {
  const D = (q: Vec2) => dot(sub(q, f.origin), f.depth);
  const U = (q: Vec2) => dot(sub(q, f.origin), f.u);
  const xs: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const dp = D(p);
    const dq = D(q);
    if ((dp > 0) !== (dq > 0) && Math.abs(dp - dq) > 1e-9) {
      const t = dp / (dp - dq);
      xs.push(U(p) + (U(q) - U(p)) * t);
    }
  }
  xs.sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] > 1e-4) out.push([xs[i], xs[i + 1]]);
  return out;
}

export function SectionView({ project: p, section, mm, textScale = 1 }: { project: Project; section: SectionLine; mm: number; textScale?: number }) {
  const f = sectionFrame(section);
  const L = sectionLength(section);
  const ext = { min: -0.5, max: L + 0.5 };
  const Z = (z: number) => -z;
  const D = (q: Vec2) => dot(sub(q, f.origin), f.depth);
  const U = (q: Vec2) => dot(sub(q, f.origin), f.u);
  const cuts: React.ReactNode[] = [];
  const sw = 0.35 * mm;
  const rect = (key: string, u0: number, u1: number, z0: number, z1: number, cls = 'sc-cut') =>
    cuts.push(<rect key={key} x={Math.min(u0, u1)} y={Z(Math.max(z0, z1))} width={Math.abs(u1 - u0)} height={Math.abs(z1 - z0)} className={cls} strokeWidth={sw} />);

  for (const e of p.elements) {
    const lvl = 'levelId' in e ? byId(p.levels, e.levelId) : undefined;
    if (!lvl) continue;
    const z0 = lvl.elevation;
    if (e.kind === 'wall') {
      const g = wallGeom(p, e);
      const H = wallHeight(p, e);
      const ivs = cutIntervals(wallOutline(g), f);
      if (!ivs.length) continue;
      // il piano attraversa un'apertura?
      const da = D(e.a);
      const db = D(e.b);
      let hit: ReturnType<typeof openingSpans>[number] | undefined;
      let X: Vec2 | undefined;
      if ((da > 0) !== (db > 0)) {
        const t = da / (da - db);
        const sAt = t * wallLength(e);
        X = add(e.a, mul(g.d, sAt));
        hit = openingSpans(p, e).find((sp) => sAt >= sp.start && sAt <= sp.end);
      }
      ivs.forEach(([u0, u1], i) => {
        if (!hit) return rect(`${e.id}${i}`, u0, u1, z0, z0 + H);
        const h0 = z0 + hit.type.sill;
        const h1 = Math.min(z0 + H, h0 + hit.type.height);
        if (h0 > z0 + 1e-3) rect(`${e.id}${i}b`, u0, u1, z0, h0);
        rect(`${e.id}${i}t`, u0, u1, h1, z0 + H);
      });
      if (hit && X) {
        // serramento tagliato: telaio in alto e in basso, vetro o anta, davanzale
        const spec = fixtureSpec(p, e, g, hit.opening, hit.type);
        const h0 = z0 + hit.type.sill;
        const h1 = Math.min(z0 + H, h0 + hit.type.height);
        const uc = U(add(X, mul(g.n, spec.fc)));
        const half = spec.fd / 2;
        const tf = spec.ct + spec.tf;
        const isDoor = hit.type.category === 'porta';
        cuts.push(
          <g key={`${e.id}f`} className="sc-fixture" strokeWidth={0.18 * mm}>
            <rect x={uc - half} y={Z(h1)} width={spec.fd} height={tf} />
            {!isDoor && <rect x={uc - half} y={Z(h0 + tf)} width={spec.fd} height={tf} />}
            {isDoor ? (
              <rect x={uc - spec.leafT / 2} y={Z(h1 - tf)} width={spec.leafT} height={h1 - tf - h0} className="sc-leaf" />
            ) : (
              <line x1={uc} y1={Z(h1 - tf)} x2={uc} y2={Z(h0 + tf)} className="sc-glass" strokeWidth={0.3 * mm} />
            )}
            {spec.hasSill &&
              (() => {
                const uo = U(add(X!, mul(g.n, g.extSign * (g.half + 0.04))));
                const ui = U(add(X!, mul(g.n, spec.fc + g.extSign * half)));
                return <rect x={Math.min(uo, ui)} y={Z(h0)} width={Math.abs(uo - ui)} height={0.04} className="sc-sill" />;
              })()}
          </g>,
        );
      }
    } else if (e.kind === 'slab') {
      const th = byId(p.catalog.slab, e.typeId)?.thickness ?? 0.3;
      cutIntervals(e.points, f).forEach(([u0, u1], i) => rect(`${e.id}${i}`, u0, u1, z0 - th, z0));
    } else if (e.kind === 'column') {
      cutIntervals(columnQuad(e, byId(p.catalog.column, e.typeId)), f).forEach(([u0, u1], i) => rect(`${e.id}${i}`, u0, u1, z0, z0 + lvl.height));
    } else if (e.kind === 'beam') {
      const t = byId(p.catalog.beam, e.typeId);
      const q = wallSegmentQuad(e as unknown as Wall, t?.width ?? 0.3, 0, dist(e.a, e.b));
      const top = z0 + lvl.height;
      cutIntervals(q, f).forEach(([u0, u1], i) => rect(`${e.id}${i}`, u0, u1, top - (t?.height ?? 0.4), top));
    } else if (e.kind === 'stair') {
      const q = wallSegmentQuad(e as unknown as Wall, e.width, 0, dist(e.a, e.b));
      const ivs = cutIntervals(q, f);
      if (!ivs.length) continue;
      const next = levelAbove(p, e.levelId);
      const rise = next ? next.elevation - z0 : lvl.height;
      const steps = Math.max(2, Math.ceil(rise / 0.18));
      const h = rise / steps;
      const sd = norm(sub(e.b, e.a));
      if (Math.abs(dot(sd, f.u)) > 0.7) {
        // rampa parallela al piano: profilo a gradini e intradosso
        const ua = U(e.a);
        const ub = U(e.b);
        const tr = (ub - ua) / steps;
        const ptsArr: string[] = [`${ua},${Z(z0)}`];
        for (let i = 0; i < steps; i++) {
          ptsArr.push(`${ua + i * tr},${Z(z0 + (i + 1) * h)}`);
          ptsArr.push(`${ua + (i + 1) * tr},${Z(z0 + (i + 1) * h)}`);
        }
        const slope = Math.hypot(tr, h) / Math.abs(tr || 1);
        const soffit = 0.16 * slope;
        ptsArr.push(`${ub},${Z(z0 + rise - h - soffit)}`);
        ptsArr.push(`${ua + tr},${Z(z0 - soffit + h * 0.2)}`);
        cuts.push(<polygon key={e.id} points={ptsArr.join(' ')} className="sc-cut" strokeWidth={sw} />);
      } else {
        // rampa perpendicolare: si taglia un gradino
        const mid = (ivs[0][0] + ivs[0][1]) / 2;
        const X = add(f.origin, mul(f.u, mid));
        const t = Math.max(0, Math.min(1, dot(sub(X, e.a), sd) / dist(e.a, e.b)));
        const zt = z0 + Math.ceil(t * steps) * h;
        ivs.forEach(([u0, u1], i) => rect(`${e.id}${i}`, u0, u1, zt - 0.2, zt));
      }
    } else if (e.kind === 'roof') {
      const t = byId(p.catalog.roof, e.typeId);
      const th = t?.thickness ?? 0.3;
      const base = z0 + lvl.height;
      if (e.shape === 'piana') {
        cutIntervals(e.points, f).forEach(([u0, u1], i) => rect(`${e.id}${i}`, u0, u1, base, base + th));
        continue;
      }
      const b = bbox(e.points);
      const o = e.overhang;
      const outline = [
        { x: b.minX - o, y: b.minY - o },
        { x: b.maxX + o, y: b.minY - o },
        { x: b.maxX + o, y: b.maxY + o },
        { x: b.minX - o, y: b.maxY + o },
      ];
      const alongX = b.w >= b.h;
      const half = (alongX ? b.h : b.w) / 2;
      const rise = roofRidgeRise(e.points, e.pitch);
      const slope = rise / (half || 1);
      const cx = (b.minX + b.maxX) / 2;
      const cy = (b.minY + b.maxY) / 2;
      const zb = (uu: number) => {
        const X = add(f.origin, mul(f.u, uu));
        const across = alongX ? X.y - cy : X.x - cx;
        return base + rise - slope * Math.abs(across);
      };
      cutIntervals(outline, f).forEach(([u0, u1], i) => {
        // punti di campionamento: estremi ed eventuale attraversamento del colmo
        const us = [u0, u1];
        const du = alongX ? f.u.y : f.u.x;
        if (Math.abs(du) > 1e-6) {
          const X0 = add(f.origin, mul(f.u, u0));
          const c0 = alongX ? X0.y - cy : X0.x - cx;
          const ur = u0 - c0 / du;
          if (ur > u0 && ur < u1) us.splice(1, 0, ur);
        }
        const bottom = us.map((uu) => `${uu},${Z(zb(uu))}`);
        const top = [...us].reverse().map((uu) => `${uu},${Z(zb(uu) + th)}`);
        cuts.push(<polygon key={`${e.id}${i}`} points={[...bottom, ...top].join(' ')} className="sc-cut" strokeWidth={sw} />);
      });
    }
  }

  const gl = p.site.groundLevel;
  return (
    <g className="section">
      <ElevationView project={p} direction={f} mm={mm} textScale={textScale} extents={ext} />
      {/* terreno sezionato */}
      <rect x={ext.min} y={Z(gl)} width={ext.max - ext.min} height={0.8} className="sc-earth" />
      <line x1={ext.min} y1={Z(gl)} x2={ext.max} y2={Z(gl)} className="ev-ground" strokeWidth={0.7 * mm} />
      {cuts}
    </g>
  );
}

/** Traccia di sezione in pianta: estremi marcati, frecce nel verso di vista, sigla */
export function SectionMark({ section: s, mm, ts = 1, selected }: { section: SectionLine; mm: number; ts?: number; selected?: boolean }) {
  const d = norm(sub(s.b, s.a));
  const look = s.flip ? mul(perp(d), -1) : perp(d);
  const endLen = Math.min(dist(s.a, s.b) / 3, 6 * mm);
  const arrow = 5 * mm;
  const r = 2.6 * mm * ts;
  const end = (P: Vec2, inward: Vec2, label: string, key: string) => {
    const q = add(P, mul(inward, endLen));
    const tip = add(P, mul(look, arrow));
    const h1 = add(tip, add(mul(look, -1.6 * mm), mul(d, 0.9 * mm)));
    const h2 = add(tip, add(mul(look, -1.6 * mm), mul(d, -0.9 * mm)));
    const c = add(P, add(mul(inward, -r * 1.3), mul(look, arrow * 0.5)));
    return (
      <g key={key}>
        <line x1={P.x} y1={-P.y} x2={q.x} y2={-q.y} className="sm-thick" strokeWidth={0.7 * mm} />
        <line x1={P.x} y1={-P.y} x2={tip.x} y2={-tip.y} className="sm-thick" strokeWidth={0.35 * mm} />
        <polygon points={`${tip.x},${-tip.y} ${h1.x},${-h1.y} ${h2.x},${-h2.y}`} className="sm-head" />
        <circle cx={c.x} cy={-c.y} r={r} className="sm-circle" strokeWidth={0.25 * mm} />
        <text x={c.x} y={-c.y} dy={r * 0.38} fontSize={r * 1.05} textAnchor="middle" className="sm-text">
          {label}
        </text>
      </g>
    );
  };
  return (
    <g className={`section-mark ${selected ? 'sm-selected' : ''}`}>
      <line x1={s.a.x} y1={-s.a.y} x2={s.b.x} y2={-s.b.y} className="sm-line" strokeWidth={0.18 * mm} strokeDasharray={`${6 * mm} ${1.2 * mm} ${1 * mm} ${1.2 * mm}`} />
      {end(s.a, d, s.name, 'a')}
      {end(s.b, mul(d, -1), `${s.name}′`, 'b')}
    </g>
  );
}
