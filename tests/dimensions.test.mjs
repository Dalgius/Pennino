// Test di regressione su quote, muri e aperture. Esecuzione: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { produce } from 'immer';

const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({ root, logLevel: 'error', server: { middlewareMode: true }, appType: 'custom' });
const { followWalls, takeRefusal } = await server.ssrLoadModule('/src/model/constraints.ts');
const { computeDimensions, applyDimension, dimensionError } = await server.ssrLoadModule('/src/model/dimensions.ts');
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
  assert.ok(west && near(west.marks[1].s - west.marks[0].s, 2.6 - 0.215), 'sporgenza del balcone dal filo esterno del muro: 2,385');
});

test.after(() => server.close());

test('portico: la quota dal muro al pilastro sul lato letto al contrario sposta il pilastro', () => {
  const p = sampleProject();
  const L0 = 'lvl_pt';
  const sl = p.elements.find((e) => e.kind === 'slab' && e.levelId === L0 && e.points.some((q) => q.y < 0));
  sl.points = [{ x: 0, y: -4 }, { x: 6.2, y: -4 }, { x: 6.2, y: 0 }, { x: 0, y: 0 }];
  const col = p.elements.filter((e) => e.kind === 'column' && e.levelId === L0).find((c) => c.p.x > 3);
  col.p = { x: 6.05, y: -3.15 };
  // lato est: dal vertice (6.2,-4) al muro, la catena parte dal filo del muro
  const chain = computeDimensions(p, L0).find((c) => c.id === `${sl.id}:e1`);
  assert.ok(chain, 'catena sul lato est');
  const seg = (c, k) => c.marks[k + 1].s - c.marks[k].s;
  assert.equal(chain.marks[1].ref.k, 'pilastro');
  assert.equal(chain.marks[1].ref.edge, 0, 'la prima faccia incontrata è il bordo che sposta il pilastro');
  assert.ok(near(seg(chain, 1), 0.3), 'larghezza del pilastro in mezzo');
  const q = apply(p, (d) => applyDimension(d, chain, 0, seg(chain, 0) - 0.5));
  const moved = q.elements.find((e) => e.id === col.id);
  assert.ok(near(moved.p.y, -3.15 + 0.5), 'il pilastro si avvicina al muro di 50 cm');
});

test('una quota non porta un’apertura fuori dal muro né sopra un’altra', () => {
  const p = sampleProject();
  for (const lv of ['lvl_pt', L1])
    for (const ch of computeDimensions(p, lv))
      ch.marks.forEach((m, k) => {
        if (k === 0 || m.ref.k !== 'apertura' || m.ref.edge !== 0) return;
        assert.ok(dimensionError(p, ch, k - 1, 100), `100 m rifiutati su ${ch.id}`);
        const q = apply(p, (d) => applyDimension(d, ch, k - 1, 100));
        assert.equal(q, p, 'modello invariato');
        // la misura attuale resta ammessa
        assert.equal(dimensionError(p, ch, k - 1, m.s - ch.marks[k - 1].s), null);
      });
  // una piccola variazione resta possibile
  const ch = computeDimensions(p, L1).find((c) => c.marks.some((m) => m.ref.k === 'apertura'));
  const k = ch.marks.findIndex((m) => m.ref.k === 'apertura') - 1;
  const v = ch.marks[k + 1].s - ch.marks[k].s;
  assert.equal(dimensionError(p, ch, k, v - 0.05), null);
});

test('spostando un pilastro con la quota si muovono solo le travi del suo piano', () => {
  const p = sampleProject();
  const L0 = 'lvl_pt';
  const col = p.elements.find((e) => e.kind === 'column' && e.levelId === L0);
  const own = p.elements.find((e) => e.kind === 'beam' && e.levelId === L0 && (near(e.a.x, col.p.x) && near(e.a.y, col.p.y)));
  // trave di un altro piano con un estremo sulla stessa verticale
  p.elements.push({ id: 'trave_p1', kind: 'beam', levelId: L1, typeId: own.typeId, a: { ...col.p }, b: { x: col.p.x, y: 4 } });
  const chain = { id: 'x', wallId: col.id, origin: { x: 0, y: 0 }, dir: { x: 1, y: 0 }, out: { x: 0, y: 1 }, row: 1, endFixed: false,
    marks: [{ s: 0, ref: { k: 'punto' } }, { s: 1, ref: { k: 'pilastro', id: col.id, edge: 0 } }] };
  const q = produce(p, (d) => applyDimension(d, chain, 0, 1.5));
  assert.ok(near(q.elements.find((e) => e.id === own.id).a.x, col.p.x + 0.5), 'la trave del piano segue');
  assert.ok(near(q.elements.find((e) => e.id === 'trave_p1').a.x, col.p.x), 'la trave dell’altro piano resta ferma');
});

/** Muro isolato da 5 m con una porta a 3 m, lontano dal resto del modello */
function freeWall() {
  const p = sampleProject();
  const wt = p.elements.find((e) => e.kind === 'wall').typeId;
  const door = p.catalog.opening.find((t) => near(t.width, 0.8));
  p.elements.push({ id: 'wx', kind: 'wall', levelId: 'lvl_pt', typeId: wt, a: { x: 20, y: 0 }, b: { x: 25, y: 0 } });
  p.elements.push({ id: 'ox', kind: 'opening', wallId: 'wx', typeId: door.id, offset: 3, flip: false });
  return p;
}

test('accorciando un muro con la quota la porta resta dentro, anche senza i vincoli', () => {
  const p = freeWall();
  const chain = computeDimensions(p, 'lvl_pt').find((c) => c.wallId === 'wx' && c.marks.length === 2);
  assert.equal(dimensionError(p, chain, 0, 1), null);
  const q = produce(p, (d) => applyDimension(d, chain, 0, 1));
  const w = q.elements.find((e) => e.id === 'wx');
  const sp = openingSpans(q, w);
  assert.ok(near(w.b.x, 21), 'muro da 1 m');
  assert.equal(sp.length, 1, 'la porta è ancora in pianta');
  assert.ok(sp[0].start >= -1e-6 && sp[0].end <= 1 + 1e-6 && near(sp[0].end - sp[0].start, 0.8), 'porta intera da 80 cm dentro il muro');
  // più corto della porta: rifiutato
  assert.match(dimensionError(p, chain, 0, 0.5) ?? '', /troppo corto/);
  assert.equal(produce(p, (d) => applyDimension(d, chain, 0, 0.5)), p);
});

test('muri collineari o quasi paralleli non sono innesti a T', () => {
  for (const b of [{ x: 27, y: 0 }, { x: 31, y: 0.4 }]) {
    const p = freeWall();
    const wt = p.elements.find((e) => e.kind === 'wall').typeId;
    // parte dentro il muro da 5 m e prosegue oltre
    p.elements.push({ id: 'wy', kind: 'wall', levelId: 'lvl_pt', typeId: wt, a: { x: 23, y: 0 }, b });
    const chains = computeDimensions(p, 'lvl_pt').filter((c) => c.wallId === 'wx');
    for (const c of chains) {
      assert.ok(!c.marks.some((m) => m.ref.k === 'giunto'), `nessun giunto (${JSON.stringify(b)})`);
      for (const m of c.marks) assert.ok(m.s > -0.5 && m.s < 5.5, `segni dentro il muro: ${m.s}`);
    }
  }
  // un innesto vero resta
  const p = freeWall();
  p.elements.push({ id: 'wz', kind: 'wall', levelId: 'lvl_pt', typeId: p.elements.find((e) => e.kind === 'wall').typeId, a: { x: 21.5, y: 0 }, b: { x: 21.5, y: 3 } });
  const c = computeDimensions(p, 'lvl_pt').find((x) => x.wallId === 'wx' && x.row === 1 && x.marks.length > 2);
  assert.ok(c.marks.some((m) => m.ref.k === 'giunto' && m.ref.wallId === 'wz'), 'il tramezzo perpendicolare è un giunto');
});
