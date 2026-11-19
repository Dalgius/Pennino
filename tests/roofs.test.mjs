// Test delle coperture a falde: capanna, padiglione, una falda, piante a L. Esecuzione: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({ root, logLevel: 'error', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
const R = await server.ssrLoadModule('/src/model/roofs.ts');
const G = await server.ssrLoadModule('/src/model/geometry.ts');
const { computeComputo, roofSurface } = await server.ssrLoadModule('/src/model/quantities.ts');
const { sampleProject } = await server.ssrLoadModule('/src/model/defaults.ts');

const near = (a, b, t = 1e-3) => Math.abs(a - b) < t;
const L_PLAN = [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 9 }, { x: 6, y: 9 }, { x: 6, y: 4 }, { x: 0, y: 4 }];

function withRoof(patch) {
  const p = sampleProject();
  const r = p.elements.find((e) => e.kind === 'roof');
  Object.assign(r, patch);
  return { p, r, g: R.roofGeom(p, r) };
}
const count = (g, kind) => g.lines.filter((l) => l.kind === kind).length;

test('capanna: colmo e superficie come la regola delle due falde', () => {
  const { p, r, g } = withRoof({});
  // pianta 12 × 9 con colmo lungo il lato lungo: sale di tan(22°) · 4,5
  const rise = Math.tan((r.pitch * Math.PI) / 180) * 4.5;
  assert.ok(near(g.rise, rise), `${g.rise} ≠ ${rise}`);
  assert.equal(g.fragments.length, 2);
  assert.equal(count(g, 'colmo'), 1);
  const o = G.roofEave(p, r);
  assert.ok(near(g.area, ((12 + 2 * o) * (9 + 2 * o)) / Math.cos((r.pitch * Math.PI) / 180)), 'superficie di falda con lo sporto');
  // colmo lungo nord-sud: sale di tan(22°) · 6
  const ny = withRoof({ ridge: 'y' }).g;
  assert.ok(near(ny.rise, Math.tan((r.pitch * Math.PI) / 180) * 6));
});

test('padiglione: quattro falde, un colmo e quattro displuvi', () => {
  const { g, r } = withRoof({ shape: 'padiglione' });
  assert.equal(g.fragments.length, 4);
  assert.equal(count(g, 'colmo'), 1);
  assert.equal(count(g, 'displuvio'), 4);
  assert.equal(count(g, 'compluvio'), 0);
  const ridge = g.lines.find((l) => l.kind === 'colmo');
  // il colmo è lungo 12 − 9 = 3 m, a metà della pianta
  assert.ok(near(Math.hypot(ridge.b.x - ridge.a.x, ridge.b.y - ridge.a.y), 3) && near(ridge.a.y, 4.5));
  assert.ok(near(g.rise, Math.tan((r.pitch * Math.PI) / 180) * 4.5), 'stesso colmo della capanna');
  assert.ok(near(g.area, withRoof({}).g.area), 'stessa pendenza: stessa superficie della capanna');
});

test('una falda: un solo piano che sale dal lato scelto', () => {
  const { g, r, p } = withRoof({ shape: 'falda', slopeTo: 'sud' });
  const o = G.roofEave(p, r);
  assert.equal(g.fragments.length, 1);
  assert.equal(g.lines.length, 0);
  assert.ok(g.fragments[0].plane.n.y > 0.99, 'sale verso nord');
  // il piano continua a salire anche nello sporto sul lato alto
  assert.ok(near(g.rise, Math.tan((r.pitch * Math.PI) / 180) * (9 + o)));
  const est = withRoof({ shape: 'falda', slopeTo: 'est' }).g;
  assert.ok(est.fragments[0].plane.n.x < -0.99, 'scendendo a est sale verso ovest');
  assert.ok(near(est.rise, Math.tan((r.pitch * Math.PI) / 180) * (12 + o)));
});

test('pianta a L: le falde dei bracci si incontrano nei compluvi', () => {
  for (const shape of ['padiglione', 'falde']) {
    const { g } = withRoof({ shape, points: L_PLAN });
    assert.equal(g.pieces.length, 2, 'due bracci');
    assert.ok(count(g, 'compluvio') >= 1, `${shape}: almeno un compluvio`);
    // nessun frammento si sovrappone a un altro: la somma delle aree in pianta è quella del contorno
    const sum = g.fragments.reduce((s, f) => s + G.polygonArea(f.poly), 0);
    assert.ok(near(sum, G.polygonArea(g.outline), 1e-3), `${shape}: ${sum} ≠ ${G.polygonArea(g.outline)}`);
  }
  assert.deepEqual(R.maximalRectangles(L_PLAN).length, 2);
});

test('intradosso nei punti: sale fino al colmo, fuori dalla copertura niente', () => {
  const { p, g } = withRoof({ shape: 'padiglione' });
  const z = (x, y) => G.roofUndersideAt(p, { x, y }, g.base);
  assert.ok(near(z(6, 4.5), g.base + g.rise));
  assert.ok(near(z(0, 4.5), g.base), 'sul filo dei muri: quota d’imposta');
  assert.ok(z(-0.5, 4.5) < g.base, 'nello sporto la falda scende sotto l’imposta');
  assert.equal(z(30, 30), null);
});

test('computo: superficie di falda dalla geometria, anche per le nuove forme', () => {
  for (const shape of ['falde', 'padiglione', 'falda', 'piana']) {
    const { p, r } = withRoof(shape === 'piana' ? { shape } : { shape, points: L_PLAN });
    const A = roofSurface(p, r);
    const line = computeComputo(p).find((l) => l.code === p.catalog.roof.find((t) => t.id === r.typeId).priceCode);
    assert.ok(A > 0 && line && near(line.qty, A, 1e-2), `${shape}: ${A} / ${line?.qty}`);
  }
});

test.after(() => server.close());
