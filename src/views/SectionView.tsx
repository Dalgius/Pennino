// Sezione verticale generata dal modello.
// Ciò che sta oltre il piano è disegnato in vista (motore dei prospetti); ciò che il piano taglia
// (muri, solai, coperture, pilastri, travi, scale) è campito. Le aperture tagliate interrompono il muro.

import type { Project, SectionLine, Vec2, Wall } from '../model/types';
import { add, bbox, byId, columnQuad, dist, dot, mul, norm, openingSpans, perp, roofBase, roofOutline, roofEave, roofWithEave, roofRidgeRise, roofUndersideAt, slabHoles, stairLayout, flightQuad, flightProfile, LANDING_THICKNESS, slabOutline, sub, wallHeight, wallLength, wallSegmentQuad } from '../model/geometry';
import { fixtureSpec } from '../model/openings';
import { layerBands, wallGeom, wallOutline } from '../model/walls';
import { HatchDefs, hatchFill, hatchOf, mainHatch, structHatch, useHatchPrefix } from './hatch';
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

/** Nucleo strutturale: dal primo all'ultimo strato «struttura» (senza strati strutturali, tutto) */
function layerInCore(layers: { role: string }[], j: number) {
  const first = layers.findIndex((l) => l.role === 'struttura');
  if (first < 0) return true;
  let last = first;
  layers.forEach((l, i) => l.role === 'struttura' && (last = i));
  return j >= first && j <= last;
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
  // ordine di disegno: muri, poi solai (la loro struttura entra nei muri), poi il resto
  const wallCuts: React.ReactNode[] = [];
  const slabCuts: React.ReactNode[] = []; // struttura dei solai
  const structCuts: React.ReactNode[] = []; // pilastri e travi
  const finishCuts: React.ReactNode[] = []; // finiture dei solai, sopra la struttura
  // ingombri tagliati di pilastri e travi: interrompono le finiture d'intradosso dei solai
  const structSpans: { u0: number; u1: number; z0: number; z1: number }[] = [];
  for (const e of p.elements) {
    const lv = 'levelId' in e ? byId(p.levels, e.levelId) : undefined;
    if (!lv) continue;
    if (e.kind === 'column')
      cutIntervals(columnQuad(e, byId(p.catalog.column, e.typeId)), f).forEach(([u0, u1]) => structSpans.push({ u0, u1, z0: lv.elevation, z1: lv.elevation + lv.height }));
    else if (e.kind === 'beam') {
      const bt = byId(p.catalog.beam, e.typeId);
      const top = lv.elevation + lv.height;
      cutIntervals(wallSegmentQuad(e as unknown as Wall, bt?.width ?? 0.3, 0, dist(e.a, e.b)), f).forEach(([u0, u1]) =>
        structSpans.push({ u0, u1, z0: top - (bt?.height ?? 0.4), z1: top }),
      );
    }
  }
  const wallSpans: { u0: number; u1: number; z0: number; z1: number; c0: number; c1: number }[] = [];
  /** rivestimenti esterni dei muri che risalgono a coprire il bordo di una copertura senza sporto */
  const edgeCovers: { u0: number; u1: number }[] = [];
  /** copertura sopra il punto della traccia, impostata alla quota zTop: spessore e finiture d'intradosso */
  const roofOver = (u: number, zTop: number) => {
    const X = add(f.origin, mul(f.u, u));
    const under = roofUndersideAt(p, X, zTop);
    if (under === null) return null;
    for (const r of p.elements) {
      if (r.kind !== 'roof' || Math.abs(roofBase(p, r) - zTop) > 0.05) continue;
      const rt = byId(p.catalog.roof, r.typeId);
      const th = rt?.thickness ?? 0.3;
      const ls = rt?.layers ?? [];
      const tot = ls.reduce((a, l) => a + l.thickness, 0) || th;
      const last = ls.reduce((k, l, i) => (l.role === 'struttura' ? i : k), -1);
      const bottom = last >= 0 ? ls.slice(last + 1).reduce((a, l) => a + (l.thickness * th) / tot, 0) : 0;
      return { under, th, bottom };
    }
    return null;
  };
  const sw = 0.35 * mm;
  const hp = useHatchPrefix();
  const layered = mm < 0.08; // a scala ≥ 1:50 si vedono gli strati
  const polyPts = (q: [number, number][]) => q.map(([u, z]) => `${u},${Z(z)}`).join(' ');
  /** strato tagliato con il suo retino */
  const band = (key: string, q: [number, number][], fill: string, into: React.ReactNode[]) =>
    into.push(<polygon key={key} points={polyPts(q)} fill={fill} stroke={fill} strokeWidth={0.06 * mm} />);
  const outlineOf = (key: string, q: [number, number][], into: React.ReactNode[]) =>
    into.push(<polygon key={key} points={polyPts(q)} className="sc-outline" strokeWidth={sw} />);
  const rect = (key: string, u0: number, u1: number, z0: number, z1: number, cls = 'sc-cut') =>
    cuts.push(<rect key={key} x={Math.min(u0, u1)} y={Z(Math.max(z0, z1))} width={Math.abs(u1 - u0)} height={Math.abs(z1 - z0)} className={cls} strokeWidth={sw} />);

  // prima i muri: i solai ne usano l'ingombro per fermare le finiture
  const ordered = [...p.elements.filter((x) => x.kind === 'wall'), ...p.elements.filter((x) => x.kind !== 'wall')];
  for (const e of ordered) {
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
      // strati: lo scostamento o dall'asse cade in u = uX + o·k lungo la sezione
      const t = byId(p.catalog.wall, e.typeId);
      const cn = dot(f.u, g.n);
      let layerMap: ((o: number) => number) | null = null;
      if (layered && t && t.layers.length > 0 && Math.abs(cn) > 0.2) {
        const den = f.u.x * g.d.y - f.u.y * g.d.x;
        if (Math.abs(den) > 1e-9) {
          const r = sub(e.a, f.origin);
          const uX = (r.x * g.d.y - r.y * g.d.x) / den; // incrocio della traccia con l'asse del muro
          layerMap = (o: number) => uX + o / cn;
        }
      }
      const piece = (key: string, u0: number, u1: number, zb: number, zt0: number, zt1: number, underRoof = false) => {
        const topLin = (u: number) => (Math.abs(u1 - u0) < 1e-9 ? zt0 : zt0 + ((zt1 - zt0) * (u - u0)) / (u1 - u0));
        const quad = (a: number, b: number): [number, number][] => [
          [a, zb],
          [b, zb],
          [b, topLin(b)],
          [a, topLin(a)],
        ];
        if (!layerMap || !t) {
          wallSpans.push({ u0: Math.min(u0, u1), u1: Math.max(u0, u1), z0: zb, z1: Math.max(zt0, zt1), c0: Math.min(u0, u1), c1: Math.max(u0, u1) });
          if (layered && t) band(`${key}h`, quad(u0, u1), hatchFill(hp, mainHatch(t.layers)), wallCuts);
          else return wallCuts.push(<polygon key={key} points={polyPts(quad(u0, u1))} className="sc-cut" strokeWidth={sw} />);
          return outlineOf(`${key}o`, quad(u0, u1), wallCuts);
        }
        const lo = Math.min(u0, u1);
        const hi = Math.max(u0, u1);
        const bands = layerBands(g, t.layers);
        const coreIdx = bands.map((_, j) => j).filter((j) => layerInCore(t.layers, j));
        const coreUs = coreIdx.flatMap((j) => [layerMap!(bands[j].o0), layerMap!(bands[j].o1)]);
        const c0 = coreUs.length ? Math.max(lo, Math.min(...coreUs)) : lo;
        const c1 = coreUs.length ? Math.min(hi, Math.max(...coreUs)) : hi;
        wallSpans.push({ u0: lo, u1: hi, z0: zb, z1: Math.max(zt0, zt1), c0, c1 });
        // raccordo con la copertura (solo per il tratto che arriva sotto la copertura)
        const zTopWall = z0 + H;
        const atRoof = underRoof;
        const uOutFace = layerMap(g.extSign * g.half);
        const outDir = Math.sign(uOutFace - layerMap(0)) || 1;
        // la copertura sporge oltre la faccia esterna? se no, il rivestimento esterno ne copre il bordo
        const overhang = atRoof && roofUndersideAt(p, add(f.origin, mul(f.u, uOutFace + outDir * 0.03)), zTopWall) !== null;
        const extra = (j: number, u: number) => {
          if (!atRoof) return 0;
          const r = roofOver(u, zTopWall);
          if (!r) return 0;
          if (layerInCore(t.layers, j)) return r.bottom; // la struttura attraversa le finiture d'intradosso
          const mid = (bands[j].o0 + bands[j].o1) / 2;
          const exterior = Math.sign(mid) === g.extSign;
          return exterior && !overhang ? r.th : 0; // il cappotto riveste il bordo della copertura
        };
        const pieces: { a: number; b: number; ta: number; tb: number; j: number }[] = [];
        bands.forEach((bd, j) => {
          const a = Math.max(lo, Math.min(layerMap!(bd.o0), layerMap!(bd.o1)));
          const b = Math.min(hi, Math.max(layerMap!(bd.o0), layerMap!(bd.o1)));
          if (b - a <= 1e-4) return;
          const ta = topLin(a) + extra(j, a);
          const tb = topLin(b) + extra(j, b);
          pieces.push({ a, b, ta, tb, j });
          if (!layerInCore(t.layers, j) && extra(j, (a + b) / 2) > (roofOver((a + b) / 2, zTopWall)?.bottom ?? 0) + 1e-6) edgeCovers.push({ u0: a, u1: b });
          band(
            `${key}l${j}`,
            [
              [a, zb],
              [b, zb],
              [b, tb],
              [a, ta],
            ],
            hatchFill(hp, hatchOf(t.layers[j])),
            wallCuts,
          );
        });
        pieces.sort((x, y) => x.a - y.a);
        // separazioni tra gli strati, fino al più basso dei due strati adiacenti
        for (let k = 0; k + 1 < pieces.length; k++) {
          const u = pieces[k].b;
          const zt = Math.min(pieces[k].tb, pieces[k + 1].ta);
          wallCuts.push(<line key={`${key}s${k}`} x1={u} y1={Z(zb)} x2={u} y2={Z(zt)} className="sc-layer-line" strokeWidth={0.1 * mm} />);
        }
        // contorno: base, fianchi e sommità a gradini
        const outline: [number, number][] = [[lo, zb], [hi, zb]];
        for (let k = pieces.length - 1; k >= 0; k--) outline.push([pieces[k].b, pieces[k].tb], [pieces[k].a, pieces[k].ta]);
        outlineOf(`${key}o`, outline, wallCuts);
      };
      ivs.forEach(([u0, u1], i) => {
        if (!hit) return piece(`${e.id}${i}`, u0, u1, z0, topAt(u0), topAt(u1), true);
        const h0 = z0 + hit.type.sill;
        const h1 = Math.min(z0 + H, h0 + hit.type.height);
        if (h0 > z0 + 1e-3) piece(`${e.id}${i}b`, u0, u1, z0, h0, h0);
        // sopra l'architrave il muro arriva fino alla copertura
        piece(`${e.id}${i}t`, u0, u1, h1, topAt(u0), topAt(u1), true);
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
      const st = byId(p.catalog.slab, e.typeId);
      if (!layered || !st?.layers?.length) {
        ivs.forEach(([u0, u1], i) => rect(`${e.id}${i}`, u0, u1, z0 - th, z0));
        continue;
      }
      // strati dall'alto: la struttura entra nei muri, le finiture si fermano al loro filo
      const tot = st.layers.reduce((a, l) => a + l.thickness, 0) || th;
      const k = th / tot;
      const lastCoreS = st.layers.reduce((q, l, i) => (l.role === 'struttura' ? i : q), -1);
      let zt = z0;
      st.layers.forEach((l, j) => {
        const zb = zt - l.thickness * k;
        const core = layerInCore(st.layers!, j);
        ivs.forEach(([u0, u1], i) => {
          let segs: [number, number][] = [[u0, u1]];
          // finiture: si fermano al filo dei muri; quelle d'intradosso anche sotto pilastri e travi
          const stops = core ? [] : [...wallSpans, ...(lastCoreS >= 0 && j > lastCoreS ? structSpans : [])];
          for (const w of stops)
            if (w.z1 > zb + 1e-4 && w.z0 < zt - 1e-4)
              segs = segs.flatMap(([a, b]) => (w.u1 <= a || w.u0 >= b ? [[a, b] as [number, number]] : ([[a, w.u0], [w.u1, b]] as [number, number][]).filter(([x, y]) => y - x > 1e-4)));
          const into = core ? slabCuts : finishCuts;
          segs.forEach(([a, b], m) => {
            const q: [number, number][] = [
              [a, zb],
              [b, zb],
              [b, zt],
              [a, zt],
            ];
            band(`${e.id}l${j}-${i}-${m}`, q, hatchFill(hp, hatchOf(l)), into);
            into.push(<polygon key={`${e.id}o${j}-${i}-${m}`} points={polyPts(q)} className="sc-layer-outline" strokeWidth={0.1 * mm} />);
          });
        });
        zt = zb;
      });
    } else if (e.kind === 'column' || e.kind === 'beam') {
      // pilastri e travi: retino del materiale, tra la struttura dei solai e le loro finiture
      const ct = e.kind === 'column' ? byId(p.catalog.column, e.typeId) : byId(p.catalog.beam, e.typeId);
      const bt = e.kind === 'beam' ? byId(p.catalog.beam, e.typeId) : undefined;
      const quad = e.kind === 'column' ? columnQuad(e, byId(p.catalog.column, e.typeId)) : wallSegmentQuad(e as unknown as Wall, bt?.width ?? 0.3, 0, dist(e.a, e.b));
      const zA = e.kind === 'column' ? z0 : z0 + lvl.height - (bt?.height ?? 0.4);
      const zB = z0 + lvl.height;
      cutIntervals(quad, f).forEach(([u0, u1], i) => {
        const q: [number, number][] = [
          [u0, zA],
          [u1, zA],
          [u1, zB],
          [u0, zB],
        ];
        if (!layered) return structCuts.push(<polygon key={`${e.id}${i}`} points={polyPts(q)} className="sc-cut" strokeWidth={sw} />);
        band(`${e.id}${i}h`, q, hatchFill(hp, structHatch(ct)), structCuts);
        outlineOf(`${e.id}${i}o`, q, structCuts);
      });
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
      const rl = layered && t?.layers?.length ? t.layers : null;
      const tot = rl ? rl.reduce((a, l) => a + l.thickness, 0) || th : th;
      /** strati della copertura tra il profilo inferiore zb(u) e quello superiore zb(u) + th, dall'alto */
      const lastCore = rl ? rl.reduce((k, l, i) => (l.role === 'struttura' ? i : k), -1) : -1;
      const roofBands = (key: string, us: number[], zbot: (u: number) => number) => {
        // interpolazione del profilo inferiore tra i punti campionati
        const zAt = (u: number) => {
          for (let i = 0; i + 1 < us.length; i++)
            if ((u - us[i]) * (u - us[i + 1]) <= 0) {
              const t = Math.abs(us[i + 1] - us[i]) < 1e-9 ? 0 : (u - us[i]) / (us[i + 1] - us[i]);
              return zbot(us[i]) + (zbot(us[i + 1]) - zbot(us[i])) * t;
            }
          return zbot(u);
        };
        const lo = Math.min(...us);
        const hi = Math.max(...us);
        let c = 0;
        rl!.forEach((l, j) => {
          const c1 = c + (l.thickness * th) / tot;
          // finiture d'intradosso (sotto la struttura): si interrompono sopra la struttura dei muri
          let segs: [number, number][] = [[lo, hi]];
          // il rivestimento esterno del muro che sale a coprirne il bordo ferma la copertura
          for (const w of edgeCovers)
            segs = segs.flatMap(([a, b]) => (w.u1 <= a || w.u0 >= b ? [[a, b] as [number, number]] : ([[a, w.u0], [w.u1, b]] as [number, number][]).filter(([x, y]) => y - x > 1e-4)));
          if (lastCore >= 0 && j > lastCore)
            for (const w of wallSpans)
              if (Math.abs(w.z1 - zAt((w.c0 + w.c1) / 2)) < 0.6)
                segs = segs.flatMap(([a, b]) => (w.c1 <= a || w.c0 >= b ? [[a, b] as [number, number]] : ([[a, w.c0], [w.c1, b]] as [number, number][]).filter(([x, y]) => y - x > 1e-4)));
          segs.forEach(([a, b], m) => {
            const xs = [a, ...us.filter((u) => u > a + 1e-6 && u < b - 1e-6).sort((x, y) => x - y), b];
            const top = xs.map((u): [number, number] => [u, zAt(u) + th - c]);
            const bot = [...xs].reverse().map((u): [number, number] => [u, zAt(u) + th - c1]);
            band(`${key}l${j}-${m}`, [...top, ...bot], hatchFill(hp, hatchOf(l)), cuts);
            cuts.push(<polygon key={`${key}o${j}-${m}`} points={polyPts([...top, ...bot])} className="sc-layer-outline" strokeWidth={0.1 * mm} />);
          });
          c = c1;
        });
        // estremi della copertura ristretti dai rivestimenti che ne coprono il bordo
        let olo = lo;
        let ohi = hi;
        for (const w of edgeCovers) {
          if (w.u0 <= olo + 1e-6 && w.u1 > olo) olo = w.u1;
          if (w.u1 >= ohi - 1e-6 && w.u0 < ohi) ohi = w.u0;
        }
        us = [olo, ...us.filter((u) => u > olo + 1e-6 && u < ohi - 1e-6), ohi];
        const topLine = [...us].reverse().map((u): [number, number] => [u, zAt(u) + th]);
        if (lastCore >= 0 && lastCore < rl!.length - 1) {
          // con finiture d'intradosso il bordo inferiore è già dato dagli strati (interrotti sui muri)
          const ends: [number, number][] = [[us[us.length - 1], zAt(us[us.length - 1])], ...topLine, [us[0], zAt(us[0])]];
          cuts.push(<polyline key={`${key}O`} points={polyPts(ends)} className="sc-outline" strokeWidth={sw} />);
        } else outlineOf(`${key}O`, [...us.map((u): [number, number] => [u, zAt(u)]), ...topLine], cuts);
      };
      if (e.shape === 'piana') {
        cutIntervals(roofOutline(roofWithEave(p, e)), f).forEach(([u0, u1], i) =>
          rl ? roofBands(`${e.id}${i}`, [u0, u1], () => base) : rect(`${e.id}${i}`, u0, u1, base, base + th),
        );
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
        if (rl) return roofBands(`${e.id}${i}`, us, zb);
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
      <HatchDefs prefix={hp} u={mm} />
      {views.map((v) => v.node)}
      {/* terreno sezionato */}
      <rect x={ext.min} y={Z(gl)} width={ext.max - ext.min} height={0.8} className="sc-earth" />
      <line x1={ext.min} y1={Z(gl)} x2={ext.max} y2={Z(gl)} className="ev-ground" strokeWidth={0.7 * mm} />
      {wallCuts}
      {slabCuts}
      {structCuts}
      {finishCuts}
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
