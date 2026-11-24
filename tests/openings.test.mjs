// Test delle aperture: vano senza porta, telaio, soglia, archi. Esecuzione: npm test
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

// ───────── Soglia ─────────

test('soglia: automatica nei muri perimetrali, sì/no scelto sull’apertura', () => {
  const p = sampleProject();
  const ext = p.elements.find((e) => e.kind === 'opening' && e.typeId === 'ot_ing'); // portoncino nel muro esterno
  const int = p.elements.find((e) => e.kind === 'opening' && e.typeId === 'ot_int'); // porta interna nel tramezzo
  const win = p.elements.find((e) => e.kind === 'opening' && e.typeId === 'ot_fin'); // finestra con davanzale
  const spec = (o, patch = {}) => {
    const w = p.elements.find((x) => x.id === o.wallId);
    return O.fixtureSpec(p, w, wallGeom(p, w), { ...o, ...patch }, p.catalog.opening.find((t) => t.id === o.typeId));
  };
  assert.equal(spec(ext).hasThreshold, true);
  assert.equal(spec(int).hasThreshold, false);
  assert.equal(spec(ext, { threshold: false }).hasThreshold, false);
  assert.equal(spec(int, { threshold: true }).hasThreshold, true);
  assert.equal(spec(win, { threshold: true }).hasThreshold, false, 'una finestra con davanzale non ha soglia');
  // anche un vano senza porta può avere la soglia, se la si chiede
  const vano = p.catalog.opening.find((t) => t.leaves === 0);
  assert.equal(spec({ ...int, typeId: vano.id }).hasThreshold, false);
  assert.equal(spec({ ...int, typeId: vano.id }, { threshold: true }).hasThreshold, true);
});

// ───────── Archi ─────────

const near = (a, b, tol = 1e-6) => Math.abs(a - b) < tol;

test('archi: freccia, imposta e intradosso', () => {
  const ts = { width: 1.2, height: 2.4, head: 'tutto-sesto' };
  assert.equal(O.archRise(ts), 0.6);
  assert.ok(near(O.springHeight(ts), 1.8));
  // in chiave l'altezza del vano, all'imposta quella dell'imposta, a metà il cerchio
  assert.ok(near(O.headAt(ts, 0), 2.4));
  assert.ok(near(O.headAt(ts, 0.6), 1.8));
  assert.ok(near(O.headAt(ts, 0.3), 1.8 + Math.sqrt(0.36 - 0.09)));
  // ribassato: freccia scelta, proposta a un quinto della luce, mai oltre metà luce
  const rb = { width: 2, height: 2.5, head: 'ribassato', rise: 0.4 };
  assert.equal(O.archRise(rb), 0.4);
  assert.equal(O.archRise({ ...rb, rise: undefined }), 0.4);
  assert.equal(O.archRise({ ...rb, rise: 3 }), 1);
  assert.ok(near(O.headAt(rb, 0), 2.5) && near(O.headAt(rb, 1), 2.1));
  // testa piana: nessuna freccia
  assert.equal(O.archRise({ width: 1, height: 2 }), 0);
  assert.equal(O.headAt({ width: 1, height: 2 }, 0.4), 2);
  // il profilo va da un'imposta all'altra passando per la chiave
  const pr = O.archProfile(rb);
  assert.ok(near(pr[0].x, -1) && near(pr[0].h, 2.1) && near(pr.at(-1).x, 1) && near(pr.at(-1).h, 2.1));
  assert.ok(pr.every((q) => near(q.h, O.headAt(rb, q.x), 1e-9)));
});

test('archi: area del vano (rapporti aeroilluminanti, deduzioni dal muro)', () => {
  // tutto sesto: rettangolo fino all'imposta più mezzo cerchio
  const ts = { width: 1.2, height: 2.4, sill: 0, head: 'tutto-sesto' };
  assert.ok(near(O.openingArea(ts), 1.2 * 1.8 + (Math.PI * 0.36) / 2));
  // ribassato: tra il rettangolo all'imposta e quello in chiave
  const rb = { width: 2, height: 2.5, sill: 0, head: 'ribassato', rise: 0.4 };
  assert.ok(O.openingArea(rb) > 2 * 2.1 && O.openingArea(rb) < 2 * 2.5);
  // tagliato dalla cima del muro: sotto l'imposta un rettangolo, in mezzo l'integrale
  assert.ok(near(O.openingAreaIn(ts, 1.5), 1.2 * 1.5));
  assert.ok(near(O.openingAreaIn(ts, 3), O.openingArea(ts)));
  const mid = O.openingAreaIn(ts, 2.1);
  assert.ok(mid > 1.2 * 1.8 && mid < O.openingArea(ts));
  // nel computo il muro deduce il vano ad arco
  const p = sampleProject();
  const win = p.catalog.opening.find((t) => t.id === 'ot_fin');
  const net = () => wallSchedule(p).reduce((t, r) => t + r.netArea, 0);
  const before = net();
  win.head = 'tutto-sesto';
  const n = p.elements.filter((e) => e.kind === 'opening' && e.typeId === 'ot_fin').length;
  // ogni finestra deduce meno muro: i due spigoli sopra l'arco restano pieni
  assert.ok(near(net() - before, n * (1.2 * 1.5 - O.openingArea(win)), 1e-6), 'con l’arco si deduce meno muro');
  assert.ok(n > 0);
});

test('archi: il tipo resta nel file, i valori non validi si scartano', () => {
  const p = sampleProject();
  p.catalog.opening.find((t) => t.id === 'ot_pf').head = 'ribassato';
  p.catalog.opening.find((t) => t.id === 'ot_pf').rise = 0.3;
  p.catalog.opening.find((t) => t.id === 'ot_fin').head = 'gotico';
  const { project } = validateProject(JSON.parse(JSON.stringify(p)));
  const pf = project.catalog.opening.find((t) => t.id === 'ot_pf');
  assert.equal(pf.head, 'ribassato');
  assert.equal(pf.rise, 0.3);
  assert.equal(project.catalog.opening.find((t) => t.id === 'ot_fin').head, undefined);
});

test.after(() => server.close());
