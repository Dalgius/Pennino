// Test di locali, stati di progetto, categorie di vista, controlli di coerenza. Esecuzione: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({ root, logLevel: 'error', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
const R = await server.ssrLoadModule('/src/model/rooms.ts');
const S = await server.ssrLoadModule('/src/model/states.ts');
const Ly = await server.ssrLoadModule('/src/model/layers.ts');
const { checkModel } = await server.ssrLoadModule('/src/model/checks.ts');
const { computeComputo } = await server.ssrLoadModule('/src/model/quantities.ts');
const { validateProject } = await server.ssrLoadModule('/src/model/validate.ts');
const { sampleProject } = await server.ssrLoadModule('/src/model/defaults.ts');

const L0 = 'lvl_pt';
const L1 = 'lvl_p1';
const near = (a, b, t = 1e-2) => Math.abs(a - b) < t;
const room = (levelId, x, y, use = 'Camera') => ({ id: `loc_${x}_${y}`, levelId, p: { x, y }, name: 'Prova', use });
const wallAt = (p, levelId, f) => p.elements.find((e) => e.kind === 'wall' && e.levelId === levelId && f(e));
const thick = (p, w) => p.catalog.wall.find((t) => t.id === w.typeId).layers.reduce((s, l) => s + l.thickness, 0);

// ───────── Locali ─────────

test('locale: superficie netta al filo interno dei muri', () => {
  const p = sampleProject();
  // vano a sud-est del piano primo: tra il tramezzo x = 6, il tramezzo y = 4,5 e i muri esterni
  const ext = thick(p, wallAt(p, L1, (w) => near(w.a.y, 0) && near(w.b.y, 0)));
  const tr = thick(p, wallAt(p, L1, (w) => near(w.a.x, 6) && near(w.b.x, 6)));
  const info = R.roomInfo(p, room(L1, 9, 2));
  assert.ok(info.shape, 'vano chiuso');
  assert.equal(info.shape.axis.length, 4);
  assert.ok(near(info.area, (6 - ext / 2 - tr / 2) * (4.5 - ext / 2 - tr / 2)), `area ${info.area}`);
  assert.ok(info.windowArea > 0 && info.ratio > 0, 'conta le finestre dei suoi muri');
  // lo stesso vano da qualunque punto interno
  assert.ok(near(R.roomInfo(p, room(L1, 11, 4)).area, info.area));
});

test('locale: fuori dai muri o con un muro mancante il vano non è chiuso', () => {
  const p = sampleProject();
  assert.equal(R.roomInfo(p, room(L1, 30, 30)).shape, null);
  assert.equal(R.roomInfo(p, room(L1, 3, -1.5)).shape, null, 'il balcone non è un vano');
  // togliendo il tramezzo i due vani diventano uno
  const before = R.roomInfo(p, room(L1, 9, 2)).area;
  const tr = wallAt(p, L1, (w) => near(w.a.y, 4.5) && near(w.b.y, 4.5));
  p.elements = p.elements.filter((e) => e.id !== tr.id && e.wallId !== tr.id);
  const merged = R.roomInfo(p, room(L1, 9, 2));
  assert.ok(merged.shape && merged.area > before * 1.8, 'ora comprende anche il vano accanto');
  // togliendo un muro esterno il vano si apre
  const south = wallAt(p, L1, (w) => near(w.a.y, 0) && near(w.b.y, 0));
  p.elements = p.elements.filter((e) => e.id !== south.id && e.wallId !== south.id);
  assert.equal(R.roomInfo(p, room(L1, 9, 2)).shape, null);
});

test('locale: un muro che finisce nel vuoto non divide il vano', () => {
  const p = sampleProject();
  const a = R.roomInfo(p, room(L1, 3, 2)).area;
  const wt = p.elements.find((e) => e.kind === 'wall').typeId;
  p.elements.push({ id: 'spina', kind: 'wall', levelId: L1, typeId: wt, a: { x: 0, y: 5 }, b: { x: 2.5, y: 5 } });
  const b = R.roomInfo(p, room(L1, 3, 2));
  assert.ok(b.shape && near(b.area, a, 0.05), 'stesso vano, stessa superficie');
});

// ───────── Stati ─────────

test('stati: stato di fatto, progetto e computo della sola nuova costruzione', () => {
  const p = sampleProject();
  assert.equal(S.projectInState(p, 'fatto'), p, 'senza stati il progetto resta com’è');
  const walls = p.elements.filter((e) => e.kind === 'wall' && e.levelId === L1);
  const total = computeComputo(p).reduce((s, l) => s + l.amount, 0);
  for (const e of p.elements) e.status = 'esistente';
  const demo = walls[4];
  const nuovo = walls[5];
  demo.status = 'demolito';
  delete nuovo.status;
  const fatto = S.projectInState(p, 'fatto');
  const progetto = S.projectInState(p, 'progetto');
  assert.ok(fatto.elements.some((e) => e.id === demo.id) && !fatto.elements.some((e) => e.id === nuovo.id));
  assert.ok(progetto.elements.some((e) => e.id === nuovo.id) && !progetto.elements.some((e) => e.id === demo.id));
  assert.ok(!progetto.elements.some((e) => e.kind === 'opening' && e.wallId === demo.id), 'le aperture seguono il muro demolito');
  assert.equal(S.projectInState(p, 'comparativa'), p);
  const onlyNew = computeComputo(p).reduce((s, l) => s + l.amount, 0);
  assert.ok(onlyNew > 0 && onlyNew < total * 0.2, `si computa solo il nuovo (${onlyNew.toFixed(0)} su ${total.toFixed(0)})`);
});

// ───────── Categorie di vista ─────────

test('categorie: nascondere una categoria toglie i suoi elementi; simili per tipologia', () => {
  const p = sampleProject();
  p.rooms = [room(L1, 9, 2)];
  p.annotations = [{ id: 'q1', kind: 'quota', levelId: L1, a: { x: 0, y: 0 }, b: { x: 4, y: 0 }, offset: 1 }];
  const q = Ly.withoutLayers(p, ['solai', 'locali']);
  assert.ok(!q.elements.some((e) => e.kind === 'slab') && q.elements.some((e) => e.kind === 'wall'));
  assert.deepEqual(q.rooms, []);
  assert.equal(q.annotations.length, 1);
  assert.equal(Ly.withoutLayers(p, []), p);
  // etichetta del locale e linea di quota si prendono con un clic
  assert.equal(Ly.hitExtras(p, L1, { x: 9.1, y: 1.95 }, 0.25), p.rooms[0].id);
  assert.equal(Ly.hitExtras(p, L1, { x: 2, y: 1.05 }, 0.25), 'q1');
  assert.equal(Ly.hitExtras(p, L0, { x: 2, y: 1.05 }, 0.25), null, 'solo sul loro livello');
  const ext = p.elements.find((e) => e.kind === 'wall' && e.levelId === L1);
  const sim = Ly.similarElements(p, ext.id);
  assert.ok(sim.length >= 2 && sim.every((id) => { const w = p.elements.find((e) => e.id === id); return w.typeId === ext.typeId && w.levelId === L1; }));
});

// ───────── Controlli di coerenza ─────────

test('controlli: l’esempio è pulito, i difetti vengono segnalati', () => {
  assert.deepEqual(checkModel(sampleProject()), []);
  const p = sampleProject();
  const wt = p.elements.find((e) => e.kind === 'wall').typeId;
  // muro che si ferma a 6 cm dalla faccia di un altro
  p.elements.push({ id: 'quasi', kind: 'wall', levelId: L0, typeId: wt, a: { x: 3, y: 4 }, b: { x: 3, y: 8.725 } });
  // due aperture sovrapposte e una fuori dal muro
  const host = p.elements.find((e) => e.kind === 'wall' && e.levelId === L1 && p.elements.some((o) => o.kind === 'opening' && o.wallId === e.id));
  const op = p.elements.find((o) => o.kind === 'opening' && o.wallId === host.id);
  p.elements.push({ ...op, id: 'doppia', offset: op.offset + 0.3 }, { ...op, id: 'fuori', offset: -0.1 });
  // solaio in quota senza niente sotto, locale non chiuso e locale senza finestre
  p.elements.push({ id: 'volante', kind: 'slab', levelId: L1, typeId: p.elements.find((e) => e.kind === 'slab').typeId, points: [{ x: 40, y: 40 }, { x: 44, y: 40 }, { x: 44, y: 44 }, { x: 40, y: 44 }] });
  p.rooms = [{ ...room(L1, 30, 30), id: 'aperto' }];
  const issues = checkModel(p);
  const has = (id, re) => issues.some((i) => i.id === id && re.test(i.text));
  assert.ok(has('quasi', /senza collegarsi/), 'giunzione mancata');
  assert.ok(has('doppia', /sovrapposte/) || issues.some((i) => /sovrapposte/.test(i.text)), 'aperture sovrapposte');
  assert.ok(has('fuori', /esce dal muro/), 'apertura fuori dal muro');
  assert.ok(has('volante', /senza muri, travi o pilastri/), 'solaio non sostenuto');
  assert.ok(has('aperto', /non chiudono/), 'locale non chiuso');
});

// ───────── File di progetto ─────────

test('file: locali, annotazioni, stati e quote nascoste sopravvivono a salvataggio e riapertura', () => {
  const p = sampleProject();
  p.rooms = [room(L1, 9, 2), { ...room(L1, 1, 1), id: 'orfano', levelId: 'inesistente' }];
  p.annotations = [
    { id: 'q1', kind: 'quota', levelId: L1, a: { x: 0, y: 0 }, b: { x: 4, y: 0 }, offset: 1 },
    { id: 't1', kind: 'testo', levelId: L0, p: { x: 1, y: 1 }, text: 'Nota', leader: { x: 2, y: 2 } },
    { id: 'h1', kind: 'altimetrica', levelId: L0, p: { x: 1, y: 1 }, dz: -0.05 },
    { id: 'rotta', kind: 'quota', levelId: L1, a: { x: 0, y: 0 } },
  ];
  p.hiddenDims = ['w1:1'];
  p.elements[0].status = 'esistente';
  p.sheets[0].revisions = [{ rev: '01', date: '2026-01-10', note: 'Prima emissione' }];
  const { project: q } = validateProject(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(q.rooms.map((r) => r.id), [p.rooms[0].id]);
  assert.deepEqual(q.annotations.map((n) => n.id), ['q1', 't1', 'h1']);
  assert.deepEqual(q.hiddenDims, ['w1:1']);
  assert.equal(q.elements[0].status, 'esistente');
  assert.equal(q.sheets[0].revisions[0].note, 'Prima emissione');
});

test.after(() => server.close());
