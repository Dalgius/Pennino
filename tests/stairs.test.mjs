// Test delle scale dritte, a L e a U. Esecuzione: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({ root, logLevel: 'error', server: { middlewareMode: true }, appType: 'custom' });
const g = await server.ssrLoadModule('/src/model/geometry.ts');
const { sampleProject } = await server.ssrLoadModule('/src/model/defaults.ts');

const near = (a, b, t = 1e-3) => Math.abs(a - b) < t;

function withStair(patch) {
  const p = sampleProject();
  const s = p.elements.find((e) => e.kind === 'stair');
  Object.assign(s, { a: { x: 1, y: 1 }, b: { x: 3.2, y: 1 } }, patch);
  const slab = p.elements.find((e) => e.kind === 'slab' && e.levelId === 'lvl_p1');
  return { p, s, slab };
}

test('scala dritta: n alzate e lunghezza invariata', () => {
  const { p, s } = withStair({ b: { x: 5.7, y: 1 } });
  const lay = g.stairLayout(p, s);
  assert.equal(lay.flights.length, 1);
  assert.equal(lay.landings.length, 0);
  assert.equal(lay.flights[0].steps, lay.n);
  assert.ok(near(lay.flights[0].len, 4.7));
});

for (const shape of ['L', 'U'])
  for (const turn of ['sinistra', 'destra'])
    test(`scala a ${shape} con svolta a ${turn}: alzate totali, pianerottolo e arrivo`, () => {
      const { p, s } = withStair({ shape, turn });
      const lay = g.stairLayout(p, s);
      assert.equal(lay.flights.length, 2);
      assert.equal(lay.landings.length, 1);
      // gradini delle rampe + pianerottolo = alzate totali
      assert.equal(lay.flights[0].steps + 1 + lay.flights[1].steps, lay.n);
      const top = lay.flights[1].base + lay.flights[1].steps * lay.h;
      assert.ok(near(top, 3.2), `arrivo a ${top}`);
      assert.ok(near(lay.landings[0].z, lay.flights[1].base));
      // la seconda rampa gira dal lato giusto
      const side = Math.sign(lay.flights[1].a.y - 1);
      assert.equal(side, turn === 'sinistra' ? 1 : -1);
      if (shape === 'U') assert.ok(near(lay.flights[1].d.x, -1), 'la seconda rampa torna indietro');
      else assert.ok(near(Math.abs(lay.flights[1].d.y), 1), 'la seconda rampa è perpendicolare');
    });

test('pedata: a→b è la prima rampa fino al pianerottolo', () => {
  const { p, s } = withStair({ shape: 'L', risers: 18, firstRisers: 9 });
  const { tread } = g.stairSteps(p, s);
  assert.ok(near(tread, 2.2 / 8));
  assert.ok(near(g.stairAxisLength(s, 18, 0.3), 8 * 0.3));
});

test('foro nel solaio di arrivo: un unico contorno che copre pianerottolo e seconda rampa', () => {
  const { p, slab } = withStair({ shape: 'U', turn: 'sinistra' });
  const holes = g.slabHoles(p, slab);
  assert.equal(holes.length, 1);
  const lay = g.stairLayout(p, p.elements.find((e) => e.kind === 'stair'));
  // il pianerottolo (alto 1,6 m) è tutto dentro il foro
  for (const q of lay.landings[0].poly) {
    const inside = g.pointInPolygon({ x: q.x - Math.sign(q.x - 2) * 0.01, y: q.y - Math.sign(q.y - 2) * 0.01 }, holes[0]);
    assert.ok(inside, `vertice del pianerottolo fuori dal foro: ${JSON.stringify(q)}`);
  }
  // l'inizio della prima rampa (sotto l'altezza libera) non è forato
  assert.ok(!g.pointInPolygon({ x: 1.1, y: 1 }, holes[0]));
});

test('soletta rampante: parte dal pavimento e si raccorda all’intradosso del pianerottolo', () => {
  const { p, s } = withStair({ shape: 'L', turn: 'destra' });
  const lay = g.stairLayout(p, s);
  const prof = g.flightProfile(p, s, lay, 0);
  const zl = lay.landings[0].z;
  const under = zl - g.LANDING_THICKNESS;
  // un vertice sull'intradosso del pianerottolo, oltre la fine della rampa
  assert.ok(prof.some((q) => near(q.y, under) && q.x >= lay.flights[0].len - 1e-6), 'raccordo col pianerottolo');
  // appoggio sul pavimento
  assert.ok(prof.some((q) => near(q.y, lay.flights[0].base) && q.x > 0), 'appoggio a terra');
  // seconda rampa: parte dal pianerottolo e arriva all'intradosso del solaio del piano primo
  const p2 = g.flightProfile(p, s, lay, 1);
  assert.ok(Math.min(...p2.map((q) => q.y)) >= under - 1e-6);
  assert.ok(near(Math.max(...p2.map((q) => q.y)), 3.2));
});

test.after(() => server.close());
