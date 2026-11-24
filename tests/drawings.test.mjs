// Test dei disegni: prospetti, sezioni e piante prodotti come SVG e controllati nella loro geometria.
// Proteggono le correzioni fatte guardando i disegni (gronda sopra i muri, angoli, sezioni sotto le
// falde, cifre delle quote, scale coperte dal solaio). Esecuzione: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(new URL('../package.json', import.meta.url));
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const server = await createServer({ root, logLevel: 'error', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
const { ElevationView } = await server.ssrLoadModule('/src/views/ElevationView.tsx');
const { SectionView } = await server.ssrLoadModule('/src/views/SectionView.tsx');
const { PlanView } = await server.ssrLoadModule('/src/views/PlanView.tsx');
const { SheetView, PAPER } = await server.ssrLoadModule('/src/views/SheetView.tsx');
const { sampleProject } = await server.ssrLoadModule('/src/model/defaults.ts');
const G = await server.ssrLoadModule('/src/model/geometry.ts');
const R = await server.ssrLoadModule('/src/model/roofs.ts');
const O = await server.ssrLoadModule('/src/model/openings.ts');

const L1 = 'lvl_p1';
const MM = 0.1; // scala 1:100

// ───────── Lettura dell'SVG prodotto ─────────

/** Elementi grafici nell'ordine in cui sono disegnati (chi viene dopo copre chi viene prima) */
function parse(svg) {
  const out = [];
  const re = /<(polygon|polyline|path|line|rect|text)\b([^>]*?)\/?>(?:([^<]*)<\/text>)?/g;
  let m;
  let i = 0;
  while ((m = re.exec(svg))) {
    const attrs = {};
    for (const a of m[2].matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
    const el = { i: i++, tag: m[1], cls: attrs.class ?? '', attrs, text: m[3] ?? '', pts: [] };
    const nums = (s) => (s.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g) ?? []).map(Number);
    if (m[1] === 'polygon' || m[1] === 'polyline') {
      const v = nums(attrs.points ?? '');
      for (let k = 0; k + 1 < v.length; k += 2) el.pts.push({ x: v[k], y: v[k + 1] });
    } else if (m[1] === 'path') {
      // solo il primo sottopercorso (il contorno; gli altri sono i fori delle aperture)
      const first = (attrs.d ?? '').split(/Z/i)[0];
      const v = nums(first);
      for (let k = 0; k + 1 < v.length; k += 2) el.pts.push({ x: v[k], y: v[k + 1] });
    } else if (m[1] === 'line') el.pts.push({ x: +attrs.x1, y: +attrs.y1 }, { x: +attrs.x2, y: +attrs.y2 });
    else if (m[1] === 'rect') {
      const x = +attrs.x;
      const y = +attrs.y;
      el.pts.push({ x, y }, { x: x + +attrs.width, y: y + +attrs.height });
    } else if (m[1] === 'text') el.pts.push({ x: +attrs.x, y: +attrs.y });
    if (el.pts.length) {
      el.box = {
        x0: Math.min(...el.pts.map((q) => q.x)),
        x1: Math.max(...el.pts.map((q) => q.x)),
        y0: Math.min(...el.pts.map((q) => q.y)),
        y1: Math.max(...el.pts.map((q) => q.y)),
      };
    }
    out.push(el);
  }
  return out;
}

const svgOf = (node) => parse(renderToStaticMarkup(React.createElement('svg', null, node)));
const elevation = (p, direction) => svgOf(React.createElement(ElevationView, { project: p, direction, mm: MM }));
const section = (p, s) => svgOf(React.createElement(SectionView, { project: p, section: s, mm: MM }));
const plan = (p, levelId, extra = {}) => svgOf(React.createElement(PlanView, { project: p, levelId, mm: MM, showDimensions: true, ...extra }));

/** Punto dentro un poligono (pari-dispari) */
function inside(q, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > q.y !== b.y > q.y && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}
/** Il punto è coperto da qualche falda disegnata dopo l'elemento i? */
// (solo le falde e le fasce campite: il contorno senza riempimento non copre)
const isRoofFill = (r) => r.tag === 'polygon' && r.pts.length >= 3 && r.cls.split(/\s+/).includes('ev-roof') && !/ev-roof-outline/.test(r.cls);
const coveredAfter = (els, i, q) => els.some((r) => r.i > i && isRoofFill(r) && inside(q, r.pts));

/** Parti di muro (pareti viste in prospetto) */
const walls = (els) => els.filter((e) => e.tag === 'path' && /\bev-wall\b/.test(e.cls) && e.box);

// ───────── Prospetti ─────────

test('prospetti: la cima dei muri sotto la gronda è coperta dallo sporto', () => {
  const p = sampleProject();
  const roof = p.elements.find((e) => e.kind === 'roof');
  const base = G.roofBase(p, roof);
  for (const dir of ['sud', 'nord']) {
    const els = elevation(p, dir);
    // pareti del piano primo che arrivano all'imposta (cima a −base)
    const tops = walls(els).filter((w) => Math.abs(w.box.y0 + base) < 1e-3);
    assert.ok(tops.length > 0, `${dir}: facciata del piano primo`);
    for (const w of tops)
      for (const fx of [0.25, 0.5, 0.75]) {
        // un punto appena sotto la cima del muro: lì passa lo sporto (la fascia di gronda sta più in basso)
        const q = { x: w.box.x0 + (w.box.x1 - w.box.x0) * fx, y: w.box.y0 + 0.004 };
        assert.ok(coveredAfter(els, w.i, q), `${dir}: la cima del muro in x=${q.x.toFixed(2)} resta scoperta sopra la gronda`);
      }
  }
});

test('prospetti: agli angoli i muri visti di taglio non sporgono dalla facciata', () => {
  const p = sampleProject();
  // testata ovest del piano primo più sottile dei muri lunghi
  const thin = p.catalog.wall.find((t) => t.layers.reduce((s, l) => s + l.thickness, 0) < 0.2);
  const w = p.elements.find((e) => e.kind === 'wall' && e.levelId === L1 && Math.abs(e.a.x) < 1e-6 && Math.abs(e.b.x) < 1e-6);
  w.typeId = thin.id;
  const lvl = p.levels.find((l) => l.id === L1);
  const els = elevation(p, 'ovest');
  // pareti del piano primo: tra le quote del piano (y da −(quota + altezza) a −quota)
  const upper = walls(els).filter((x) => x.box.y1 <= -lvl.elevation + 1e-3 && x.box.y1 >= -lvl.elevation - 0.05);
  const facade = upper.reduce((a, b) => (b.box.x1 - b.box.x0 > a.box.x1 - a.box.x0 ? b : a));
  for (const x of upper) {
    // una parete disegnata prima della facciata non deve uscire dai suoi fianchi
    if (x.i > facade.i) continue;
    assert.ok(x.box.x0 >= facade.box.x0 - 1e-3 && x.box.x1 <= facade.box.x1 + 1e-3, `parete da ${x.box.x0.toFixed(3)} a ${x.box.x1.toFixed(3)} fuori dalla facciata ${facade.box.x0.toFixed(3)}–${facade.box.x1.toFixed(3)}`);
  }
});

// ───────── Sezioni ─────────

/** Sezione parallela al colmo, tra la gronda sud e il colmo */
const longSection = (flip) => ({ id: 'sx', name: 'B', a: { x: -2, y: 3 }, b: { x: 14, y: 3 }, depth: 40, flip });

test('sezioni: nessun muro esce sopra la copertura', () => {
  const p = sampleProject();
  const roof = p.elements.find((e) => e.kind === 'roof');
  const g = R.roofGeom(p, roof);
  for (const flip of [false, true]) {
    const els = section(p, longSection(flip));
    // quota più alta della copertura (colmo all'estradosso) e quota del manto sul piano di taglio
    const ridgeTop = g.base + g.rise + g.th;
    const cutTop = G.roofUndersideAt(p, { x: 6, y: 3 }, g.base) + g.th;
    for (const w of walls(els)) {
      assert.ok(-w.box.y0 <= ridgeTop + 1e-3, `muro oltre il colmo (${-w.box.y0})`);
      if (-w.box.y0 <= cutTop + 1e-3) continue;
      // più alto della copertura tagliata: deve stare sotto una falda disegnata dopo
      const q = { x: (w.box.x0 + w.box.x1) / 2, y: w.box.y0 + 0.01 };
      assert.ok(coveredAfter(els, w.i, q), `${flip ? 'verso la gronda' : 'verso il colmo'}: muro in x=${q.x.toFixed(2)} alto ${(-w.box.y0).toFixed(2)} sopra la copertura`);
    }
  }
});

test('sezioni: verso la gronda si vede lo sporto che scende oltre i muri di testata', () => {
  const p = sampleProject();
  const roof = p.elements.find((e) => e.kind === 'roof');
  const g = R.roofGeom(p, roof);
  const els = section(p, longSection(true));
  const roofs = els.filter((e) => /ev-roof/.test(e.cls) && e.tag === 'polygon' && e.box);
  // guardando verso sud la sezione va da x = 14 a x = −2: u = 14 − x. Gli assi dei muri di testata
  // (x = 0 e x = 12) stanno in u = 2 e u = 14: lo sporto laterale è fuori da questo tratto
  const outside = roofs.filter((r) => r.box.x1 <= 2 + 1e-3 || r.box.x0 >= 14 - 1e-3);
  assert.ok(outside.length >= 2, 'sporti laterali visti da sotto, ai due lati');
  // e la falda scende fino alla gronda, più bassa dell'imposta
  assert.ok(roofs.some((r) => -r.box.y1 < g.base - 0.05), 'la gronda scende sotto l’imposta');
});

// ───────── Piante ─────────

test('piante: le cifre delle quote stanno fuori dalla loro linea', () => {
  const p = sampleProject();
  for (const lv of ['lvl_pt', L1]) {
    const els = plan(p, lv);
    const texts = els.filter((e) => e.tag === 'text' && /pv-dimtext/.test(e.cls));
    assert.ok(texts.length > 10, 'cifre delle quote');
    for (const t of texts) {
      assert.equal(t.attrs['dominant-baseline'], 'central', 'cifra centrata in altezza');
      const font = +t.attrs['font-size'];
      // linea della sua catena: l'ultima linea di quota (senza classe né spessore proprio) prima della cifra
      const own = els.filter((e) => e.tag === 'line' && e.i < t.i && !e.cls && !e.attrs['stroke-width']).pop();
      const lines = own ? [own] : [];
      const q = t.pts[0];
      const dist = (l) => {
        const [a, b] = l.pts;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const L2 = dx * dx + dy * dy || 1;
        const k = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / L2));
        return Math.hypot(q.x - a.x - dx * k, q.y - a.y - dy * k);
      };
      assert.ok(lines.length, `${lv}: linea della cifra «${t.text}»`);
      const d = dist(lines[0]);
      // il centro della cifra dista dalla linea più di mezza altezza: il corpo non la attraversa
      assert.ok(d > font * 0.5, `${lv}: la cifra «${t.text}» attraversa la linea (distanza ${d.toFixed(3)}, corpo ${font})`);
    }
  }
});

test('piante: le scale del piano sotto si vedono solo dai fori del solaio', () => {
  const p = sampleProject();
  const svg = renderToStaticMarkup(React.createElement('svg', null, React.createElement(PlanView, { project: p, levelId: L1, mm: MM })));
  // la scala che arriva è dentro un gruppo mascherato dai solai del piano
  const mask = svg.match(/<mask id="([^"]+-arr)"[\s\S]*?<\/mask>/);
  assert.ok(mask, 'maschera dei solai');
  // il gruppo che usa la maschera contiene il disegno della scala (le alzate)
  const group = svg.match(new RegExp(`<g mask="url\\(#${mask[1]}\\)">([\\s\\S]*?)</g>`));
  assert.ok(group, 'scala mascherata');
  assert.match(group[1], /<line\b/, 'la scala sta nel gruppo mascherato');
  // nella maschera: il solaio nero e il foro scala bianco
  assert.match(mask[0], /fill="#000"/);
  assert.match(mask[0], /fill="#fff"/);
  // senza foro: nella maschera resta solo il solaio
  const st = p.elements.find((e) => e.kind === 'stair');
  st.hole = false;
  const svg2 = renderToStaticMarkup(React.createElement('svg', null, React.createElement(PlanView, { project: p, levelId: L1, mm: MM })));
  const mask2 = svg2.match(/<mask id="([^"]+-arr)"[\s\S]*?<\/mask>/);
  assert.ok(mask2 && (mask2[0].match(/fill="#fff"/g) ?? []).length === 1, 'solo lo sfondo bianco: nessun foro');
});

// ───────── Archi ─────────

test('prospetti: le aperture ad arco hanno il vano e la lunetta ad arco', () => {
  const p = sampleProject();
  const win = p.catalog.opening.find((t) => t.id === 'ot_fin');
  win.head = 'tutto-sesto';
  const svg = renderToStaticMarkup(React.createElement('svg', null, React.createElement(ElevationView, { project: p, direction: 'sud', mm: MM })));
  // fori dei muri: i sottopercorsi dopo il primo (il contorno)
  const holes = [...svg.matchAll(/<path d="([^"]+)"[^>]*class="ev-wall"/g)].flatMap((m) => m[1].split(/Z/i).slice(1)).filter((d) => d.trim());
  const arcs = holes.map((d) => (d.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g) ?? []).map(Number)).filter((v) => v.length > 20);
  assert.ok(arcs.length > 0, 'vani ad arco nei muri');
  for (const v of arcs) {
    const xs = v.filter((_, k) => k % 2 === 0);
    const ys = v.filter((_, k) => k % 2 === 1);
    const w = Math.max(...xs) - Math.min(...xs);
    const top = -Math.min(...ys);
    const bottom = -Math.max(...ys);
    assert.ok(Math.abs(w - win.width) < 1e-6, 'luce');
    assert.ok(Math.abs(top - bottom - win.height) < 1e-6, 'altezza in chiave');
    // ogni punto della testa sta sul cerchio dell'arco
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
    const zc = bottom + win.height - win.width / 2;
    for (let k = 0; k < xs.length; k++) if (-ys[k] > zc + 1e-6) assert.ok(Math.abs(Math.hypot(xs[k] - cx, -ys[k] - zc) - win.width / 2) < 1e-6);
  }
  // le finestre hanno una lunetta vetrata sopra le ante
  const glass = parse(svg).filter((e) => e.tag === 'polygon' && /ev-glass/.test(e.cls));
  assert.ok(glass.length >= arcs.length, 'lunette');
});

test('sezioni: il piano che passa per un arco taglia il muro all’intradosso', () => {
  const p = sampleProject();
  const win = p.catalog.opening.find((t) => t.id === 'ot_fin');
  win.head = 'tutto-sesto';
  const o = p.elements.find((e) => e.kind === 'opening' && e.typeId === 'ot_fin');
  const w = p.elements.find((e) => e.id === o.wallId);
  const lvl = p.levels.find((l) => l.id === w.levelId);
  const d = G.norm(G.sub(w.b, w.a));
  const n = { x: -d.y, y: d.x };
  const zKey = lvl.elevation + win.sill + win.height;
  for (const dx of [0, 0.3]) {
    const c = G.add(w.a, G.mul(d, o.offset + dx));
    const sec = { id: 'sa', name: 'A', a: G.add(c, G.mul(n, -3)), b: G.add(c, G.mul(n, 3)), depth: 0.5, flip: false };
    const svg = renderToStaticMarkup(React.createElement('svg', null, React.createElement(SectionView, { project: p, section: sec, mm: MM })));
    // contorno del muro tagliato sopra la finestra: il punto più basso sta all'intradosso
    const expect = lvl.elevation + win.sill + O.headAt(win, dx);
    const ok = [...svg.matchAll(/points="([^"]+)"/g)].some((m) => {
      const v = m[1].split(/[ ,]/).map(Number);
      const zs = v.filter((_, k) => k % 2 === 1).map((y) => -y);
      return Math.abs(Math.min(...zs) - expect) < 1e-6 && Math.max(...zs) > zKey;
    });
    assert.ok(ok, `muro tagliato a ${expect.toFixed(3)} m a ${dx} m dalla chiave`);
    // oltre il piano l'intradosso scende all'imposta: se ne vede lo spigolo
    const zs = lvl.elevation + win.sill + O.springHeight(win);
    const imp = [...svg.matchAll(/<line [^>]*class="sc-view-line"[^>]*>/g)].filter((m) => Math.abs(-Number(m[0].match(/y1="([^"]+)"/)[1]) - zs) < 1e-6);
    assert.ok(imp.length > 0, `linea d'imposta a ${zs.toFixed(3)} m`);
  }
});

test('sezioni: scala a L vista di fronte, nessun vuoto tra gradini e pianerottolo', () => {
  const p = sampleProject();
  const st = p.elements.find((e) => e.kind === 'stair');
  st.shape = 'L';
  st.turn = 'sinistra';
  // alzate più alte dello spessore del pianerottolo: l'ultima alzata va disegnata per intero
  st.risers = 13;
  const lay = G.stairLayout(p, st);
  assert.ok(lay.h > 0.2);
  const landing = lay.landings[0];
  let checked = 0;
  for (const flip of [false, true]) {
    // piano davanti alla partenza, perpendicolare alla prima rampa
    const sec = { id: 'sl', name: 'C', a: { x: 0.5, y: 12 }, b: { x: 0.5, y: 4 }, depth: 30, flip };
    const els = section(p, sec);
    const rects = els.filter((e) => e.tag === 'rect' && /sc-view/.test(e.cls));
    // alzate della prima rampa (rettangoli alti un'alzata) e faccia del pianerottolo
    const risers = rects.filter((r) => Math.abs(r.box.y1 - r.box.y0 - lay.h) < 1e-6);
    if (risers.length < lay.flights[0].steps) continue;
    checked++;
    // dalla base al pianerottolo le facce coprono tutta l'altezza, senza interruzioni
    const spans = rects.map((r) => [-r.box.y1, -r.box.y0]).sort((x, y) => x[0] - y[0]);
    let reach = 0;
    for (const [z0, z1] of spans) if (z0 <= reach + 1e-6) reach = Math.max(reach, z1);
    assert.ok(reach >= landing.z - 1e-6, `facce continue fino al pianerottolo (arrivano a ${reach.toFixed(3)} su ${landing.z.toFixed(3)})`);
  }
  assert.equal(checked, 1, 'da un solo lato si vedono le alzate');
});

// ───────── Tavole ─────────

test('tavole: in ogni formato il cartiglio sta dentro la squadratura', () => {
  const p = sampleProject();
  const sheet = { ...p.sheets[0], viewports: [] };
  for (const format of Object.keys(PAPER)) {
    const svg = renderToStaticMarkup(React.createElement(SheetView, { project: p, sheet: { ...sheet, format }, revision: 0 }));
    const { w, h } = PAPER[format];
    assert.match(svg, new RegExp(`viewBox="0 0 ${w} ${h}"`), format);
    const frame = svg.match(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" class="sh-frame"/);
    const tb = svg.match(/<g transform="translate\(([-\d.]+) ([-\d.]+)\)" class="sh-tb">\s*<rect x="0" y="0" width="([\d.]+)" height="([\d.]+)"/);
    assert.ok(frame && tb, format);
    const [fx, fy, fw, fh] = frame.slice(1).map(Number);
    const [tx, ty, tw, th] = tb.slice(1).map(Number);
    assert.ok(tx >= fx - 1e-6 && ty >= fy - 1e-6 && tx + tw <= fx + fw + 1e-6 && ty + th <= fy + fh + 1e-6, `${format}: cartiglio fuori dalla squadratura`);
  }
});

test.after(() => server.close());
