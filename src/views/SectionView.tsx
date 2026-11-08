// Sezione verticale generata dal modello.
// Ciò che sta oltre il piano è disegnato in vista (motore dei prospetti); ciò che il piano taglia
// (muri, solai, coperture, pilastri, travi, scale) è campito. Le aperture tagliate interrompono il muro.

import type { Project, SectionLine, Vec2, Wall } from '../model/types';
import { add, bbox, byId, columnQuad, dist, dot, mul, norm, openingSpans, perp, roofOutline, roofEave, roofWithEave, roofRidgeRise, roofUndersideAt, slabHoles, stairLayout, flightQuad, flightProfile, LANDING_THICKNESS, slabOutline, sub, wallHeight, wallLength, wallSegmentQuad } from '../model/geometry';
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

/** Quota dell'intradosso del profilo di una rampa all'ascissa x */
function profileBottom(prof: Vec2[], x: number) {
  let z = Infinity;
  for (let i = 0; i < prof.length; i++) {
    const a = prof[i];
    const b = prof[(i + 1) % prof.length];
    if ((a.x - x) * (b.x - x) > 0 || Math.abs(a.x - b.x) < 1e-9) continue;
    const t = (x - a.x) / (b.x - a.x);
    z = Math.min(z, a.y + (b.y - a.y) * t);
  }
  return z === Infinity ? 0 : z;
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
      // sotto le falde il muro sale fino all'intradosso della copertura (timpano)
      const topAt = (uu: number) => roofUndersideAt(p, add(f.origin, mul(f.u, uu)), z0 + H) ?? z0 + H;
      ivs.forEach(([u0, u1], i) => {
        if (!hit) {
          const t0 = topAt(u0);
          const t1 = topAt(u1);
          if (Math.abs(t0 - z0 - H) < 1e-3 && Math.abs(t1 - z0 - H) < 1e-3) return rect(`${e.id}${i}`, u0, u1, z0, z0 + H);
          cuts.push(
            <polygon key={`${e.id}${i}`} points={`${u0},${Z(z0)} ${u1},${Z(z0)} ${u1},${Z(t1)} ${u0},${Z(t0)}`} className="sc-cut" strokeWidth={sw} />,
          );
          return;
        }
        const h0 = z0 + hit.type.sill;
        const h1 = Math.min(z0 + H, h0 + hit.type.height);
        if (h0 > z0 + 1e-3) rect(`${e.id}${i}b`, u0, u1, z0, h0);
        // sopra l'architrave il muro arriva fino alla copertura
        cuts.push(
          <polygon key={`${e.id}${i}t`} points={`${u0},${Z(h1)} ${u1},${Z(h1)} ${u1},${Z(topAt(u1))} ${u0},${Z(topAt(u0))}`} className="sc-cut" strokeWidth={sw} />,
        );
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
      // tratti tagliati meno i fori scala
      let ivs = cutIntervals(slabOutline(p, e), f);
      for (const h of slabHoles(p, e))
        for (const [h0, h1] of cutIntervals(h, f))
          ivs = ivs.flatMap(([a, b]) => (h1 <= a || h0 >= b ? [[a, b] as [number, number]] : ([[a, h0], [h1, b]] as [number, number][]).filter(([x, y]) => y - x > 1e-4)));
      ivs.forEach(([u0, u1], i) => rect(`${e.id}${i}`, u0, u1, z0 - th, z0));
    } else if (e.kind === 'column') {
      cutIntervals(columnQuad(e, byId(p.catalog.column, e.typeId)), f).forEach(([u0, u1], i) => rect(`${e.id}${i}`, u0, u1, z0, z0 + lvl.height));
    } else if (e.kind === 'beam') {
      const t = byId(p.catalog.beam, e.typeId);
      const q = wallSegmentQuad(e as unknown as Wall, t?.width ?? 0.3, 0, dist(e.a, e.b));
      const top = z0 + lvl.height;
      cutIntervals(q, f).forEach(([u0, u1], i) => rect(`${e.id}${i}`, u0, u1, top - (t?.height ?? 0.4), top));
    } else if (e.kind === 'stair') {
      const lay = stairLayout(p, e);
      lay.flights.forEach((fl, k) => {
        const ivs = cutIntervals(flightQuad(fl, lay.width), f);
        if (!ivs.length) return;
        const prof = flightProfile(p, e, lay, k);
        const along = dot(fl.d, f.u);
        if (Math.abs(along) > 0.7) {
          // rampa parallela al piano: profilo con gradini e soletta
          const ua = U(fl.a);
          const sg = Math.sign(along);
          cuts.push(<polygon key={`${e.id}f${k}`} points={prof.map((q) => `${ua + sg * q.x},${Z(q.y)}`).join(' ')} className="sc-cut" strokeWidth={sw} />);
        } else {
          // rampa trasversale: si taglia una fetta, dal gradino alla soletta
          const mid = (ivs[0][0] + ivs[0][1]) / 2;
          const X = add(f.origin, mul(f.u, mid));
          const x = Math.max(0, Math.min(fl.len, dot(sub(X, fl.a), fl.d)));
          const zTop = fl.base + Math.min(fl.steps, Math.floor(x / lay.tread) + 1) * lay.h;
          const zBot = profileBottom(prof, x);
          ivs.forEach(([u0, u1], i) => rect(`${e.id}f${k}${i}`, u0, u1, zBot, zTop));
        }
      });
      lay.landings.forEach((l, k) => cutIntervals(l.poly, f).forEach(([u0, u1], i) => rect(`${e.id}l${k}${i}`, u0, u1, l.z - LANDING_THICKNESS, l.z)));
    } else if (e.kind === 'roof') {
      const t = byId(p.catalog.roof, e.typeId);
      const th = t?.thickness ?? 0.3;
      const base = z0 + lvl.height;
      if (e.shape === 'piana') {
        cutIntervals(roofOutline(roofWithEave(p, e)), f).forEach(([u0, u1], i) => rect(`${e.id}${i}`, u0, u1, base, base + th));
        continue;
      }
      const b = bbox(e.points);
      const o = roofEave(p, e);
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

  // scale oltre il piano di sezione, in vista, dal più lontano
  const views: { depth: number; node: React.ReactNode }[] = [];
  const far = section.depth;
  const visible = (q: Vec2[]) => {
    const ds = q.map(D);
    return Math.max(...ds) > 1e-6 && Math.min(...ds) < far;
  };
  const mean = (q: Vec2[]) => q.map(D).reduce((t, x) => t + x, 0) / q.length;
  for (const e of p.elements) {
    if (e.kind !== 'stair' || !byId(p.levels, e.levelId)) continue;
    const lay = stairLayout(p, e);
    lay.flights.forEach((fl, k) => {
      const quad = flightQuad(fl, lay.width);
      if (!visible(quad)) return;
      const along = dot(fl.d, f.u);
      const prof = flightProfile(p, e, lay, k);
      if (Math.abs(along) > 0.7) {
        // di fianco: gradini e soletta (se è tagliata il profilo è già campito)
        if (cutIntervals(quad, f).length) return;
        const ua = U(fl.a);
        const sg = Math.sign(along);
        views.push({
          depth: mean(quad),
          node: <polygon key={`${e.id}v${k}`} points={prof.map((q) => `${ua + sg * q.x},${Z(q.y)}`).join(' ')} className="sc-view" strokeWidth={0.18 * mm} />,
        });
        return;
      }
      const us = quad.map(U);
      const u0 = Math.min(...us);
      const u1 = Math.max(...us);
      const zMin = Math.min(...prof.map((q) => q.y));
      if (dot(fl.d, f.depth) > 0) {
        // sale allontanandosi: si vedono le alzate (solo la parte oltre il piano)
        for (let j = 0; j < fl.steps; j++) {
          const q = flightQuad(fl, lay.width, j * lay.tread, (j + 1) * lay.tread);
          if (!visible(q)) continue;
          const z0 = fl.base + j * lay.h;
          views.push({
            depth: mean(q),
            node: <rect key={`${e.id}v${k}s${j}`} x={u0} y={Z(z0 + lay.h)} width={u1 - u0} height={lay.h} className="sc-view" strokeWidth={0.18 * mm} />,
          });
        }
      } else {
        // sale verso chi guarda: si vede l'intradosso della soletta
        const zTop = fl.base + fl.steps * lay.h;
        views.push({
          depth: mean(quad),
          node: <rect key={`${e.id}v${k}`} x={u0} y={Z(zTop)} width={u1 - u0} height={zTop - zMin} className="sc-view" strokeWidth={0.18 * mm} />,
        });
      }
    });
    lay.landings.forEach((l, k) => {
      if (!visible(l.poly) || cutIntervals(l.poly, f).length) return;
      const us = l.poly.map(U);
      views.push({
        depth: mean(l.poly),
        node: (
          <rect
            key={`${e.id}l${k}`}
            x={Math.min(...us)}
            y={Z(l.z)}
            width={Math.max(...us) - Math.min(...us)}
            height={LANDING_THICKNESS}
            className="sc-view"
            strokeWidth={0.18 * mm}
          />
        ),
      });
    });
  }
  views.sort((a, b) => b.depth - a.depth);

  const gl = p.site.groundLevel;
  return (
    <g className="section">
      <ElevationView project={p} direction={f} mm={mm} textScale={textScale} extents={ext} />
      {views.map((v) => v.node)}
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
