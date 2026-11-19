// Test del vano senza porta. Esecuzione: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({ root, logLevel: 'error', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
const O = await server.ssrLoadModule('/src/model/openings.ts');
const { wallGeom } = await server.ssrLoadModule('/src/model/walls.ts');
const { computeComputo, openingSchedule, wallSchedule } = await server.ssrLoadModule('/src/model/quantities.ts');
const { elementCode } = await server.ssrLoadModule('/src/model/geometry.ts');
const { validateProject } = await server.ssrLoadModule('/src/model/validate.ts');
const { sampleProject } = await server.ssrLoadModule('/src/model/defaults.ts');

/** Esempio con la porta interna del piano primo sostituita da un vano */
function withBare() {
  const p = sampleProject();
  const vano = p.catalog.opening.find((t) => t.leaves === 0);
  const door = p.elements.find((e) => e.kind === 'opening' && e.typeId === 'ot_int');
  door.typeId = vano.id;
  return { p, vano, door, wall: p.elements.find((e) => e.id === door.wallId) };
}

test('vano senza porta: nel catalogo tra le porte, senza ante né telaio', () => {
  const { p, vano, door, wall } = withBare();
  assert.equal(vano.category, 'porta');
  assert.ok(O.isBareOpening(vano));
  assert.ok(!O.isBareOpening(p.catalog.opening.find((t) => t.id === 'ot_int')));
  const spec = O.fixtureSpec(p, wall, wallGeom(p, wall), door, vano);
  assert.equal(spec.bare, true);
  assert.equal(spec.leaves, 0);
  assert.equal(spec.hasThreshold, false);
  assert.deepEqual(O.leafSpans(spec, 1, 1.8), []);
  // una finestra con zero ante non è un vano
  assert.ok(!O.isBareOpening({ category: 'finestra', leaves: 0 }));
});

test('vano senza porta: niente computo del serramento, ma il varco si deduce dal muro', () => {
  const plain = sampleProject();
  const { p, vano, wall } = withBare();
  const count = (q, code) => computeComputo(q).find((l) => l.code === code)?.qty ?? 0;
  assert.equal(count(p, 'SER.01'), count(plain, 'SER.01') - 1, 'una porta interna in meno');
  assert.equal(vano.priceCode, '');
  // gli id dell'esempio sono casuali: si confronta la superficie netta totale dei muri
  const net = (q) => wallSchedule(q).reduce((t, r) => t + r.netArea, 0);
  assert.ok(Math.abs(net(p) - net(plain)) < 1e-6, 'stesso vuoto nel muro della porta che sostituisce');
  assert.ok(wallSchedule(p).find((r) => r.id === wall.id).openings > 0, 'il vano conta tra le aperture del muro');
  // abaco e sigla
  const row = openingSchedule(p).find((r) => r.typeId === vano.id);
  assert.match(row.mark, /^V\d\d$/);
  const e = p.elements.find((x) => x.kind === 'opening' && x.typeId === vano.id);
  assert.match(elementCode(p, e), /^VA-/);
});

test('progetti precedenti: il vano senza porta si aggiunge al catalogo all’apertura', () => {
  const raw = JSON.parse(JSON.stringify(sampleProject()));
  raw.catalog.opening = raw.catalog.opening.filter((t) => t.leaves !== 0);
  const { project, warnings } = validateProject(raw);
  const added = project.catalog.opening.filter((t) => t.leaves === 0);
  assert.equal(added.length, 1);
  assert.equal(added[0].category, 'porta');
  assert.deepEqual(warnings, []);
  // se c'è già, non si duplica
  assert.equal(validateProject(JSON.parse(JSON.stringify(project))).project.catalog.opening.filter((t) => t.leaves === 0).length, 1);
});

// ───────── Posizione del telaio nello spessore del muro ─────────

/** Finestra in un muro perimetrale dell'esempio */
function windowInWall() {
  const p = sampleProject();
  const o = p.elements.find((e) => e.kind === 'opening' && p.catalog.opening.find((t) => t.id === e.typeId).category === 'finestra');
  const w = p.elements.find((e) => e.id === o.wallId);
  const t = p.catalog.opening.find((x) => x.id === o.typeId);
  return { p, o, w, t, g: wallGeom(p, w) };
}

test('telaio: a filo esterno, in asse, a filo interno, a distanza', () => {
  const { p, o, w, t, g } = windowInWall();
  const thick = 2 * g.half;
  const at = (patch) => {
    const spec = O.fixtureSpec(p, w, g, { ...o, ...patch }, t);
    return { spec, d: O.frameDistance(g, spec) };
  };
  const auto = at({});
  assert.ok(auto.d > 0.05, 'automatico: dietro il cappotto, come prima');
  const fd = O.frameDepth(t);
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  assert.ok(near(at({ frame: 'esterno' }).d, 0));
  assert.ok(near(at({ frame: 'interno' }).d, thick - fd));
  assert.ok(near(at({ frame: 'asse' }).spec.fc, 0));
  assert.ok(near(at({ frame: 'distanza', frameOffset: 0.12 }).d, 0.12));
  assert.ok(near(at({ frame: 'distanza', frameOffset: 5 }).d, thick - fd), 'non esce dal muro');
  assert.ok(near(at({ frame: 'distanza', frameOffset: -1 }).d, 0));
  assert.ok(near(at({ frame: 'esterno' }).spec.fd, fd), 'profondità del telaio invariata');
  // il verso dell'anta resta verso l'interno
  assert.equal(at({ frame: 'esterno' }).spec.openDir, auto.spec.openDir);
});

test('telaio: una porta interna posizionata non occupa più tutto lo spessore', () => {
  const p = sampleProject();
  const o = p.elements.find((e) => e.kind === 'opening' && e.typeId === 'ot_int');
  const w = p.elements.find((e) => e.id === o.wallId);
  const t = p.catalog.opening.find((x) => x.id === 'ot_int');
  const g = wallGeom(p, w);
  assert.ok(Math.abs(O.fixtureSpec(p, w, g, o, t).fd - 2 * g.half) < 1e-9, 'automatica: a tutto spessore');
  const spec = O.fixtureSpec(p, w, g, { ...o, frame: 'interno' }, t);
  assert.ok(Math.abs(spec.fd - Math.min(O.frameDepth(t), 2 * g.half)) < 1e-9);
});

test('telaio: la posizione resta nel file di progetto', () => {
  const { p, o } = windowInWall();
  o.frame = 'distanza';
  o.frameOffset = 0.18;
  const { project } = validateProject(JSON.parse(JSON.stringify(p)));
  const back = project.elements.find((e) => e.id === o.id);
  assert.equal(back.frame, 'distanza');
  assert.equal(back.frameOffset, 0.18);
});

test.after(() => server.close());
