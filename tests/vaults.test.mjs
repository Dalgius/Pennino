// Test delle volte a botte e a crociera: geometria, quantità, salvataggio, disegni. Esecuzione: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(new URL('../package.json', import.meta.url));
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const server = await createServer({ root, logLevel: 'error', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
const V = await server.ssrLoadModule('/src/model/vaults.ts');
const { dragRectCorner } = await server.ssrLoadModule('/src/model/edit.ts');
const { computeComputo } = await server.ssrLoadModule('/src/model/quantities.ts');
const { validateProject } = await server.ssrLoadModule('/src/model/validate.ts');
const { roomShape, roomInfo } = await server.ssrLoadModule('/src/model/rooms.ts');
const { checkModel: checkProject } = await server.ssrLoadModule('/src/model/checks.ts');
const { sampleProject } = await server.ssrLoadModule('/src/model/defaults.ts');
const { SectionView } = await server.ssrLoadModule('/src/views/SectionView.tsx');
const { PlanView } = await server.ssrLoadModule('/src/views/PlanView.tsx');

const near = (a, b, tol = 1e-6) => Math.abs(a - b) < tol;
const L0 = 'lvl_pt';

/** Volta su un campo 4 × 6 (x da 2 a 6, y da 1 a 7) del piano terra */
function withVault(extra = {}) {
  const p = sampleProject();
  const v = { id: 'v1', kind: 'vault', levelId: L0, typeId: 'vt_mattoni', points: [{ x: 2, y: 1 }, { x: 6, y: 1 }, { x: 6, y: 7 }, { x: 2, y: 7 }], shape: 'botte', spring: 1.8, rise: 1, ...extra };
  p.elements.push(v);
  return { p, v };
}

test('volte: botte, archi di cerchio dalle imposte alla chiave', () => {
  const { v } = withVault({ axis: 1 }); // generatrici lungo y: luce 4 m lungo x
  const fr = V.vaultFrame(v);
  assert.ok(near(fr.L1, 4) && near(fr.L2, 6));
  assert.equal(V.vaultSpans(v).span, 4);
  // freccia 1 su luce 4: ribassata; in chiave e alle imposte
  assert.ok(near(V.vaultHeightLocal(v, 2, 3), 1));
  assert.ok(near(V.vaultHeightLocal(v, 0, 3), 0) && near(V.vaultHeightLocal(v, 4, 3), 0));
  // lungo le generatrici l'altezza non cambia
  assert.ok(near(V.vaultHeightLocal(v, 1, 0.5), V.vaultHeightLocal(v, 1, 5.5)));
  // automatica: generatrici lungo il lato lungo
  assert.equal(V.vaultSpans({ ...v, axis: undefined }).generatrix, 1);
  // la freccia non supera metà della luce: oltre, tutto sesto
  assert.ok(near(V.vaultRise({ ...v, rise: 5 }), 2));
  assert.ok(near(V.vaultHeightLocal({ ...v, rise: 2 }, 1, 3), Math.sqrt(4 - 1)));
});

test('volte: crociera, due botti con la stessa chiave', () => {
  const { v } = withVault({ shape: 'crociera', rise: 2 });
  // agli angoli le imposte, al centro la chiave, a metà dei lati l'arco in chiave (lunette)
  assert.ok(near(V.vaultHeightLocal(v, 0, 0), 0));
  assert.ok(near(V.vaultHeightLocal(v, 2, 3), 2));
  assert.ok(near(V.vaultHeightLocal(v, 2, 0), 2) && near(V.vaultHeightLocal(v, 0, 3), 2));
  // sulla diagonale le due botti si incontrano: stessa altezza
  const t = 0.3;
  const a = 4 * t;
  const b = 6 * t;
  // l'arco del lato lungo è quello del lato corto stirato: sulla diagonale le due altezze coincidono
  const h1 = V.arcRise(((b - 3) * 4) / 6, 4, 2);
  const h2 = V.arcRise(a - 2, 4, 2);
  assert.ok(near(h1, h2, 1e-9) && near(V.vaultHeightLocal(v, a, b), h1));
  // freccia limitata dal lato corto
  assert.ok(near(V.vaultRise({ ...v, rise: 3 }), 2));
});

test('volte: padiglione, fusi dai quattro lati con spigoli a 45° e colmo sul lato lungo', () => {
  const { v } = withVault({ shape: 'padiglione', rise: 2 }); // campo 4 × 6, tutto sesto sulla luce 4
  // l'imposta corre su tutti i lati
  for (const [a, b] of [[2, 0], [2, 6], [0, 3], [4, 3], [0, 0]]) assert.ok(near(V.vaultHeightLocal(v, a, b), 0), `imposta in ${a},${b}`);
  // in mezzo il colmo, in piano lungo il lato lungo tra i due fusi di testata
  assert.ok(near(V.vaultHeightLocal(v, 2, 3), 2) && near(V.vaultHeightLocal(v, 2, 2.2), 2) && near(V.vaultHeightLocal(v, 2, 3.8), 2));
  // sezione trasversale nel tratto di botte: l'arco a tutto sesto
  assert.ok(near(V.vaultHeightLocal(v, 1, 3), Math.sqrt(3)));
  // spigolo a 45° dall'angolo: i due fusi alla stessa altezza
  assert.ok(near(V.vaultHeightLocal(v, 1, 1), Math.sqrt(3)));
  assert.ok(V.vaultHeightLocal(v, 1, 1.2) < V.vaultHeightLocal(v, 1.2, 1.2) + 1e-9);
  // freccia limitata dal lato corto
  assert.ok(near(V.vaultMaxRise(v), 2));
});

test('volte: vela, calotta sferica per i quattro angoli', () => {
  const { v } = withVault({ shape: 'vela', points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }], rise: 9 });
  const d = Math.SQRT2 * 2;
  // a tutto sesto: emisfero di raggio metà diagonale
  assert.ok(near(V.vaultMaxRise(v), d) && near(V.vaultRise(v), d));
  assert.ok(near(V.vaultHeightLocal(v, 0, 0), 0) && near(V.vaultHeightLocal(v, 4, 4), 0));
  assert.ok(near(V.vaultHeightLocal(v, 2, 2), d));
  // a metà dei lati la chiave degli archi di testata
  assert.ok(near(V.vaultHeightLocal(v, 2, 0), 2) && near(V.vaultHeightLocal(v, 0, 2), 2));
  // ribassata: la chiave scende, gli angoli restano all'imposta
  const low = { ...v, rise: 1 };
  assert.ok(near(V.vaultHeightLocal(low, 2, 2), 1) && near(V.vaultHeightLocal(low, 0, 0), 0));
});

test('volte: crociera e padiglione si dividono le due botti', () => {
  // su un campo quadrato a tutto sesto le superfici delle due volte sommano quelle delle due botti:
  // il padiglione (parte comune) vale 8 r², la crociera il resto
  const r = 2;
  const sq = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }];
  const pad = withVault({ shape: 'padiglione', points: sq, rise: r });
  const cro = withVault({ shape: 'crociera', points: sq, rise: r });
  const aPad = V.vaultQuantities(pad.p, pad.v, 256).area;
  const aCro = V.vaultQuantities(cro.p, cro.v, 256).area;
  assert.ok(near(aPad, 8 * r * r, 0.1), `padiglione ${aPad}`);
  assert.ok(near(aPad + aCro, 2 * Math.PI * r * 2 * r, 0.2), `somma ${aPad + aCro}`);
});

test('volte: superficie d’intradosso e rinfianco', () => {
  // botte a tutto sesto r = 2 lunga 6: mezzo cilindro
  const { p, v } = withVault({ axis: 1, rise: 2 });
  const q = V.vaultQuantities(p, v, 256);
  assert.ok(near(q.area, Math.PI * 2 * 6, 0.05), `superficie ${q.area}`);
  assert.ok(near(q.fill, (2 * 4 - (Math.PI * 4) / 2) * 6, 0.02), `rinfianco ${q.fill}`);
  assert.ok(near(q.plan, 24));
  // nel computo: volta a m² d'intradosso, rinfianco a m³
  const rows = computeComputo(p);
  const vol = rows.find((r) => r.code === 'VOL.01');
  const fill = rows.find((r) => r.code === 'VOL.03');
  assert.ok(vol && near(vol.qty, V.vaultQuantities(p, v).area, 1e-6));
  assert.ok(fill && near(fill.qty, V.vaultQuantities(p, v).fill, 1e-6));
  assert.equal(vol.category, 'Volte');
});

test('volte: trascinando un angolo il campo resta rettangolare', () => {
  const { v } = withVault();
  const out = dragRectCorner(v.points, 2, { x: 7.3, y: 8.2 });
  assert.deepEqual(out[0], v.points[0]);
  assert.ok(near(out[2].x, 7.3) && near(out[2].y, 8.2));
  assert.ok(near(out[1].x, 7.3) && near(out[1].y, 1) && near(out[3].x, 2) && near(out[3].y, 8.2));
  // campo ruotato: i lati restano paralleli a quelli di prima
  const c = Math.cos(0.5);
  const s = Math.sin(0.5);
  const rot = v.points.map((q) => ({ x: q.x * c - q.y * s, y: q.x * s + q.y * c }));
  const r2 = dragRectCorner(rot, 1, { x: 9, y: 4 });
  for (let i = 0; i < 4; i++) {
    const a = r2[i];
    const b = r2[(i + 1) % 4];
    const d = r2[(i + 3) % 4];
    assert.ok(near((b.x - a.x) * (d.x - a.x) + (b.y - a.y) * (d.y - a.y), 0, 1e-9), 'angoli retti');
  }
});

test('volte: salvate nel file; i progetti precedenti si aprono senza avvisi', () => {
  const { p } = withVault({ shape: 'crociera', axis: 0 });
  const { project, warnings } = validateProject(JSON.parse(JSON.stringify(p)));
  const v = project.elements.find((e) => e.id === 'v1');
  assert.equal(v.shape, 'crociera');
  assert.equal(v.spring, 1.8);
  assert.deepEqual(warnings, []);
  // progetto senza volte né loro voci di prezzo
  const old = JSON.parse(JSON.stringify(sampleProject()));
  delete old.catalog.vault;
  old.prices = old.prices.filter((x) => x.category !== 'Volte');
  const r = validateProject(old);
  assert.ok(r.project.catalog.vault.length > 0);
  assert.ok(r.project.prices.some((x) => x.code === 'VOL.01'));
  assert.ok(!r.warnings.some((w) => /vault/.test(w)), r.warnings.join(' · '));
  // le nuove forme restano nel file
  for (const shape of ['padiglione', 'vela']) {
    const q = JSON.parse(JSON.stringify(p));
    q.elements.find((e) => e.id === 'v1').shape = shape;
    assert.equal(validateProject(q).project.elements.find((e) => e.id === 'v1').shape, shape);
  }
  // volte non valide si scartano
  const bad = JSON.parse(JSON.stringify(p));
  bad.elements.find((e) => e.id === 'v1').shape = 'cupola';
  assert.ok(!validateProject(bad).project.elements.some((e) => e.id === 'v1'));
});

test('volte: proposta su un vano chiuso, altezza media del locale, controllo della chiave', () => {
  const p = sampleProject();
  // un vano chiuso del piano terra
  let shape = null;
  let seed = null;
  for (let x = 0.5; x < 12 && !shape; x += 0.5)
    for (let y = 0.5; y < 10 && !shape; y += 0.5) {
      const s = roomShape(p, L0, { x, y });
      if (s && s.net.length === 4) {
        shape = s;
        // etichetta del locale al centro del vano
        seed = { x: s.net.reduce((t, q) => t + q.x, 0) / 4, y: s.net.reduce((t, q) => t + q.y, 0) / 4 };
      }
    }
  assert.ok(shape, 'vano rettangolare');
  const d = V.defaultVault(p, L0, shape.net, 'botte', 'vt_mattoni');
  const lvl = p.levels.find((l) => l.id === L0);
  // la chiave con lo spessore sta sotto l'intradosso del solaio sopra, l'imposta non sotto i 2,20 m
  const above = p.elements.find((e) => e.kind === 'slab' && e.levelId === 'lvl_p1');
  const slabTh = p.catalog.slab.find((t) => t.id === above.typeId).thickness;
  assert.ok(d.spring + d.rise + 0.06 <= lvl.height - slabTh + 1e-9, `${d.spring + d.rise + 0.06} > ${lvl.height - slabTh}`);
  assert.ok(d.spring >= 2.2 - 1e-9);
  p.elements.push({ id: 'v2', kind: 'vault', levelId: L0, typeId: 'vt_mattoni', ...d });
  // altezza media del locale sotto la volta
  p.rooms = [{ id: 'r1', levelId: L0, p: seed, name: 'Sala', use: 'Soggiorno' }];
  const info = roomInfo(p, p.rooms[0]);
  assert.ok(info.vaulted, JSON.stringify({ seed, net: shape.net, h: info.height }));
  assert.ok(info.height > d.spring && info.height < d.spring + d.rise);
  // volta troppo alta: avviso
  const v = p.elements.find((e) => e.id === 'v2');
  assert.ok(!checkProject(p).some((x) => x.id === 'v2'));
  v.spring = lvl.height;
  assert.ok(checkProject(p).some((x) => x.id === 'v2'));
});

test('volte: in pianta tratteggiate con imposte e chiave; in sezione il guscio tagliato', () => {
  const { p, v } = withVault({ axis: 1, rise: 1 });
  const plan = renderToStaticMarkup(React.createElement('svg', null, React.createElement(PlanView, { project: p, levelId: L0, mm: 0.1 })));
  const lines = [...plan.matchAll(/<(?:polyline|polygon)[^>]*class="pv-vault-line"[^>]*>/g)];
  // contorno, due imposte, chiave
  assert.equal(lines.length, 4);
  assert.ok(lines.every((m) => /stroke-dasharray/.test(m[0])));
  assert.match(plan, /imp\. \+1,80 · chiave \+2,80/);
  // vela: il cerchio inscritto; padiglione su campo rettangolare: quattro spigoli e il colmo
  v.shape = 'vela';
  const pv = renderToStaticMarkup(React.createElement('svg', null, React.createElement(PlanView, { project: p, levelId: L0, mm: 0.1 })));
  assert.match(pv, /<circle[^>]*r="2"[^>]*class="pv-vault-line"/);
  assert.match(pv, /volta a vela/);
  v.shape = 'padiglione';
  const pp = renderToStaticMarkup(React.createElement('svg', null, React.createElement(PlanView, { project: p, levelId: L0, mm: 0.1 })));
  assert.equal([...pp.matchAll(/<(?:polyline|polygon)[^>]*class="pv-vault-line"/g)].length, 1 + 4 + 1);
  v.shape = 'botte';
  // sezione trasversale a metà del campo (y = 4), guardando verso +y
  const sec = { id: 's', name: 'S', a: { x: 0, y: 4 }, b: { x: 12, y: 4 }, depth: 0.5, flip: false };
  const svg = renderToStaticMarkup(React.createElement('svg', null, React.createElement(SectionView, { project: p, section: sec, mm: 0.1 })));
  const lv = V.vaultLevels(p, v);
  const polys = [...svg.matchAll(/<polygon points="([^"]+)"[^>]*class="sc-cut"/g)].map((m) => m[1].split(/[ ,]/).map(Number));
  const shell = polys.find((v2) => {
    const zs = v2.filter((_, k) => k % 2 === 1).map((y) => -y);
    return near(Math.min(...zs), lv.spring, 1e-6) && near(Math.max(...zs), lv.key + lv.th, 1e-6);
  });
  assert.ok(shell, 'guscio dall’imposta all’estradosso in chiave');
  // rinfianco fino all'orizzontale della chiave
  assert.match(svg, new RegExp(`${lv.top}`.slice(0, 5).replace('.', '\\.')));
});

test.after(() => server.close());
