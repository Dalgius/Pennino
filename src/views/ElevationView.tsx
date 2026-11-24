// Prospetto ortogonale generato dal modello: muri, aperture, solai, copertura e quote dei livelli.

import { clipHalf, planeAt, roofGeom, roofTop, subtractConvex } from '../model/roofs';
import type { Project, Vec2, Wall } from '../model/types';
import {
  byId,
  clipConvex,
  columnQuad,
  dot,
  fmtLevel,
  norm,
  openingSpans,
  roofUndersideAt,
  slabOutline,
  sortedLevels,
  sub,
  wallHeight,
  wallLength,
  wallTopProfile,
  wallSegmentQuad,
} from '../model/geometry';
import { archProfile, archRise, fixtureSpec, leafSpans, springHeight } from '../model/openings';
import { endAt, startAt, wallGeom, wallOutline } from '../model/walls';

export type Direction = 'sud' | 'nord' | 'est' | 'ovest';

/**
 * Sistema di riferimento di una vista ortogonale: u = asse orizzontale (verso destra di chi guarda),
 * depth = direzione di vista (la distanza cresce allontanandosi dall'osservatore), origin = origine.
 * near/far limitano gli elementi visibili (le sezioni mostrano solo ciò che sta oltre il piano).
 */
export interface ViewFrame {
  u: Vec2;
  depth: Vec2;
  origin: Vec2;
  near?: number;
  far?: number;
}

export function frameOf(dir: Direction): ViewFrame {
  const o = { x: 0, y: 0 };
  switch (dir) {
    case 'sud':
      return { u: { x: 1, y: 0 }, depth: { x: 0, y: 1 }, origin: o };
    case 'nord':
      return { u: { x: -1, y: 0 }, depth: { x: 0, y: -1 }, origin: o };
    case 'est':
      return { u: { x: 0, y: 1 }, depth: { x: -1, y: 0 }, origin: o };
    case 'ovest':
      return { u: { x: 0, y: -1 }, depth: { x: 1, y: 0 }, origin: o };
  }
}

/** Punti in pianta di un elemento (per estensioni e filtri di profondità) */
function elementPoints(e: Project['elements'][number]): Vec2[] {
  if (e.kind === 'wall' || e.kind === 'beam' || e.kind === 'stair') return [e.a, e.b];
  if (e.kind === 'slab' || e.kind === 'roof') return e.points;
  if (e.kind === 'column') return [e.p];
  return [];
}

export function elevationExtents(p: Project, dir: Direction | ViewFrame) {
  const f = typeof dir === 'string' ? frameOf(dir) : dir;
  let min = Infinity;
  let max = -Infinity;
  for (const e of p.elements) {
    for (const q of elementPoints(e)) {
      const d = dot(sub(q, f.origin), f.depth);
      if (f.near !== undefined && d < f.near - 1) continue;
      if (f.far !== undefined && d > f.far) continue;
      const v = dot(sub(q, f.origin), f.u);
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
  }
  if (!isFinite(min)) return { min: 0, max: 10 };
  return { min: min - 1, max: max + 1 };
}

interface Props {
  project: Project;
  direction: Direction | ViewFrame;
  mm: number;
  textScale?: number;
  /** Estensione orizzontale imposta (sezioni) */
  extents?: { min: number; max: number };
}

/** Tratto del muro lungo l'asse compresi i tagli d'estremità (angoli e innesti) */
function wallSpan(p: Project, w: Wall): [number, number] {
  const g = wallGeom(p, w);
  return [Math.min(startAt(g, g.half), startAt(g, -g.half)), Math.max(endAt(g, g.half), endAt(g, -g.half))];
}

export function ElevationView({ project: p, direction, mm, textScale = 1, extents }: Props) {
  const ts = textScale;
  const frame = typeof direction === 'string' ? frameOf(direction) : direction;
  const { u } = frame;
  const U = (q: Vec2) => dot(sub(q, frame.origin), u);
  const D = (q: Vec2) => dot(sub(q, frame.origin), frame.depth);
  const Z = (z: number) => -z;
  const items: { depth: number; node: React.ReactNode }[] = [];
  const ext = extents ?? elevationExtents(p, frame);

  // facce dei muri: i giunti orizzontali tra muri sovrapposti sullo stesso piano non si disegnano
  const faces = new Map<string, { u0: number; u1: number; z0: number; z1: number; d: number; flatTop: boolean }>();
  for (const e of p.elements) {
    if (e.kind !== 'wall') continue;
    const lv = byId(p.levels, e.levelId);
    if (!lv) continue;
    // ingombro vero del muro, con i tagli degli angoli e degli innesti (non un rettangolo allungato di mezzo spessore)
    const q = wallOutline(wallGeom(p, e));
    // nelle sezioni contano solo i muri oltre il piano (stesso filtro del disegno)
    const dq = q.map(D);
    if (frame.near !== undefined && Math.max(...dq) < frame.near) continue;
    if (frame.far !== undefined && Math.min(...dq) > frame.far) continue;
    const us = q.map(U);
    const z1 = lv.elevation + wallHeight(p, e);
    faces.set(e.id, {
      u0: Math.min(...us),
      u1: Math.max(...us),
      z0: lv.elevation,
      z1,
      // muro in facciata: profondità della faccia vista; muro visto di taglio: profondità media,
      // così sta dietro la facciata anche se ne tocca lo spigolo
      d: Math.abs(dot(norm(sub(e.b, e.a)), u)) > 0.7 ? Math.min(...q.map(D)) : q.map(D).reduce((t, x) => t + x, 0) / q.length,
      flatTop: !wallTopProfile(p, e, z1, ...wallSpan(p, e)),
    });
  }
  /** tratti di un bordo orizzontale (quota z) di una faccia non coperti da una faccia contigua sopra o sotto */
  const openEdge = (id: string, z: number, side: 'sotto' | 'sopra', a: number, b: number) => {
    const me = faces.get(id)!;
    let segs: [number, number][] = [[Math.min(a, b), Math.max(a, b)]];
    for (const [oid, o] of faces) {
      if (oid === id || Math.abs(o.d - me.d) > 0.05) continue;
      const touches = side === 'sotto' ? o.flatTop && Math.abs(o.z1 - z) < 0.01 : Math.abs(o.z0 - z) < 0.01;
      if (!touches) continue;
      segs = segs.flatMap(([x, y]) => (o.u1 <= x || o.u0 >= y ? [[x, y] as [number, number]] : ([[x, o.u0], [o.u1, y]] as [number, number][]).filter(([m, n]) => n - m > 1e-4)));
    }
    return segs;
  };

  for (const e of p.elements) {
    // nelle sezioni si vede solo ciò che sta oltre il piano, entro la profondità di vista
    const ds = e.kind === 'opening' ? [] : elementPoints(e).map(D);
    if (ds.length && frame.near !== undefined && Math.max(...ds) < frame.near) continue;
    if (ds.length && frame.far !== undefined && Math.min(...ds) > frame.far) continue;
    const lvl = 'levelId' in e ? byId(p.levels, e.levelId) : undefined;
    if (!lvl) continue;
    if (e.kind === 'wall') {
      // muro interamente nascosto da un muro più vicino: non si disegna (niente residui di linee)
      const me = faces.get(e.id);
      if (
        me &&
        [...faces].some(
          ([oid, o]) => oid !== e.id && o.d < me.d - 0.01 && o.u0 <= me.u0 + 1e-3 && o.u1 >= me.u1 - 1e-3 && o.z0 <= me.z0 + 1e-3 && o.z1 >= me.z1 - 1e-3,
        )
      )
        continue;
      const quad = wallOutline(wallGeom(p, e));
      const us = quad.map(U);
      const u0 = Math.min(...us);
      const u1 = Math.max(...us);
      const z0 = lvl.elevation;
      const z1 = z0 + wallHeight(p, e);
      const facing = Math.abs(dot(norm(sub(e.b, e.a)), u)) > 0.7;
      const holes: string[] = [];
      const glass: React.ReactNode[] = [];
      const g = wallGeom(p, e);
      if (facing) {
        for (const s of openingSpans(p, e)) {
          const a = U({ x: e.a.x + (e.b.x - e.a.x) * (s.start / wallLength(e)), y: e.a.y + (e.b.y - e.a.y) * (s.start / wallLength(e)) });
          const b = U({ x: e.a.x + (e.b.x - e.a.x) * (s.end / wallLength(e)), y: e.a.y + (e.b.y - e.a.y) * (s.end / wallLength(e)) });
          const x0 = Math.min(a, b);
          const x1 = Math.max(a, b);
          const h0 = z0 + s.type.sill;
          const h1 = Math.min(z1, h0 + s.type.height);
          const US = (sv: number) => U({ x: e.a.x + g.d.x * sv, y: e.a.y + g.d.y * sv });
          // contorno del vano: davanzale, stipiti e testa (piana o ad arco), entro la cima del muro
          const arched = archRise(s.type) > 1e-6;
          const vano = [
            `${US(s.start)},${Z(h0)}`,
            `${US(s.end)},${Z(h0)}`,
            ...archProfile(s.type)
              .reverse()
              .map((q) => `${US(Math.min(s.end, Math.max(s.start, s.opening.offset + q.x)))},${Z(Math.min(z1, h0 + q.h))}`),
          ];
          holes.push(`M${vano.join(' L')} Z`);
          const isDoor = s.type.category === 'porta';
          const spec = fixtureSpec(p, e, g, s.opening, s.type);
          const tf = spec.ct + spec.tf; // telaio in vista
          const dash = `${1.2 * mm} ${0.8 * mm}`;
          if (spec.bare) {
            // vano senza porta: si vede solo il contorno del varco
            glass.push(
              <g key={s.opening.id}>
                <polygon points={vano.join(' ')} className="ev-frame" fill="none" strokeWidth={0.25 * mm} />
                {spec.hasThreshold && <line x1={x0} y1={Z(h0)} x2={x1} y2={Z(h0)} className="ev-frame" strokeWidth={0.35 * mm} />}
              </g>,
            );
            continue;
          }
          glass.push(
            <g key={s.opening.id}>
              {/* telaio fisso */}
              <polygon points={vano.join(' ')} className="ev-frame-fill" strokeWidth={0.25 * mm} />
              {arched &&
                (() => {
                  // lunetta fissa sopra l'imposta: traverso all'imposta e vetro dentro il telaio
                  const zs = h0 + springHeight(s.type) + tf / 2;
                  const arc = archProfile(s.type, tf).map((q) => `${US(s.opening.offset + q.x)},${Z(Math.min(h1 - tf, Math.max(zs, h0 + q.h)))}`);
                  return arc.length > 2 && <polygon points={arc.join(' ')} className="ev-glass" strokeWidth={0.13 * mm} />;
                })()}
              {leafSpans(spec, s.start, s.end).map((l, i) => {
                const la = US(l.s0);
                const lb = US(l.s1);
                const lx0 = Math.min(la, lb);
                const lx1 = Math.max(la, lb);
                const lz0 = isDoor ? h0 + 0.01 : h0 + tf;
                // sotto un arco le ante arrivano al traverso dell'imposta
                const lz1 = arched ? Math.min(h1, h0 + springHeight(s.type)) - tf / 2 : h1 - tf;
                const prof = isDoor ? 0 : 0.06; // profilo dell'anta attorno al vetro
                const hx = US(l.hinge);
                const fx = US(l.free);
                return (
                  <g key={i}>
                    <rect x={lx0} y={Z(lz1)} width={lx1 - lx0} height={lz1 - lz0} className={isDoor ? 'ev-door' : 'ev-frame-fill'} strokeWidth={0.18 * mm} />
                    {!isDoor && (
                      <rect x={lx0 + prof} y={Z(lz1 - prof)} width={Math.max(0, lx1 - lx0 - 2 * prof)} height={Math.max(0, lz1 - lz0 - 2 * prof)} className="ev-glass" strokeWidth={0.13 * mm} />
                    )}
                    {/* simbolo d'apertura: il vertice indica il lato delle cerniere */}
                    <polyline
                      points={`${fx},${Z(lz1)} ${hx},${Z((lz0 + lz1) / 2)} ${fx},${Z(lz0)}`}
                      className="ev-swing"
                      strokeWidth={0.13 * mm}
                      strokeDasharray={dash}
                    />
                  </g>
                );
              })}
              {spec.hasSill && <rect x={x0 - 0.03} y={Z(h0)} width={x1 - x0 + 0.06} height={0.04} className="ev-sill" strokeWidth={0.25 * mm} />}
              {spec.hasThreshold && <line x1={x0} y1={Z(h0)} x2={x1} y2={Z(h0)} className="ev-frame" strokeWidth={0.35 * mm} />}
            </g>,
          );
        }
      }
      // timpano: la sommità del muro segue l'intradosso delle falde
      const L = wallLength(e);
      const prof = wallTopProfile(p, e, z1, ...wallSpan(p, e));
      // muro visto di taglio: conta solo la parte oltre il piano di sezione (la cima può salire o scendere
      // sotto le falde, e la parte davanti al piano è stata tolta)
      const visTop = (() => {
        if (!prof) return z1;
        const Lw = wallLength(e) || 1;
        const vis = prof.filter((q) => frame.near === undefined || D({ x: e.a.x + ((e.b.x - e.a.x) * q.s) / Lw, y: e.a.y + ((e.b.y - e.a.y) * q.s) / Lw }) >= frame.near - 1e-6);
        return vis.length ? Math.max(...vis.map((q) => q.z)) : z1;
      })();
      // contorno: fianchi e sommità sempre; base e sommità piana solo dove non c'è un muro contiguo
      const sw = 0.25 * mm;
      const lines: React.ReactNode[] = [];
      const hLine = (a: number, b: number, z: number, key: string) => <line key={key} x1={a} y1={Z(z)} x2={b} y2={Z(z)} className="ev-wall-line" strokeWidth={sw} />;
      const bottom = openEdge(e.id, z0, 'sotto', u0, u1);
      bottom.forEach(([a, b], i) => lines.push(hLine(a, b, z0, `b${i}`)));
      // con un muro contiguo sotto, la campitura scende di 2 cm: niente fessura sul giunto
      const covered = bottom.reduce((t, [a, b]) => t + b - a, 0) < u1 - u0 - 1e-3;
      const zf = covered ? z0 - Math.max(0.02, 0.6 * mm) : z0;
      let outer = `M${u0},${Z(zf)} L${u1},${Z(zf)} L${u1},${Z(z1)} L${u0},${Z(z1)} Z`;
      if (prof && facing) {
        const at = (sv: number) => U({ x: e.a.x + ((e.b.x - e.a.x) * sv) / L, y: e.a.y + ((e.b.y - e.a.y) * sv) / L });
        const first = at(prof[0].s);
        const last = at(prof[prof.length - 1].s);
        outer = `M${first},${Z(zf)} L${last},${Z(zf)} ` + [...prof].reverse().map((q) => `L${at(q.s)},${Z(q.z)}`).join(' ') + ' Z';
      } else if (prof) {
        const zmax = visTop;
        outer = `M${u0},${Z(zf)} L${u1},${Z(zf)} L${u1},${Z(zmax)} L${u0},${Z(zmax)} Z`;
      }
      if (prof && facing) {
        const at = (sv: number) => U({ x: e.a.x + ((e.b.x - e.a.x) * sv) / L, y: e.a.y + ((e.b.y - e.a.y) * sv) / L });
        const top = prof.map((q) => `${at(q.s)},${Z(q.z)}`);
        lines.push(
          <polyline
            key="t"
            points={[`${at(prof[0].s)},${Z(zf)}`, ...top, `${at(prof[prof.length - 1].s)},${Z(zf)}`].join(' ')}
            className="ev-wall-line"
            strokeWidth={sw}
            fill="none"
          />,
        );
      } else {
        const zt = prof ? visTop : z1;
        lines.push(<line key="l" x1={u0} y1={Z(zf)} x2={u0} y2={Z(zt)} className="ev-wall-line" strokeWidth={sw} />);
        lines.push(<line key="r" x1={u1} y1={Z(zf)} x2={u1} y2={Z(zt)} className="ev-wall-line" strokeWidth={sw} />);
        if (prof) lines.push(hLine(u0, u1, zt, 't'));
        else openEdge(e.id, zt, 'sopra', u0, u1).forEach(([a, b], i) => lines.push(hLine(a, b, zt, `t${i}`)));
      }
      items.push({
        depth: faces.get(e.id)?.d ?? Math.min(...quad.map(D)),
        node: (
          <g key={e.id}>
            <path d={[outer, ...holes].join(' ')} fillRule="evenodd" className="ev-wall" style={{ stroke: "none" }} />
            {lines}
            {glass}
          </g>
        ),
      });
    } else if (e.kind === 'slab') {
      const t = byId(p.catalog.slab, e.typeId);
      const outline = slabOutline(p, e);
      const us = outline.map(U);
      const th = t?.thickness ?? 0.3;
      // solaio interamente dietro un muro più vicino: non si vede
      {
        const sd = Math.min(...outline.map(D));
        const su0 = Math.min(...us);
        const su1 = Math.max(...us);
        const sz1 = lvl.elevation;
        const sz0 = sz1 - th;
        // coperto dall'unione dei muri più vicini che lo contengono in quota
        let segs: [number, number][] = [[su0, su1]];
        for (const o of faces.values())
          if (o.d < sd - 0.005 && o.z0 <= sz0 + 1e-3 && o.z1 >= sz1 - 1e-3)
            segs = segs.flatMap(([x, y]) => (o.u1 <= x || o.u0 >= y ? [[x, y] as [number, number]] : ([[x, o.u0], [o.u1, y]] as [number, number][]).filter(([m, n]) => n - m > 1e-3)));
        if (!segs.length) continue;
      }
      items.push({
        depth: Math.min(...outline.map(D)) - 0.01,
        node: (
          <rect
            key={e.id}
            x={Math.min(...us)}
            y={Z(lvl.elevation)}
            width={Math.max(...us) - Math.min(...us)}
            height={th}
            className="ev-slab"
            strokeWidth={0.25 * mm}
          />
        ),
      });
    } else if (e.kind === 'column') {
      // ingombro reale del pilastro, come in pianta
      const q = columnQuad(e, byId(p.catalog.column, e.typeId));
      const us = q.map(U);
      items.push({
        depth: Math.min(...q.map(D)),
        node: <rect key={e.id} x={Math.min(...us)} y={Z(lvl.elevation + lvl.height)} width={Math.max(...us) - Math.min(...us)} height={lvl.height} className="ev-wall" strokeWidth={0.25 * mm} />,
      });
    } else if (e.kind === 'beam') {
      const t = byId(p.catalog.beam, e.typeId);
      const h = t?.height ?? 0.4;
      const top = lvl.elevation + lvl.height;
      // ingombro reale della trave (larghezza compresa), centrato sull'asse come in pianta
      const q = wallSegmentQuad(e as unknown as Wall, t?.width ?? 0.3, 0, Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y));
      const us = q.map(U);
      items.push({
        depth: Math.min(...q.map(D)),
        node: <rect key={e.id} x={Math.min(...us)} y={Z(top)} width={Math.max(...us) - Math.min(...us)} height={h} className="ev-wall" strokeWidth={0.25 * mm} />,
      });
    } else if (e.kind === 'roof') {
      const t = byId(p.catalog.roof, e.typeId);
      const th = t?.thickness ?? 0.3;
      const base = lvl.elevation + lvl.height;
      const g = roofGeom(p, e);
      if (!g) continue;
      // nelle sezioni conta solo ciò che sta oltre il piano: le falde si tagliano alla profondità near
      const nearK0 = frame.near !== undefined ? -frame.near - dot(frame.origin, frame.depth) : null;
      const cut = (poly: Vec2[]) => (nearK0 === null ? poly : clipHalf(poly, frame.depth, nearK0));
      const P2 = (q: Vec2, z: number) => `${U(q)},${Z(z)}`;
      if (e.shape === 'piana') {
        const ol = cut(g.outline);
        if (!ol.length) continue;
        const us = ol.map(U);
        items.push({
          depth: Math.min(...ol.map(D)) - 0.02,
          node: <rect key={e.id} x={Math.min(...us)} y={Z(base + th)} width={Math.max(...us) - Math.min(...us)} height={th} className="ev-roof" strokeWidth={0.35 * mm} />,
        });
        continue;
      }
      // falde viste: quelle che salgono allontanandosi da chi guarda (estradosso, th sopra l'intradosso)
      g.fragments.forEach((fr, k) => {
        // falde che salgono allontanandosi: se ne vede l'estradosso; nelle sezioni anche quelle che scendono
        // allontanandosi, viste da sotto (intradosso): sporti e gronde oltre il piano di taglio
        const facingUp = dot(fr.plane.n, frame.depth) > 1e-6;
        if (!facingUp && frame.near === undefined) return;
        const lift = facingUp ? th : 0;
        // la falda si divide dove passano i muri: la parte sopra l'edificio sta dietro le facciate,
        // lo sporto di gronda davanti, e copre la cima dei muri
        const inner = g.pieces.map((pc) => clipConvex(fr.poly, pc.poly)).filter((x) => x.length >= 3);
        const outer = g.pieces.reduce<Vec2[][]>((acc, pc) => acc.flatMap((x) => subtractConvex(x, pc.poly)), [fr.poly]);
        const draw = (poly0: Vec2[], key: string, front: boolean) => {
          const poly = cut(poly0);
          if (poly.length < 3) return;
          items.push({
            depth: front ? Math.min(...poly.map(D)) - 0.02 : poly.reduce((t, q) => t + D(q), 0) / poly.length,
            node: (
              <polygon
                key={key}
                points={poly.map((q) => P2(q, planeAt(fr.plane, q) + lift)).join(' ')}
                className="ev-roof"
                // tra le due parti non si disegna il bordo: si vede una falda sola (lo stile batte l'attributo)
                style={{ stroke: 'none' }}
              />
            ),
          });
        };
        inner.forEach((x, i) => draw(x, `${e.id}f${k}i${i}`, false));
        outer.forEach((x, i) => draw(x, `${e.id}f${k}o${i}`, true));
        // contorno della falda intera, sopra tutto ciò che sta dietro
        const whole = cut(fr.poly);
        if (whole.length >= 3)
          items.push({
            depth: Math.min(...whole.map(D)) - 0.015,
            node: <polygon key={`${e.id}f${k}c`} points={whole.map((q) => P2(q, planeAt(fr.plane, q) + lift)).join(' ')} fill="none" className="ev-roof-outline" style={{ fill: 'none' }} strokeWidth={0.25 * mm} />,
          });
      });
      // bordi verso chi guarda: fascia di gronda e profilo delle falde sui timpani (spessore th)
      const ol = g.outline;
      const ccwSign = ol.reduce((s, a, k) => s + a.x * ol[(k + 1) % ol.length].y - ol[(k + 1) % ol.length].x * a.y, 0) >= 0 ? 1 : -1;
      const vertices = g.fragments.flatMap((fr) => fr.poly);
      ol.forEach((a, k) => {
        const b = ol[(k + 1) % ol.length];
        const L = Math.hypot(b.x - a.x, b.y - a.y);
        if (L < 1e-6) return;
        const outward = { x: ((b.y - a.y) / L) * ccwSign, y: (-(b.x - a.x) / L) * ccwSign };
        if (dot(outward, frame.depth) > -1e-6) return;
        // punti di rottura del profilo lungo il bordo: i vertici delle falde che ci stanno sopra
        const ts = new Set<number>([0, 1]);
        for (const v of vertices) {
          const tt = ((v.x - a.x) * (b.x - a.x) + (v.y - a.y) * (b.y - a.y)) / (L * L);
          const off = Math.abs((v.x - a.x) * (b.y - a.y) - (v.y - a.y) * (b.x - a.x)) / L;
          if (off < 1e-5 && tt > 1e-6 && tt < 1 - 1e-6) ts.add(+tt.toFixed(6));
        }
        const pts = [...ts]
          .sort((x, y) => x - y)
          .map((tt) => ({ x: a.x + (b.x - a.x) * tt, y: a.y + (b.y - a.y) * tt }))
          .filter((q) => nearK0 === null || dot(q, frame.depth) + nearK0 >= -1e-9);
        if (pts.length < 2) return;
        // quota sul bordo: appena dentro la copertura, dove la falda è definita
        const zAt = (q: Vec2) => roofUndersideAt(p, { x: q.x - outward.x * 1e-4, y: q.y - outward.y * 1e-4 }, base) ?? base;
        const bottom = pts.map((q) => P2(q, zAt(q)));
        const top = [...pts].reverse().map((q) => P2(q, zAt(q) + th));
        items.push({
          depth: Math.min(...pts.map(D)) - 0.01,
          node: <polygon key={`${e.id}e${k}`} points={[...bottom, ...top].join(' ')} className="ev-roof ev-roof-edge" strokeWidth={0.35 * mm} />,
        });
      });
    }
  }

  // Disegno dal più lontano al più vicino
  items.sort((a, b) => b.depth - a.depth);
  const levels = [
    ...sortedLevels(p).map((l) => ({ id: l.id, z: l.elevation, name: l.kind === 'copertura' ? `${l.name} · imposta` : l.name })),
    // colmo della copertura più alta
    ...(() => {
      let ridge = -Infinity;
      for (const e of p.elements) {
        if (e.kind !== 'roof' || e.shape === 'piana') continue;
        ridge = Math.max(ridge, roofTop(p, e));
      }
      return isFinite(ridge) ? [{ id: 'colmo', z: ridge, name: 'Colmo' }] : [];
    })(),
  ];
  const gl = p.site.groundLevel;

  return (
    <g className="elev">
      {items.map((i) => i.node)}
      <line x1={ext.min - 2} y1={Z(gl)} x2={ext.max + 2} y2={Z(gl)} className="ev-ground" strokeWidth={0.7 * mm} />
      {levels.map((l) => (
        <g key={l.id} className="ev-level">
          <line x1={ext.max + 0.5} y1={Z(l.z)} x2={ext.max + 0.5 + 14 * mm} y2={Z(l.z)} strokeWidth={0.13 * mm} />
          <path
            d={`M${ext.max + 1.5 * mm},${Z(l.z)} l${1.4 * mm},${-1.6 * mm} l${-2.8 * mm},0 z`}
            transform={`translate(${0.5 + 1.5 * mm} 0)`}
            className="ev-level-mark"
          />
          <text x={ext.max + 0.5 + 6 * mm} y={Z(l.z) - 1 * mm} fontSize={2 * mm * ts} className="ev-text">
            {fmtLevel(l.z)}
          </text>
          <text x={ext.max + 0.5 + 6 * mm} y={Z(l.z) + 2.6 * mm} fontSize={1.7 * mm * ts} className="ev-text ev-text-soft">
            {l.name}
          </text>
        </g>
      ))}
    </g>
  );
}

/** Altezza complessiva del disegno di prospetto (per l'impaginazione) */
export function elevationHeight(p: Project) {
  let top = 0;
  for (const e of p.elements) {
    const lvl = 'levelId' in e ? byId(p.levels, e.levelId) : undefined;
    if (!lvl) continue;
    const base = lvl.elevation + lvl.height;
    if (e.kind === 'roof') top = Math.max(top, (e.shape === 'piana' ? base : roofTop(p, e)) + 0.5);
    else top = Math.max(top, base);
  }
  return { top, bottom: Math.min(p.site.groundLevel, ...p.levels.map((l) => l.elevation)) - 0.6 };
}

