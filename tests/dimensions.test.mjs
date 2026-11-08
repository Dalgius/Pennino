// Test di regressione su quote, muri e aperture. Esecuzione: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { produce } from 'immer';

const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({ root, logLevel: 'error', server: { middlewareMode: true }, appType: 'custom' });
const { followWalls, takeRefusal } = await server.ssrLoadModule('/src/model/constraints.ts');
const { computeDimensions, applyDimension } = await server.ssrLoadModule('/src/model/dimensions.ts');
const { sampleProject } = await server.ssrLoadModule('/src/model/defaults.ts');
const { openingSpans } = await server.ssrLoadModule('/src/model/geometry.ts');

const L1 = 'lvl_p1';
const near = (a, b, t = 1e-3) => Math.abs(a - b) < t;

/** Piano primo dell'esempio con il tramezzo orizzontale disegnato da est (come nel caso segnalato) */
function scenario() {
  const p = sampleProject();
  const vert = p.elements.find((e) => e.kind === 'wall' && e.levelId === L1 && near(e.a.x, 6) && near(e.b.x, 6));
  const hor = p.elements.find((e) => e.kind === 'wall' && e.levelId === L1 && near(e.a.y, 4.5) && near(e.b.y, 4.5));
  assert.ok(vert && hor, 'tramezzi di esempio');
  // da est a ovest; porta da 80 a 60 cm dalla faccia del tramezzo verticale
  hor.a = { x: 12, y: 4.5 };
  hor.b = { x: 6, y: 4.5 };
  const door = p.catalog.opening.find((t) => near(t.width, 0.8));
  assert.ok(door, 'porta da 80 cm');
  p.elements = p.elements.filter((e) => !(e.kind === 'opening' && e.wallId === hor.id));
  p.elements.push({ id: 'porta', kind: 'opening', wallId: hor.id, typeId: door.id, offset: 12 - (6 + 0.055 + 0.6 + 0.4), flip: false });
  return { p, vert, hor };
}

/** Applica come lo store: modifica, poi vincoli */
const apply = (p, fn) => followWalls(p, produce(p, fn));

/** Modifica la quota sul muro nord che sposta il tramezzo verticale */
function moveVertical(p, vert, by) {
  const north = p.elements.find((e) => e.kind === 'wall' && e.levelId === L1 && near(e.a.y, 9) && near(e.b.y, 9));
  const chain = computeDimensions(p, L1).find((c) => c.wallId === north.id && c.row === 1);
  const k = chain.marks.findIndex((m, i) => i > 0 && m.ref.k === 'giunto' && m.ref.wallId === vert.id && m.ref.face === 0) - 1;
  assert.ok(k >= 0, 'segmento che sposta il tramezzo');
  const cur = chain.marks[k + 1].s - chain.marks[k].s;
  // il verso della catena può essere opposto all'asse x
  const sign = Math.sign(chain.dir.x) || 1;
  return apply(p, (d) => applyDimension(d, chain, k, cur + by * sign));
}

const doorOf = (p) => p.elements.find((e) => e.id === 'porta');
const span = (p, wallId) => openingSpans(p, p.elements.find((e) => e.id === wallId)).find((s) => s.opening.id === 'porta');

test('spostando il tramezzo con la quota, la porta resta da 80 cm e dentro il muro', () => {
  const { p, vert, hor } = scenario();
  const q = moveVertical(p, vert, 1);
  const moved = q.elements.find((e) => e.id === vert.id);
  assert.ok(near(moved.a.x, 7, 0.01), `tramezzo spostato a x=7 (è ${moved.a.x})`);
  const sp = span(q, hor.id);
  assert.ok(near(sp.end - sp.start, 0.8), `larghezza ${sp.end - sp.start}`);
  // non entra nel tramezzo spostato: la porta finisce prima della sua faccia (x = 7 − 0,055)
  const w = q.elements.find((e) => e.id === hor.id);
  const xWest = w.a.x - sp.end;
  assert.ok(xWest >= 7 + 0.055 - 1e-3, `porta oltre la faccia: ${xWest}`);
});

test('se la porta non è toccata dallo spostamento resta dove era', () => {
  const { p, vert } = scenario();
  const before = doorOf(p);
  const xBefore = 12 - before.offset;
  const q = moveVertical(p, vert, -0.3);
  const w = q.elements.find((e) => e.kind === 'wall' && e.id === before.wallId);
  assert.ok(near(w.a.x - doorOf(q).offset, xBefore), 'posizione assoluta invariata');
});

test('muro troppo corto per la porta: modifica annullata con messaggio', () => {
  const { p, vert } = scenario();
  takeRefusal();
  const q = moveVertical(p, vert, 5.3);
  assert.equal(q, p, 'modello invariato');
  assert.match(takeRefusal() ?? '', /troppo corto/);
});

test('traslando il muro ospite la porta lo segue', () => {
  const { p, hor } = scenario();
  const off = doorOf(p).offset;
  const q = apply(p, (d) => {
    const w = d.elements.find((e) => e.id === hor.id);
    w.a = { x: w.a.x, y: w.a.y - 0.5 };
    w.b = { x: w.b.x, y: w.b.y - 0.5 };
  });
  assert.ok(near(doorOf(q).offset, off));
});

test('allungando un muro dalla fine le aperture non si muovono', () => {
  const { p, hor } = scenario();
  const off = doorOf(p).offset;
  const q = apply(p, (d) => {
    const w = d.elements.find((e) => e.id === hor.id);
    w.b = { x: 5.5, y: 4.5 };
  });
  assert.ok(near(doorOf(q).offset, off));
});

test('spostare l’estremo iniziale mantiene la posizione assoluta della porta', () => {
  const { p, hor } = scenario();
  const x = 12 - doorOf(p).offset;
  const q = apply(p, (d) => {
    d.elements.find((e) => e.id === hor.id).a = { x: 11, y: 4.5 };
  });
  assert.ok(near(11 - doorOf(q).offset, x));
});

test('bordi liberi dei solai quotati: pilastri e balcone modificabili dalle quote', () => {
  let p = sampleProject();
  const chains = computeDimensions(p, 'lvl_pt').filter((c) => c.id.includes(':e'));
  const withCols = chains.find((c) => c.marks.some((m) => m.ref.k === 'pilastro'));
  assert.ok(withCols, 'catena con i pilastri sul bordo della pavimentazione');
  const k = withCols.marks.findIndex((m, i) => i > 0 && m.ref.k === 'pilastro' && m.ref.edge === 0) - 1;
  const cur = withCols.marks[k + 1].s - withCols.marks[k].s;
  const col = withCols.marks[k + 1].ref.id;
  const before = p.elements.find((e) => e.id === col).p.x;
  p = apply(p, (d) => applyDimension(d, withCols, k, cur + 0.5));
  assert.ok(near(Math.abs(p.elements.find((e) => e.id === col).p.x - before), 0.5), 'pilastro spostato di 50 cm');
  // balcone del piano primo: accorciato di 40 cm, resta rettangolare
  const bal = computeDimensions(p, 'lvl_p1').find((c) => c.id.endsWith(':e0'));
  assert.ok(bal, 'bordo del balcone quotato');
  const n = bal.marks.length;
  p = apply(p, (d) => applyDimension(d, bal, n - 2, bal.marks[n - 1].s - bal.marks[n - 2].s - 0.4));
  const pts = p.elements.find((e) => e.kind === 'slab' && e.levelId === 'lvl_p1').points;
  assert.ok(near(pts[1].x, 5.8) && near(pts[2].x, 5.8), 'vertici del lato perpendicolare spostati insieme');
});

test('pilastro isolato quotato e spostabile; lato del balcone che sporge oltre il muro quotato', () => {
  let p = sampleProject();
  p.elements.push({ id: 'cIso', kind: 'column', levelId: 'lvl_pt', typeId: 'ct_30', p: { x: 3, y: 4 } });
  const cx = computeDimensions(p, 'lvl_pt').find((c) => c.id === 'cIso:x');
  assert.ok(cx && computeDimensions(p, 'lvl_pt').some((c) => c.id === 'cIso:y'), 'quote in x e y');
  p = apply(p, (d) => applyDimension(d, cx, 0, 2.0));
  const col = p.elements.find((e) => e.id === 'cIso');
  assert.ok(near(col.p.x - 0.15 - 0.215, 2.0), `pilastro a 2,00 dalla faccia del muro (x=${col.p.x})`);
  const west = computeDimensions(p, 'lvl_p1').find((c) => c.marks.some((m) => m.ref.k === 'punto') && c.marks.some((m) => m.ref.k === 'vertice'));
  assert.ok(west && near(west.marks[1].s - west.marks[0].s, 2.6), 'sporgenza del balcone 2,60');
});

test.after(() => server.close());
