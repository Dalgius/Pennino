// Test delle quote disegnate a mano legate agli elementi. Esecuzione: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { produce } from 'immer';

const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({ root, logLevel: 'error', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
const A = await server.ssrLoadModule('/src/model/anchors.ts');
const { constrain } = await server.ssrLoadModule('/src/model/constraints.ts');
const { wallGeom } = await server.ssrLoadModule('/src/model/walls.ts');
const { validateProject } = await server.ssrLoadModule('/src/model/validate.ts');
const { sampleProject } = await server.ssrLoadModule('/src/model/defaults.ts');

const L0 = 'lvl_pt';
const near = (a, b, t = 1e-6) => Math.abs(a - b) < t;
const at = (p, x, y, t = 1e-6) => near(p.x, x, t) && near(p.y, y, t);
const apply = (p, fn) => constrain(p, produce(p, fn)).project;

/** Muro isolato da 5 m (asse y = 0) con un pilastro a 3 m e una porta */
function scene() {
  const p = sampleProject();
  const wt = p.elements.find((e) => e.kind === 'wall').typeId;
  const door = p.catalog.opening.find((t) => near(t.width, 0.8));
  p.elements.push({ id: 'wx', kind: 'wall', levelId: L0, typeId: wt, a: { x: 20, y: 0 }, b: { x: 25, y: 0 } });
  p.elements.push({ id: 'ox', kind: 'opening', wallId: 'wx', typeId: door.id, offset: 2, flip: false });
  p.elements.push({ id: 'cx', kind: 'column', levelId: L0, typeId: p.catalog.column[0].id, p: { x: 22, y: 4 } });
  const half = wallGeom(p, p.elements.find((e) => e.id === 'wx')).half;
  return { p, half };
}
/** Quota tra due punti, legata dove i punti cadono su un elemento */
function quota(p, a, b) {
  const aRef = A.anchorAt(p, L0, a) ?? undefined;
  const bRef = A.anchorAt(p, L0, b) ?? undefined;
  p.annotations = [...(p.annotations ?? []), { id: 'q', kind: 'quota', levelId: L0, a, b, offset: 0.6, aRef, bRef }];
}
const q = (p) => p.annotations.find((n) => n.id === 'q');

test('legame: si riconosce dove cade il punto', () => {
  const { p, half } = scene();
  assert.deepEqual(A.anchorAt(p, L0, { x: 25, y: half }), { k: 'muro', id: 'wx', end: 'b', u: 0, face: 1, v: 0 }, 'fine del muro sul filo');
  assert.equal(A.anchorAt(p, L0, { x: 21.6, y: -half }).k, 'apertura', 'stipite della porta');
  assert.equal(A.anchorAt(p, L0, { x: 22, y: 0 }).k, 'muro', 'dentro il vano: resta il muro');
  assert.equal(A.anchorAt(p, L0, { x: 22.15, y: 4 }).k, 'pilastro');
  assert.equal(A.anchorAt(p, L0, { x: 40, y: 40 }), null);
});

test('la quota segue il muro spostato, allungato e assottigliato', () => {
  const { p, half } = scene();
  quota(p, { x: 20, y: half }, { x: 25, y: half }); // lungo il filo nord
  // il muro si sposta di 1 m a nord
  let r = apply(p, (d) => {
    const w = d.elements.find((e) => e.id === 'wx');
    w.a = { x: 20, y: 1 };
    w.b = { x: 25, y: 1 };
  });
  assert.ok(at(q(r).a, 20, 1 + half) && at(q(r).b, 25, 1 + half), JSON.stringify(q(r)));
  // si allunga di 2 m: la fine segue
  r = apply(r, (d) => void (d.elements.find((e) => e.id === 'wx').b = { x: 27, y: 1 }));
  assert.ok(at(q(r).b, 27, 1 + half));
  // cambia lo spessore: resta sul filo
  const tid = r.elements.find((e) => e.id === 'wx').typeId;
  r = apply(r, (d) => void (d.catalog.wall.find((t) => t.id === tid).layers[0].thickness += 0.1));
  const nh = wallGeom(r, r.elements.find((e) => e.id === 'wx')).half;
  assert.ok(near(nh, half + 0.05) && at(q(r).a, 20, 1 + nh), 'sul nuovo filo');
});

test('la quota segue il pilastro e lo stipite; se l’elemento sparisce resta dov’è', () => {
  const { p, half } = scene();
  quota(p, { x: 21.6, y: -half }, { x: 21.85, y: 4 }); // stipite della porta → faccia ovest del pilastro
  let r = apply(p, (d) => void (d.elements.find((e) => e.id === 'cx').p = { x: 23, y: 5 }));
  assert.ok(at(q(r).b, 22.85, 5), 'faccia del pilastro spostato');
  r = apply(r, (d) => void (d.elements.find((e) => e.id === 'ox').offset = 3));
  assert.ok(at(q(r).a, 22.6, -half), 'stipite della porta spostata');
  r = apply(r, (d) => void (d.elements = d.elements.filter((e) => e.id !== 'cx')));
  assert.ok(at(q(r).b, 22.85, 5) && !q(r).bRef && q(r).aRef, 'pilastro eliminato: estremo fermo, legame sciolto');
});

test('il legame resta nel file di progetto', () => {
  const { p, half } = scene();
  quota(p, { x: 20, y: half }, { x: 25, y: half });
  const { project } = validateProject(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(q(project).aRef, q(p).aRef);
});

test.after(() => server.close());
