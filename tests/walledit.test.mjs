// Test dei comandi di modifica: dividi, taglia, estendi, sposta e copia. Esecuzione: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({ root, logLevel: 'error', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
const W = await server.ssrLoadModule('/src/model/wallEdit.ts');
const { sampleProject } = await server.ssrLoadModule('/src/model/defaults.ts');

const near = (a, b, tol = 1e-6) => Math.abs(a - b) < tol;
const P = (x, y) => ({ x, y });
const L0 = 'lvl_pt';

/** Progetto con soli i muri dati (tipologia del primo muro dell'esempio) */
function withWalls(walls, openings = []) {
  const p = sampleProject();
  const typeId = p.catalog.wall[0].id;
  p.elements = [
    ...walls.map(([id, a, b]) => ({ id, kind: 'wall', levelId: L0, typeId, a, b })),
    ...openings.map(([id, wallId, offset]) => ({ id, kind: 'opening', wallId, typeId: 'ot_fin', offset, flip: false })),
  ];
  p.annotations = [];
  return p;
}
const wall = (p, id) => p.elements.find((e) => e.id === id);

test('dividi: due muri, le aperture restano dove sono', () => {
  const p = withWalls([['m1', P(0, 0), P(10, 0)]], [['o1', 'm1', 2], ['o2', 'm1', 8]]);
  p.annotations = [{ id: 'q', kind: 'quota', levelId: L0, a: P(0, 0), b: P(10, 0), offset: 1, aRef: { k: 'muro', id: 'm1', end: 'a', u: 0, face: 0, v: 0 }, bRef: { k: 'muro', id: 'm1', end: 'b', u: 0, face: 0, v: 0 } }];
  const r = W.splitWall(p, 'm1', 5);
  assert.ok(r.id);
  assert.deepEqual(wall(p, 'm1').b, P(5, 0));
  assert.deepEqual(wall(p, r.id).a, P(5, 0));
  assert.deepEqual(wall(p, r.id).b, P(10, 0));
  // la seconda finestra passa al muro nuovo, alla stessa posizione assoluta
  assert.equal(wall(p, 'o1').wallId, 'm1');
  assert.equal(wall(p, 'o2').wallId, r.id);
  assert.ok(near(wall(p, 'o2').offset, 3));
  // la quota legata alla fine del muro segue il tratto nuovo
  assert.equal(p.annotations[0].bRef.id, r.id);
  assert.equal(p.annotations[0].aRef.id, 'm1');
  // dentro un'apertura o troppo vicino a un estremo: no
  assert.ok(W.splitWall(p, 'm1', 2).error);
  assert.ok(W.splitWall(p, 'm1', 0.01).error);
});

test('taglia: il tratto cliccato tra i muri che attraversano', () => {
  const make = () => withWalls([['m1', P(0, 0), P(10, 0)], ['v1', P(3, -2), P(3, 2)], ['v2', P(7, -2), P(7, 2)]], [['o1', 'm1', 5], ['o2', 'm1', 8.5]]);
  // tratto interno: il muro si divide in due, l'apertura nel tratto sparisce
  let p = make();
  let r = W.trimWall(p, 'm1', 5);
  assert.ok(near(r.removed, 4) && r.openings === 1);
  const walls = p.elements.filter((e) => e.kind === 'wall' && e.a.y === 0 && e.b.y === 0);
  assert.equal(walls.length, 2);
  assert.deepEqual(wall(p, 'm1').b, P(3, 0));
  const other = walls.find((w) => w.id !== 'm1');
  assert.deepEqual(other.a, P(7, 0));
  assert.ok(!p.elements.some((e) => e.id === 'o1'));
  // la finestra oltre il secondo muro resta allo stesso punto
  assert.equal(wall(p, 'o2').wallId, other.id);
  assert.ok(near(wall(p, 'o2').offset, 1.5));
  // tratto d'estremità: il muro si accorcia
  p = make();
  r = W.trimWall(p, 'm1', 1);
  assert.ok(near(r.removed, 3));
  assert.deepEqual(wall(p, 'm1').a, P(3, 0));
  assert.ok(near(wall(p, 'o2').offset, 5.5), 'le aperture restano dove sono');
  p = make();
  W.trimWall(p, 'm1', 9.5);
  assert.deepEqual(wall(p, 'm1').b, P(7, 0));
  // nessun muro che attraversa
  assert.ok(W.trimWall(withWalls([['m1', P(0, 0), P(10, 0)]]), 'm1', 5).error);
});

test('estendi: l’estremo più vicino fino all’asse del primo muro', () => {
  const p = withWalls([['m1', P(2, 0), P(5, 0)], ['v1', P(8, -3), P(8, 3)], ['v2', P(12, -3), P(12, 3)], ['v0', P(-1, -3), P(-1, 3)]], [['o1', 'm1', 1]]);
  let r = W.extendWall(p, 'm1', P(4.8, 0.1));
  assert.ok(near(r.added, 3));
  assert.deepEqual(wall(p, 'm1').b, P(8, 0));
  // dall'inizio: le aperture restano ferme sul disegno
  r = W.extendWall(p, 'm1', P(2.2, 0));
  assert.ok(near(r.added, 3));
  assert.deepEqual(wall(p, 'm1').a, P(-1, 0));
  assert.ok(near(wall(p, 'o1').offset, 4));
  // nulla da incontrare
  assert.ok(W.extendWall(withWalls([['m1', P(0, 0), P(1, 0)]]), 'm1', P(1, 0)).error);
});

test('sposta e copia di un vettore', () => {
  const p = withWalls([['m1', P(0, 0), P(4, 0)], ['m2', P(4, 0), P(4, 3)]], [['o1', 'm1', 2]]);
  const orig = JSON.parse(JSON.stringify(p));
  // un muro da solo si porta dietro l'estremo del muro collegato
  W.moveElements(p, orig, ['m1'], P(0, -1));
  assert.deepEqual(wall(p, 'm1').a, P(0, -1));
  assert.deepEqual(wall(p, 'm2').a, P(4, -1));
  // copia: il muro e la sua finestra, spostati
  const q = withWalls([['m1', P(0, 0), P(4, 0)]], [['o1', 'm1', 2]]);
  const made = W.copyElements(q, ['m1'], L0, P(0, 5));
  assert.equal(made.length, 1);
  const c = wall(q, made[0]);
  assert.deepEqual(c.a, P(0, 5));
  assert.deepEqual(c.b, P(4, 5));
  const co = q.elements.find((e) => e.kind === 'opening' && e.wallId === c.id);
  assert.ok(co && near(co.offset, 2));
  assert.deepEqual(wall(q, 'm1').a, P(0, 0), 'l’originale resta');
});

test('cima: due muri fino all’angolo, resta la parte cliccata', () => {
  // muri che non si toccano: si allungano entrambi
  let p = withWalls([['h', P(0, 0), P(4, 0)], ['v', P(6, 1), P(6, 5)]]);
  let r = W.cornerWalls(p, 'h', P(1, 0), 'v', P(6, 3));
  assert.equal(r.openings, 0);
  assert.deepEqual(wall(p, 'h').b, P(6, 0));
  assert.deepEqual(wall(p, 'v').a, P(6, 0));
  // muri che si incrociano: di ciascuno resta il lato del clic
  p = withWalls([['h', P(0, 0), P(10, 0)], ['v', P(4, -3), P(4, 3)]], [['o1', 'h', 7]]);
  r = W.cornerWalls(p, 'h', P(1, 0), 'v', P(4, 2));
  assert.deepEqual(wall(p, 'h').a, P(0, 0));
  assert.deepEqual(wall(p, 'h').b, P(4, 0));
  assert.deepEqual(wall(p, 'v').a, P(4, 0));
  assert.deepEqual(wall(p, 'v').b, P(4, 3));
  // la finestra rimasta fuori dal muro accorciato si elimina
  assert.equal(r.openings, 1);
  assert.ok(!p.elements.some((e) => e.id === 'o1'));
  // l'altro lato: si tiene la parte destra, le aperture restano ferme sul disegno
  p = withWalls([['h', P(0, 0), P(10, 0)], ['v', P(4, -3), P(4, 3)]], [['o1', 'h', 7]]);
  W.cornerWalls(p, 'h', P(8, 0), 'v', P(4, -2));
  assert.deepEqual(wall(p, 'h').a, P(4, 0));
  assert.ok(near(wall(p, 'o1').offset, 3));
  assert.deepEqual(wall(p, 'v').b, P(4, 0));
  // paralleli o stesso muro: no
  assert.ok(W.cornerWalls(withWalls([['a', P(0, 0), P(4, 0)], ['b', P(0, 2), P(4, 2)]]), 'a', P(1, 0), 'b', P(1, 2)).error);
  assert.ok(W.cornerWalls(p, 'h', P(5, 0), 'h', P(6, 0)).error);
});

test.after(() => server.close());
