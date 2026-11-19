// Test della linea di riferimento dei muri. Esecuzione: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { produce } from 'immer';

const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({ root, logLevel: 'error', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
const R = await server.ssrLoadModule('/src/model/wallRef.ts');
const { constrain } = await server.ssrLoadModule('/src/model/constraints.ts');
const { wallGeom } = await server.ssrLoadModule('/src/model/walls.ts');
const { sampleProject } = await server.ssrLoadModule('/src/model/defaults.ts');

const near = (a, b, t = 1e-6) => Math.abs(a - b) < t;
const at = (p, x, y, t = 1e-6) => near(p.x, x, t) && near(p.y, y, t);
const L0 = 'lvl_pt';

test('spezzata sull’asse: i punti restano quelli disegnati', () => {
  const pts = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 4 }];
  assert.deepEqual(R.axisPolyline(pts, 0.2, 'asse'), pts);
});

test('rettangolo disegnato sul filo: l’asse si sposta di mezzo spessore, vertici uniti', () => {
  // in senso antiorario il lato destro guarda fuori: disegnando sul filo destro il muro cresce dentro
  const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 8 }, { x: 0, y: 8 }];
  const ax = R.axisPolyline(pts, 0.2, 'destra', true);
  assert.ok(at(ax[0], 0.2, 0.2) && at(ax[1], 9.8, 0.2) && at(ax[2], 9.8, 7.8) && at(ax[3], 0.2, 7.8), JSON.stringify(ax));
  // sul filo sinistro cresce fuori
  const out = R.axisPolyline(pts, 0.2, 'sinistra', true);
  assert.ok(at(out[0], -0.2, -0.2) && at(out[2], 10.2, 8.2));
  // aperta: gli estremi liberi si spostano solo di lato
  const open = R.axisPolyline(pts.slice(0, 3), 0.2, 'destra', false);
  assert.ok(at(open[0], 0, 0.2) && at(open[1], 9.8, 0.2) && at(open[2], 9.8, 8));
});

test('estremo disegnato sul filo di un muro: si allunga fino al suo asse (giunzione a T)', () => {
  const p = sampleProject();
  // muro sud del piano terra: asse y = 0, spessore 43 cm → filo interno a y ≈ 0,215
  const half = wallGeom(p, p.elements.find((e) => e.kind === 'wall' && e.levelId === L0 && near(e.a.y, 0) && near(e.b.y, 0))).half;
  const end = R.extendToHost(p, L0, { x: 4, y: half }, { x: 0, y: -1 });
  assert.ok(at(end, 4, 0), JSON.stringify(end));
  // lontano dai muri non cambia
  assert.ok(at(R.extendToHost(p, L0, { x: 4, y: 3 }, { x: 0, y: -1 }), 4, 3));
  // parallelo al muro: non è un innesto
  assert.ok(at(R.extendToHost(p, L0, { x: 4, y: half }, { x: 1, y: 0 }), 4, half));
});

test('cambiando spessore il filo di riferimento resta fermo e gli angoli restano uniti', () => {
  const p = sampleProject();
  // quattro muri isolati sul filo esterno, disegnati in senso antiorario (fuori = destra)
  const t = p.catalog.wall.find((x) => x.layers.reduce((s, l) => s + l.thickness, 0) > 0.4);
  const half = t.layers.reduce((s, l) => s + l.thickness, 0) / 2;
  const ref = [{ x: 30, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 8 }, { x: 30, y: 8 }];
  const ax = R.axisPolyline(ref, half, 'destra', true);
  ax.forEach((a, i) => p.elements.push({ id: `r${i}`, kind: 'wall', levelId: L0, typeId: t.id, a, b: ax[(i + 1) % 4], ref: 'destra' }));
  const wall = p.elements.find((e) => e.id === 'r0');
  p.elements.push({ id: 'fin', kind: 'opening', wallId: 'r0', typeId: 'ot_fin', offset: 4, flip: false });
  const winAt = (q) => {
    const w = q.elements.find((e) => e.id === 'r0');
    const o = q.elements.find((e) => e.id === 'fin');
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
    return w.a.x + ((w.b.x - w.a.x) * o.offset) / L;
  };
  const x0 = winAt(p);
  // la tipologia si assottiglia di 13 cm
  const { project: q } = constrain(p, produce(p, (d) => {
    const tt = d.catalog.wall.find((x) => x.id === t.id);
    tt.layers[0].thickness -= 0.13;
  }));
  const nh = half - 0.065;
  const walls = [0, 1, 2, 3].map((i) => q.elements.find((e) => e.id === `r${i}`));
  // filo esterno fermo: y = 0 per il muro sud, x = 40 per quello est
  assert.ok(near(walls[0].a.y - nh, 0, 1e-6) || near(walls[0].a.y + nh, 0, 1e-6), 'il muro sud ha ancora il filo esterno in y = 0');
  assert.ok(near(walls[0].a.y, nh) && near(walls[1].a.x, 40 - nh), JSON.stringify(walls.map((w) => w.a)));
  // angoli: la fine di ogni muro coincide con l'inizio del successivo
  for (let i = 0; i < 4; i++) assert.ok(at(walls[i].b, walls[(i + 1) % 4].a.x, walls[(i + 1) % 4].a.y), `angolo ${i}`);
  assert.ok(near(winAt(q), x0, 1e-6), 'la finestra resta ferma in pianta');
  // senza riferimento l'asse resta dov'è
  assert.ok(wall.ref === 'destra');
});

test('cambiando spessore un muro sull’asse non si sposta', () => {
  const p = sampleProject();
  const w = p.elements.find((e) => e.kind === 'wall' && e.levelId === L0);
  const before = { ...w.a };
  const { project: q } = constrain(p, produce(p, (d) => {
    d.catalog.wall.find((x) => x.id === w.typeId).layers[0].thickness += 0.05;
  }));
  assert.ok(at(q.elements.find((e) => e.id === w.id).a, before.x, before.y));
});

test.after(() => server.close());
