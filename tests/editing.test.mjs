// Test di aggancio, trascinamenti, selezione, validazione e cache della geometria. Esecuzione: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { freeze, produce } from 'immer';

const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({ root, logLevel: 'error', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
const E = await server.ssrLoadModule('/src/model/edit.ts');
const D = await server.ssrLoadModule('/src/model/dragging.ts');
const W = await server.ssrLoadModule('/src/model/walls.ts');
const { validateProject, ProjectFormatError } = await server.ssrLoadModule('/src/model/validate.ts');
const { fitWallOpenings } = await server.ssrLoadModule('/src/model/openingFit.ts');
const { computeDimensions } = await server.ssrLoadModule('/src/model/dimensions.ts');
const { sampleProject } = await server.ssrLoadModule('/src/model/defaults.ts');

const L0 = 'lvl_pt';
const L1 = 'lvl_p1';
const near = (a, b, t = 1e-3) => Math.abs(a - b) < t;
const at = (p, x, y, t = 1e-3) => near(p.x, x, t) && near(p.y, y, t);

/** Agganci del piano primo con la struttura del piano terra, come nell'editor */
function context(p, level = L1, below = L0, extra = {}) {
  return {
    candidates: [...E.snapPoints(p, level), ...(below ? E.snapPoints(p, below) : [])],
    segments: [...E.snapSegments(p, level), ...(below ? E.snapSegments(p, below) : [])],
    tol: 0.25,
    grid: 0,
    ortho: false,
    alt: false,
    ...extra,
  };
}
const balcony = (p) => p.elements.find((e) => e.kind === 'slab' && e.levelId === L1);

// ───────── Aggancio ─────────

test('aggancio: estremo, spigolo e faccia di un muro', () => {
  const p = sampleProject();
  const c = context(p, L0, null);
  // angolo dell'edificio: l'estremo d'asse è in (0,0), lo spigolo esterno poco fuori
  assert.equal(E.snapModel({ x: 0.03, y: 0.02 }, c).kind, 'estremo');
  const corner = E.snapModel({ x: -0.24, y: -0.22 }, c);
  assert.equal(corner.kind, 'spigolo');
  assert.ok(corner.p.x < -0.1 && corner.p.y < -0.1, 'spigolo esterno');
  // a metà del muro sud, appena fuori dalla faccia esterna: sul bordo, non sull'asse
  const face = E.snapModel({ x: 5.2, y: corner.p.y - 0.03 }, c);
  assert.equal(face.kind, 'bordo');
  assert.ok(near(face.p.y, corner.p.y), 'sulla faccia esterna');
  // al centro dello spessore vince l'asse
  const axis = E.snapModel({ x: 5.2, y: 0.01 }, c);
  assert.equal(axis.kind, 'muro');
  assert.ok(near(axis.p.y, 0));
});

test('aggancio: disegnando muri e travi le facce dei muri non contano', () => {
  const p = sampleProject();
  const c = context(p, L0, null);
  const axial = { ...c, candidates: c.candidates.filter((k) => k.kind !== 'spigolo'), segments: c.segments.filter((g) => !g.face || g.column) };
  const s = E.snapModel({ x: 5.2, y: -0.25 }, axial);
  assert.equal(s.kind, 'muro', 'si aggancia all’asse, così nasce la giunzione a T');
  assert.ok(near(s.p.y, 0));
});

test('aggancio: senza griglia e senza oggetti vicini il punto resta libero', () => {
  const p = sampleProject();
  const s = E.snapModel({ x: 30.123, y: 40.456 }, context(p, L0, null));
  assert.ok(at(s.p, 30.123, 40.456));
});

test('pilastro sotto il cursore: centro se dentro, niente se fuori', () => {
  const p = sampleProject();
  const col = p.elements.find((e) => e.kind === 'column');
  const inside = E.columnUnder(p, [L0], { x: col.p.x + 0.1, y: col.p.y - 0.08 });
  assert.ok(inside && at(inside.p, col.p.x, col.p.y));
  assert.equal(E.columnUnder(p, [L0], { x: col.p.x + 0.4, y: col.p.y }), null);
  assert.equal(E.columnUnder(p, [L1], { x: col.p.x, y: col.p.y }), null, 'solo sui livelli richiesti');
});

// ───────── Trascinamenti ─────────

test('vertice di un solaio in ortogonale: moto continuo, senza scatti', () => {
  const p = freeze(sampleProject(), true);
  const s = balcony(p);
  const i = s.points.findIndex((q) => at(q, 6.2, -2.6));
  const c = { ...context(p), ortho: true, columnLevels: [L1, L0] };
  let prev = 6.2;
  for (let k = 1; k <= 12; k++) {
    // lontano dagli oggetti: tra i pilastri del piano terra, sotto il balcone
    const r = D.dragHandle(p, s.id, i, { x: 6.2 + 0.4 + k * 0.037, y: -2.62 }, c);
    assert.ok(near(r.snap.p.y, -2.6), 'resta sull’orizzontale di partenza');
    assert.ok(r.snap.p.x > prev + 0.02, `avanza a ogni passo (${r.snap.p.x.toFixed(3)})`);
    prev = r.snap.p.x;
  }
});

test('vertice di un solaio: si aggancia a estremi e facce del piano sotto', () => {
  const p = freeze(sampleProject(), true);
  const s = balcony(p);
  const i = s.points.findIndex((q) => at(q, 6.2, -2.6));
  const c = { ...context(p), ortho: true, columnLevels: [L1, L0] };
  const end = D.dragHandle(p, s.id, i, { x: 8.03, y: -0.04 }, c);
  assert.equal(end.snap.kind, 'estremo');
  assert.ok(at(end.snap.p, 8, 0));
  // salendo in verticale verso il muro sud: si ferma sulla sua faccia esterna
  const face = D.dragHandle(p, s.id, i, { x: 6.22, y: -0.27 }, c);
  assert.equal(face.snap.kind, 'bordo');
  assert.ok(near(face.snap.p.x, 6.2) && face.snap.p.y < -0.1 && face.snap.p.y > -0.3);
});

test('lato di un solaio: parallelo a sé stesso, passa per il punto agganciato', () => {
  const p = freeze(sampleProject(), true);
  const s = balcony(p);
  const i = s.points.findIndex((q) => at(q, 6.2, -2.6)); // lato est del balcone: (6.2,-2.6) → (6.2,0)
  const free = D.dragEdge(p, s.id, i, { x: 6.2, y: -1.3 }, { x: 7.0, y: -1.3 }, context(p));
  assert.ok(free.points.every(([, q]) => near(q.x, 7.0)), 'segue il cursore');
  assert.ok(near(free.points[0][1].y, -2.6) && near(free.points[1][1].y, 0), 'non scorre lungo sé stesso');
  const snapped = D.dragEdge(p, s.id, i, { x: 6.2, y: -1.3 }, { x: 7.97, y: -0.06 }, context(p));
  assert.equal(snapped.snap.kind, 'estremo');
  assert.ok(snapped.points.every(([, q]) => near(q.x, 8)), 'il lato passa per l’estremo in x = 8');
  const grid = D.dragEdge(p, s.id, i, { x: 6.2, y: -1.3 }, { x: 6.93, y: -1.3 }, context(p, L1, L0, { grid: 0.25 }));
  assert.ok(grid.points.every(([, q]) => near(q.x, 6.95)), 'con la griglia lo spostamento va a passi di 25 cm');
});

test('estremo di una trave: centro del pilastro dentro, lato del pilastro da fuori', () => {
  const p = freeze(sampleProject(), true);
  const beam = p.elements.find((e) => e.kind === 'beam');
  const c = { ...context(p, L0, null), ortho: true, columnLevels: [L0] };
  const inside = D.dragHandle(p, beam.id, 1, { x: 6.0, y: -2.5 }, c);
  assert.ok(at(inside.snap.p, 6.05, -2.45), 'centro del pilastro');
  const outside = D.dragHandle(p, beam.id, 1, { x: 5.6, y: -2.47 }, { ...c, tol: 0.4 });
  assert.equal(outside.snap.kind, 'bordo');
  assert.ok(at(outside.snap.p, 5.9, -2.45), 'sulla faccia del pilastro, restando sull’asse');
});

test('spostamento: ortogonale sull’asse prevalente, senza agganciarsi a sé stessi', () => {
  const p = freeze(sampleProject(), true);
  const col = p.elements.find((e) => e.kind === 'column');
  const c = context(p, L0, null);
  // pilastro e trave insieme: i loro punti (e il punto di presa) non attirano il cursore
  const beam = p.elements.find((e) => e.kind === 'beam');
  const d1 = D.dragMove(col.p, { x: col.p.x + 0.07, y: col.p.y + 0.02 }, [col.id, beam.id], c);
  assert.ok(near(d1.x, 0.07) && near(d1.y, 0.02), 'vicino alla partenza non resta incollato al proprio punto');
  const d2 = D.dragMove(col.p, { x: col.p.x + 1.3, y: col.p.y + 0.4 }, [col.id], { ...c, ortho: true });
  assert.ok(near(d2.x, 1.3) && d2.y === 0);
  const moved = D.translated(col, d2);
  assert.ok(near(moved.p.x, col.p.x + 1.3) && near(col.p.x, p.elements.find((e) => e.id === col.id).p.x), 'l’originale non cambia');
});

// ───────── Selezione ─────────

test('selezione: pilastri e travi del piano sotto si prendono dal piano superiore', () => {
  const p = sampleProject();
  const beam = p.elements.find((e) => e.kind === 'beam' && e.levelId === L0);
  const col = p.elements.find((e) => e.kind === 'column' && e.levelId === L0);
  assert.equal(E.hitTestModel(p, { x: 3, y: -2.45 }, L1, 0.05), beam.id);
  assert.equal(E.hitTestModel(p, { x: col.p.x, y: col.p.y }, L1, 0.05), col.id);
  assert.equal(E.hitTestModel(p, { x: 3, y: -2.45 }, L0, 0.05), beam.id, 'e dal loro piano');
  assert.equal(E.structureBelow(p, L0), null);
});

// ───────── Validazione ─────────

test('validazione: scarta gli elementi rotti e lo segnala, rifiuta i file estranei', () => {
  const raw = JSON.parse(JSON.stringify(sampleProject()));
  const n = raw.elements.length;
  raw.elements.push({ id: 'x1', kind: 'wall', levelId: 'inesistente', typeId: raw.elements[0].typeId, a: { x: 0, y: 0 }, b: { x: 1, y: 0 } });
  raw.elements.push({ id: 'x2', kind: 'opening', wallId: 'nessun-muro', typeId: raw.catalog.opening[0].id, offset: 1 });
  raw.elements.push({ id: 'x3', kind: 'column', levelId: L0, typeId: raw.catalog.column[0].id, p: { x: 'a', y: 0 } });
  const { project, warnings } = validateProject(raw);
  assert.equal(project.elements.length, n);
  assert.ok(warnings.some((w) => /3 elementi/.test(w)), 'avviso con il numero di elementi scartati');
  assert.throws(() => validateProject({ version: 99, levels: [], elements: [] }), ProjectFormatError);
  assert.throws(() => validateProject('testo'), ProjectFormatError);
  // un progetto valido passa senza avvisi
  assert.deepEqual(validateProject(JSON.parse(JSON.stringify(sampleProject()))).warnings, []);
});

// ───────── Aperture nel muro ─────────

test('aperture nel muro: distanziate quando cambia il muro, solo riportate dentro altrimenti', () => {
  const p = sampleProject();
  const wt = p.elements.find((e) => e.kind === 'wall').typeId;
  const door = p.catalog.opening.find((t) => near(t.width, 0.8));
  p.elements.push({ id: 'wx', kind: 'wall', levelId: L0, typeId: wt, a: { x: 20, y: 0 }, b: { x: 22, y: 0 } });
  p.elements.push({ id: 'o1', kind: 'opening', wallId: 'wx', typeId: door.id, offset: 3, flip: false });
  p.elements.push({ id: 'o2', kind: 'opening', wallId: 'wx', typeId: door.id, offset: 4, flip: false });
  const w = p.elements.find((e) => e.id === 'wx');
  const sep = fitWallOpenings(p, w, { separate: true });
  assert.ok(sep.ok && near(sep.offsets.get('o2'), 1.6) && near(sep.offsets.get('o1'), 0.8), 'affiancate in fondo al muro, nello stesso ordine');
  const clamp = fitWallOpenings(p, w, { separate: false });
  assert.ok(clamp.ok && near(clamp.offsets.get('o1'), 1.6) && near(clamp.offsets.get('o2'), 1.6), 'ciascuna solo riportata dentro');
  w.b = { x: 21.5, y: 0 };
  const short = fitWallOpenings(p, w, { separate: true });
  assert.ok(!short.ok && /troppo corto/.test(short.error));
});

// ───────── Cache e indice dei muri ─────────

test('cache: stessi risultati con il progetto congelato, aggiornati dopo una modifica', () => {
  const plain = sampleProject();
  const frozen = freeze(JSON.parse(JSON.stringify(plain)), true);
  const dims = (p) => JSON.stringify(computeDimensions(p, L1).map((c) => c.marks.map((m) => +m.s.toFixed(4))));
  const snaps = (p) => JSON.stringify(E.snapPoints(p, L1).map((c) => [c.kind, +c.p.x.toFixed(4), +c.p.y.toFixed(4)]));
  // gli id dell'esempio sono casuali: si confronta la geometria
  assert.equal(dims(frozen), dims(frozen), 'chiamate ripetute');
  assert.equal(E.snapPoints(frozen, L1), E.snapPoints(frozen, L1), 'la seconda chiamata riusa il risultato');
  assert.equal(snaps(frozen), snaps(JSON.parse(JSON.stringify(frozen))), 'con e senza cache');
  const w = frozen.elements.find((e) => e.kind === 'wall' && e.levelId === L1);
  const next = produce(frozen, (d) => {
    d.elements.find((e) => e.id === w.id).b.x += 0.5;
  });
  assert.notEqual(E.snapPoints(next, L1), E.snapPoints(frozen, L1));
  assert.equal(snaps(next), snaps(JSON.parse(JSON.stringify(next))), 'dopo la modifica il risultato è quello del nuovo progetto');
  assert.notEqual(snaps(next), snaps(frozen));
});

test('indice dei muri: stessi vicini di una ricerca completa', () => {
  const p = sampleProject();
  const wt = p.elements.find((e) => e.kind === 'wall').typeId;
  for (let i = 0; i < 12; i++)
    for (let j = 0; j < 12; j++) {
      p.elements.push({ id: `h${i}_${j}`, kind: 'wall', levelId: L0, typeId: wt, a: { x: 100 + j * 4, y: i * 4 }, b: { x: 104 + j * 4, y: i * 4 } });
      p.elements.push({ id: `v${i}_${j}`, kind: 'wall', levelId: L0, typeId: wt, a: { x: 100 + i * 4, y: j * 4 }, b: { x: 100 + i * 4, y: j * 4 + 4 } });
    }
  p.elements.push({ id: 'lungo', kind: 'wall', levelId: L0, typeId: wt, a: { x: -500, y: 2 }, b: { x: 900, y: 2 } });
  const walls = p.elements.filter((e) => e.kind === 'wall' && e.levelId === L0);
  const seg = (q, a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2));
    return Math.hypot(q.x - a.x - dx * t, q.y - a.y - dy * t);
  };
  for (const q of [{ x: 100, y: 0 }, { x: 124, y: 20 }, { x: 6, y: 0 }, { x: 113.3, y: 2 }, { x: 300, y: 300 }]) {
    const expected = walls.filter((w) => seg(q, w.a, w.b) < 0.05).map((w) => w.id);
    const found = new Set(W.wallsNear(p, L0, q).map((w) => w.id));
    for (const id of expected) assert.ok(found.has(id), `${id} vicino a (${q.x}, ${q.y})`);
  }
  assert.ok(W.wallsNear(p, L0, { x: 124, y: 20 }).length < 40, 'pochi candidati, non tutti i muri');
});

test.after(() => server.close());
