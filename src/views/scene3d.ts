// Costruzione della scena 3D a partire dal modello informativo.
// Mappatura assi: modello (x, y, z) → three.js (x, z, −y).

import { planeAt, roofGeom, type RoofGeom } from '../model/roofs';
import * as THREE from 'three';
import { norm, perp, sceneBounds, sub } from '../model/geometry';
import { axoFraming } from '../model/axo';
import { bandPolygon, endAt, startAt, wallGeom, type WallGeom } from '../model/walls';
import { archProfile, archRise, fixtureSpec, leafSpans, springHeight, THRESHOLD_NOSE } from '../model/openings';
import { vaultFrame, vaultHeightLocal, vaultLevels, vaultPoint, vaultThickness } from '../model/vaults';
import type { AxoCut, Opening, OpeningType, Project, Vault, Vec2, Wall } from '../model/types';
import {
  add,
  bbox,
  byId,
  mul,
  dist,
  openingSpans,
  roofOutline,
  roofWithEave,
  pointInPolygon,
  sunPosition,
  wallHeight,
  wallTopProfile,
  wallLength,
  slabOutline,
  slabHoles,
  stairLayout,
  flightProfile,
  LANDING_THICKNESS,
} from '../model/geometry';

export interface SceneOptions {
  /** Spaccato: piani di taglio applicati all'edificio (non al contesto) */
  cut?: AxoCut;
  /** Mostra solo i livelli con quota ≤ di questo valore */
  maxElevation?: number;
  context?: boolean;
  selectedIds?: string[];
  palette?: 'modello' | 'stampa';
}

const COLORS = {
  wall: 0xe9e4d8,
  wallStructure: 0xb5654a,
  slab: 0xbdbab3,
  column: 0xa7abb0,
  glass: 0x8ec5e6,
  door: 0x8a6a4a,
  roof: 0x9a5b45,
  roofFlat: 0x7e8f6a,
  stair: 0xcfcac0,
  vault: 0xd9cdb8,
  ground: 0xd9dcc9,
  lot: 0xc4c9b0,
  context: 0xd4d4d4,
  road: 0x8d8f93,
  tree: 0x7d9a64,
  selected: 0x38bdf8,
};

function mat(color: number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, ...opts });
}

/** Box orientato lungo un segmento del piano (lunghezza su asse locale X) */
function segmentBox(a: Vec2, b: Vec2, width: number, z0: number, z1: number, material: THREE.Material) {
  const L = dist(a, b);
  const geo = new THREE.BoxGeometry(L, z1 - z0, width);
  const m = new THREE.Mesh(geo, material);
  m.position.set((a.x + b.x) / 2, (z0 + z1) / 2, -(a.y + b.y) / 2);
  m.rotation.y = Math.atan2(b.y - a.y, b.x - a.x);
  return m;
}

function shapeFrom(points: Vec2[]) {
  const s = new THREE.Shape();
  points.forEach((p, i) => (i ? s.lineTo(p.x, p.y) : s.moveTo(p.x, p.y)));
  s.closePath();
  return s;
}

/**
 * Figura nel piano del muro (s lungo l'asse da a, z quota assoluta) estrusa attraverso lo spessore
 * tra gli scostamenti o0 < o1 dall'asse, con eventuali fori.
 */
function wallShapeMesh(w: Wall, g: WallGeom, outline: { s: number; z: number }[], o0: number, o1: number, material: THREE.Material, holes: { s: number; z: number }[][] = []) {
  const sh = new THREE.Shape();
  outline.forEach((q, i) => (i ? sh.lineTo(q.s, q.z) : sh.moveTo(q.s, q.z)));
  sh.closePath();
  for (const h of holes) {
    const path = new THREE.Path();
    h.forEach((q, i) => (i ? path.lineTo(q.s, q.z) : path.moveTo(q.s, q.z)));
    path.closePath();
    sh.holes.push(path);
  }
  const geo = new THREE.ExtrudeGeometry(sh, { depth: o1 - o0, bevelEnabled: false });
  // assi locali: x lungo il muro, y verso l'alto, z attraverso lo spessore
  const xA = new THREE.Vector3(g.d.x, 0, -g.d.y);
  const yA = new THREE.Vector3(0, 1, 0);
  const zA = new THREE.Vector3().crossVectors(xA, yA);
  const m = new THREE.Matrix4().makeBasis(xA, yA, zA);
  // zA punta verso −n: si parte dalla faccia o1
  m.setPosition(w.a.x + g.n.x * o1, 0, -(w.a.y + g.n.y * o1));
  geo.applyMatrix4(m);
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function extrudePolygon(points: Vec2[], zTop: number, thickness: number, material: THREE.Material, holes: Vec2[][] = []) {
  const shape = shapeFrom(points);
  for (const h of holes) {
    const path = new THREE.Path();
    h.forEach((q, i) => (i ? path.lineTo(q.x, q.y) : path.moveTo(q.x, q.y)));
    path.closePath();
    shape.holes.push(path);
  }
  const geo = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(geo, material);
  m.position.y = zTop - thickness;
  return m;
}

export { sceneBounds };

/** Materiali del contesto e del terreno: lo spaccato non li taglia */
const UNCUT = new Set(['ground', 'lot', 'context', 'road', 'tree']);
/** Colore delle superfici tagliate dallo spaccato */
const CUT_COLOR = 0x3b3b3b;

/**
 * Piani di taglio dello spaccato (three.js tiene i punti con distanza ≥ 0). Piano: sotto la quota del
 * livello più l'altezza di taglio; sezione: oltre il piano, nel verso di vista.
 */
export function cutPlanes(p: Project, cut?: AxoCut): THREE.Plane[] {
  if (!cut) return [];
  if (cut.kind === 'piano') {
    const lv = byId(p.levels, cut.levelId);
    if (!lv) return [];
    return [new THREE.Plane(new THREE.Vector3(0, -1, 0), lv.elevation + cut.height)];
  }
  const sec = (p.sections ?? []).find((x) => x.id === cut.sectionId);
  if (!sec) return [];
  const a = sec.flip ? sec.b : sec.a;
  const b = sec.flip ? sec.a : sec.b;
  const d = perp(norm(sub(b, a)));
  // punto del modello (x, y, z) → three (x, z, −y): D = d·(q − a)
  return [new THREE.Plane(new THREE.Vector3(d.x, 0, -d.y), -(d.x * a.x + d.y * a.y))];
}

export function buildScene(p: Project, opts: SceneOptions = {}) {
  const root = new THREE.Group();
  const sel = new Set(opts.selectedIds ?? []);
  const maxZ = opts.maxElevation ?? Infinity;
  const clip = cutPlanes(p, opts.cut);
  const cutOpts = (key: string) => (clip.length && !UNCUT.has(key) ? { clippingPlanes: clip, clipShadows: true } : {});
  const cache = new Map<string, THREE.Material>();
  const M = (key: string, color: number, extra?: Partial<THREE.MeshStandardMaterialParameters>) => {
    if (!cache.has(key)) cache.set(key, mat(color, { ...extra, ...cutOpts(key) }));
    return cache.get(key)!;
  };
  const selMat = mat(COLORS.selected, { emissive: COLORS.selected, emissiveIntensity: 0.35, ...cutOpts('sel') });
  const tag = (o: THREE.Object3D, id: string) => {
    o.userData.id = id;
    o.castShadow = true;
    o.receiveShadow = true;
    return o;
  };
  const pick = (id: string, m: THREE.Material) => (sel.has(id) ? selMat : m);

  for (const e of p.elements) {
    if (e.kind === 'opening') continue;
    const lvl = byId(p.levels, e.levelId);
    if (!lvl || lvl.elevation > maxZ + 1e-6) continue;
    const z0 = lvl.elevation;

    if (e.kind === 'wall') {
      buildWall(p, e, z0, root, M, pick, tag, sel);
    } else if (e.kind === 'slab') {
      const t = byId(p.catalog.slab, e.typeId);
      if (e.points.length < 3) continue;
      root.add(tag(extrudePolygon(slabOutline(p, e), z0, t?.thickness ?? 0.3, pick(e.id, M('slab', COLORS.slab)), slabHoles(p, e)), e.id));
    } else if (e.kind === 'column') {
      const t = byId(p.catalog.column, e.typeId);
      const geo = new THREE.BoxGeometry(t?.width ?? 0.3, lvl.height, t?.depth ?? 0.3);
      const m = new THREE.Mesh(geo, pick(e.id, M('column', COLORS.column)));
      m.position.set(e.p.x, z0 + lvl.height / 2, -e.p.y);
      root.add(tag(m, e.id));
    } else if (e.kind === 'beam') {
      const t = byId(p.catalog.beam, e.typeId);
      const top = z0 + lvl.height;
      root.add(tag(segmentBox(e.a, e.b, t?.width ?? 0.3, top - (t?.height ?? 0.4), top, pick(e.id, M('column', COLORS.column))), e.id));
    } else if (e.kind === 'stair') {
      const lay = stairLayout(p, e);
      const g = new THREE.Group();
      const mat = pick(e.id, M('stair', COLORS.stair));
      lay.flights.forEach((fl, k) => {
        // profilo (gradini + soletta) estruso per la larghezza della rampa
        const prof = flightProfile(p, e, lay, k);
        const shape = new THREE.Shape();
        prof.forEach((q, i) => (i ? shape.lineTo(q.x, q.y) : shape.moveTo(q.x, q.y)));
        shape.closePath();
        const geo = new THREE.ExtrudeGeometry(shape, { depth: lay.width, bevelEnabled: false });
        // assi locali: x lungo la rampa, y in alto, z verso destra (−normale); modello (x, y, z) → three (x, z, −y)
        const X = new THREE.Vector3(fl.d.x, 0, -fl.d.y);
        const Y = new THREE.Vector3(0, 1, 0);
        const Zv = new THREE.Vector3(-fl.n.x, 0, fl.n.y);
        const start = add(fl.a, mul(fl.n, lay.width / 2));
        const m = new THREE.Matrix4().makeBasis(X, Y, Zv).setPosition(start.x, 0, -start.y);
        geo.applyMatrix4(m);
        g.add(tag(new THREE.Mesh(geo, mat), e.id));
      });
      for (const l of lay.landings) g.add(tag(extrudePolygon(l.poly, l.z, LANDING_THICKNESS, mat), e.id));
      root.add(g);
    } else if (e.kind === 'vault') {
      root.add(tag(vaultMesh(p, e, pick(e.id, M('vault', COLORS.vault))), e.id));
    } else if (e.kind === 'roof') {
      const t = byId(p.catalog.roof, e.typeId);
      const th = t?.thickness ?? 0.3;
      const base = z0 + lvl.height;
      if (e.shape === 'piana' || e.points.length < 3) {
        root.add(tag(extrudePolygon(roofOutline(roofWithEave(p, e)), base + th, th, pick(e.id, M('roofFlat', COLORS.roofFlat))), e.id));
      } else {
        const g = roofGeom(p, e);
        if (g) root.add(tag(roofMesh(g, pick(e.id, M('roof', COLORS.roof))), e.id));
      }
    }
  }

  if (opts.context !== false) buildContext(p, root, M);
  // spaccato: dentro i solidi tagliati si vedono le loro facce posteriori, campite di scuro
  if (clip.length) {
    const capMat = new THREE.MeshBasicMaterial({ color: CUT_COLOR, side: THREE.BackSide, clippingPlanes: clip });
    const meshes: THREE.Mesh[] = [];
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      const mt = m.material as THREE.Material | undefined;
      if (m.isMesh && mt && mt.clippingPlanes?.length && !mt.transparent) meshes.push(m);
    });
    for (const m of meshes) {
      const cap = new THREE.Mesh(m.geometry, capMat);
      cap.userData.id = m.userData.id;
      cap.userData.cap = true;
      m.add(cap);
    }
  }
  return root;
}

function buildWall(
  p: Project,
  w: Wall,
  z0: number,
  root: THREE.Group,
  M: (k: string, c: number, x?: Partial<THREE.MeshStandardMaterialParameters>) => THREE.Material,
  pick: (id: string, m: THREE.Material) => THREE.Material,
  tag: (o: THREE.Object3D, id: string) => THREE.Object3D,
  sel: Set<string>,
) {
  const t = byId(p.catalog.wall, w.typeId);
  const L = wallLength(w);
  if (L < 1e-3) return;
  const g = wallGeom(p, w);
  // sotto le falde la cima del muro segue l'intradosso: il corpo arriva al punto più basso,
  // sopra si aggiunge il profilo (timpano, muretto d'imposta)
  const Hn = wallHeight(p, w);
  const s0 = Math.min(startAt(g, g.half), startAt(g, -g.half));
  const s1 = Math.max(endAt(g, g.half), endAt(g, -g.half));
  const prof = wallTopProfile(p, w, z0 + Hn, s0, s1);
  const H = prof ? Math.max(0.05, Math.min(Hn, Math.min(...prof.map((q) => q.z)) - z0)) : Hn;
  const isConcrete = t?.layers.length === 1 && t.layers[0].role === 'struttura';
  const wallMat = pick(w.id, isConcrete ? M('column', COLORS.column) : M('wall', COLORS.wall));
  // tratti con le estremità tagliate secondo le giunzioni (angolo, T)
  const add = (s0: number | 'inizio', s1: number | 'fine', h0: number, h1: number) => {
    if (h1 - h0 < 1e-3) return;
    if (typeof s0 === 'number' && typeof s1 === 'number' && s1 - s0 < 1e-3) return;
    const poly = bandPolygon(g, g.half, -g.half, s0, s1);
    root.add(tag(extrudePolygon(poly, z0 + h1, h1 - h0, wallMat), w.id));
  };
  let cur: number | 'inizio' = 'inizio';
  for (const s of openingSpans(p, w)) {
    if (cur !== 'inizio' || s.start > Math.min(startAt(g, g.half), startAt(g, -g.half)) + 1e-3) add(cur, s.start, 0, H);
    const sill = Math.min(s.type.sill, H);
    const head = Math.min(H, s.type.sill + s.type.height);
    add(s.start, s.end, 0, sill);
    if (archRise(s.type) > 1e-6 && head > sill + 1e-3) {
      // sopra l'arco il muro segue l'intradosso, dall'imposta alla cima
      const arc = archProfile(s.type).map((q) => ({ s: Math.min(s.end, Math.max(s.start, s.opening.offset + q.x)), z: z0 + Math.min(H, sill + q.h) }));
      root.add(tag(wallShapeMesh(w, g, [...arc, { s: s.end, z: z0 + H }, { s: s.start, z: z0 + H }], -g.half, g.half, wallMat), w.id));
    } else add(s.start, s.end, head, H);
    // sotto un arco il serramento arriva all'imposta (traverso), sopra c'è la lunetta
    const fsp = fixtureSpec(p, w, g, s.opening, s.type);
    const zs = archRise(s.type) > 1e-6 ? Math.min(head, sill + springHeight(s.type) + (fsp.ct + fsp.tf) / 2) : head;
    buildFixture(p, w, g, s.opening, s.type, s.start, s.end, z0 + sill, z0 + zs, root, M, sel, wallMat, pick, z0 + head);
    cur = s.end;
  }
  if (cur === 'inizio' || Math.max(endAt(g, g.half), endAt(g, -g.half)) > cur + 1e-3) add(cur, 'fine', 0, H);
  // Timpano o falda del sottotetto: sopra il corpo il muro segue l'intradosso, con il suo spessore
  if (prof && prof.some((q) => q.z > z0 + H + 1e-3)) {
    root.add(tag(wallShapeMesh(w, g, [{ s: s1, z: z0 + H }, { s: s0, z: z0 + H }, ...prof], -g.half, g.half, wallMat), w.id));
  }
}

const FRAME_COLOR = 0x50555c;

/** Serramento in 3D: telaio fisso, ante con profili e vetro (o anta piena per le porte), davanzale */
function buildFixture(
  p: Project,
  w: Wall,
  g: WallGeom,
  o: Opening,
  t: OpeningType,
  start: number,
  end: number,
  zb: number,
  zt: number,
  root: THREE.Group,
  M: (k: string, c: number, x?: Partial<THREE.MeshStandardMaterialParameters>) => THREE.Material,
  sel: Set<string>,
  wallMat: THREE.Material,
  pick: (id: string, m: THREE.Material) => THREE.Material,
  /** sotto un arco: quota dell'intradosso in chiave (il serramento arriva a zt, sopra la lunetta) */
  zKey?: number,
) {
  const spec = fixtureSpec(p, w, g, o, t);
  const stoneMat = M('sill', 0xd8d4cc);
  // soglia: tutto lo spessore del muro, con 2 cm di sporgenza oltre il filo esterno
  const threshold = () => {
    const o0 = -g.extSign * g.half;
    const o1 = g.extSign * (g.half + THRESHOLD_NOSE);
    const m = segmentBox(
      { x: w.a.x + g.d.x * start + g.n.x * ((o0 + o1) / 2), y: w.a.y + g.d.y * start + g.n.y * ((o0 + o1) / 2) },
      { x: w.a.x + g.d.x * end + g.n.x * ((o0 + o1) / 2), y: w.a.y + g.d.y * end + g.n.y * ((o0 + o1) / 2) },
      Math.abs(o1 - o0),
      zb - 0.04,
      zb,
      stoneMat,
    );
    m.userData.id = o.id;
    m.receiveShadow = true;
    root.add(m);
  };
  // vano senza porta: il varco nel muro basta, niente serramento
  if (spec.bare) {
    if (spec.hasThreshold) threshold();
    return;
  }
  const isDoor = t.category === 'porta';
  const on = sel.has(o.id);
  const frameMat = on ? pick(o.id, wallMat) : M('frame', FRAME_COLOR, { roughness: 0.5, metalness: 0.3 });
  const glassMat = M('glass', COLORS.glass, { transparent: true, opacity: 0.4, roughness: 0.05, metalness: 0.2 });
  const doorMat = on ? frameMat : M('door', COLORS.door);
  const at = (sv: number, ov: number) => ({ x: w.a.x + g.d.x * sv + g.n.x * ov, y: w.a.y + g.d.y * sv + g.n.y * ov });
  const box = (s0: number, s1: number, oc: number, depth: number, z0: number, z1: number, mat: THREE.Material, shadow = true) => {
    if (s1 - s0 < 1e-3 || z1 - z0 < 1e-3) return;
    const m = segmentBox(at(s0, oc), at(s1, oc), depth, z0, z1, mat);
    m.userData.id = o.id;
    m.castShadow = shadow;
    m.receiveShadow = true;
    root.add(m);
  };
  const tf = spec.ct + spec.tf;
  // telaio fisso
  box(start, start + tf, spec.fc, spec.fd, zb, zt, frameMat);
  box(end - tf, end, spec.fc, spec.fd, zb, zt, frameMat);
  box(start, end, spec.fc, spec.fd, zt - tf, zt, frameMat);
  if (!isDoor) box(start, end, spec.fc, spec.fd, zb, zb + tf, frameMat);
  // ante
  for (const l of leafSpans(spec, start, end)) {
    const lz0 = isDoor ? zb + 0.01 : zb + tf;
    const lz1 = zt - tf;
    if (isDoor) {
      box(l.s0, l.s1, spec.fc, spec.leafT, lz0, lz1, doorMat);
      continue;
    }
    const pr = 0.06; // profilo dell'anta
    box(l.s0, l.s0 + pr, spec.fc, spec.leafT, lz0, lz1, frameMat);
    box(l.s1 - pr, l.s1, spec.fc, spec.leafT, lz0, lz1, frameMat);
    box(l.s0, l.s1, spec.fc, spec.leafT, lz0, lz0 + pr, frameMat);
    box(l.s0, l.s1, spec.fc, spec.leafT, lz1 - pr, lz1, frameMat);
    box(l.s0 + pr, l.s1 - pr, spec.fc, 0.024, lz0 + pr, lz1 - pr, glassMat, false);
  }
  // lunetta sopra l'imposta: telaio ad arco attorno al vetro
  if (zKey !== undefined && zKey > zt + 1e-3) {
    const above = (inset: number) =>
      archProfile(t, inset).map((q) => ({ s: Math.min(end, Math.max(start, o.offset + q.x)), z: Math.min(zKey - inset, Math.max(zt, zb + q.h)) }));
    const outer = above(0);
    const inner = above(tf).filter((q) => q.z > zt + 1e-4);
    const frame = wallShapeMesh(w, g, outer, spec.fc - spec.fd / 2, spec.fc + spec.fd / 2, frameMat, inner.length > 2 ? [inner] : []);
    frame.userData.id = o.id;
    root.add(frame);
    if (inner.length > 2) {
      const glass = wallShapeMesh(w, g, inner, spec.fc - 0.012, spec.fc + 0.012, glassMat);
      glass.castShadow = false;
      glass.userData.id = o.id;
      root.add(glass);
    }
  }
  // davanzale o soglia
  const sg = g.extSign;
  const outerFrame = spec.fc + sg * (spec.fd / 2);
  if (spec.hasSill) {
    const tip = sg * (g.half + 0.04);
    box(start - 0.03, end + 0.03, (outerFrame + tip) / 2, Math.abs(tip - outerFrame), zb - 0.04, zb, stoneMat);
  }
  if (spec.hasThreshold) threshold();
}

/**
 * Copertura a falde: per ogni falda visibile l'estradosso (th sopra) e l'intradosso, più le fasce
 * verticali lungo il contorno (gronde e profili sui timpani).
 */
type V3 = [number, number, number];

/** Aggiunge il triangolo con la normale rivolta verso out (scambiando due vertici se serve) */
function pushTri(pos: number[], A: V3, B: V3, C: V3, out: V3) {
  const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
  const w = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
  const nn = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
  const flip = nn[0] * out[0] + nn[1] * out[1] + nn[2] * out[2] < 0;
  pos.push(...A, ...(flip ? C : B), ...(flip ? B : C));
}

/** Volta: guscio tra intradosso ed estradosso su una griglia del campo, con i bordi */
function vaultMesh(p: Project, v: Vault, material: THREE.Material, n = 32) {
  const fr = vaultFrame(v);
  const z0 = vaultLevels(p, v).spring;
  const th = vaultThickness(p, v);
  const pos: number[] = [];
  const P = (i: number, j: number, up: boolean): V3 => {
    const a = (fr.L1 * i) / n;
    const b = (fr.L2 * j) / n;
    const q = vaultPoint(fr, a, b);
    return [q.x, z0 + vaultHeightLocal(v, a, b, fr) + (up ? th : 0), -q.y];
  };
  const c3 = vaultPoint(fr, fr.L1 / 2, fr.L2 / 2);
  const quad = (c: [number, number, boolean][], diag: boolean) => {
    const [A, B, C, D] = c.map((x) => P(...x));
    // verso esterno: intradosso in basso, estradosso in alto, bordi via dal centro del campo
    const side = c[0][2] !== c[2][2];
    const mid = [(A[0] + C[0]) / 2, (A[1] + C[1]) / 2, (A[2] + C[2]) / 2];
    const out: V3 = side ? [mid[0] - c3.x, 0, mid[2] + c3.y] : [0, c[0][2] ? 1 : -1, 0];
    for (const t of diag ? [[A, B, C], [A, C, D]] : [[A, B, D], [B, C, D]]) pushTri(pos, t[0], t[1], t[2], out);
  };
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      // celle divise lungo la diagonale del campo più vicina: i costoloni della crociera restano netti
      const diag = Math.abs(i - j) <= Math.abs(i + j - (n - 1));
      for (const up of [false, true])
        quad(
          [
            [i, j, up],
            [i + 1, j, up],
            [i + 1, j + 1, up],
            [i, j + 1, up],
          ],
          diag,
        );
    }
  // bordi: il guscio visto di taglio lungo i quattro lati
  for (let k = 0; k < n; k++) {
    for (const [i0, j0, i1, j1] of [
      [k, 0, k + 1, 0],
      [k, n, k + 1, n],
      [0, k, 0, k + 1],
      [n, k, n, k + 1],
    ])
      quad(
        [
          [i0, j0, false],
          [i1, j1, false],
          [i1, j1, true],
          [i0, j0, true],
        ],
        true,
      );
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, material);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function roofMesh(g: RoofGeom, material: THREE.Material) {
  const pos: number[] = [];
  const V = (q: Vec2, z: number): V3 => [q.x, z, -q.y];
  // triangoli rivolti verso l'esterno del manto (in alto, in basso o verso il bordo)
  let out: V3 = [0, 1, 0];
  const tri = (a: Vec2, za: number, b: Vec2, zb: number, c: Vec2, zc: number) => pushTri(pos, V(a, za), V(b, zb), V(c, zc), out);
  const inOutline = (q: Vec2) => pointInPolygon(q, g.outline);
  for (const fr of g.fragments) {
    const poly = fr.poly;
    const z = (q: Vec2) => planeAt(fr.plane, q);
    for (let i = 1; i + 1 < poly.length; i++) {
      out = [0, 1, 0];
      tri(poly[0], z(poly[0]) + g.th, poly[i], z(poly[i]) + g.th, poly[i + 1], z(poly[i + 1]) + g.th);
      out = [0, -1, 0];
      tri(poly[0], z(poly[0]), poly[i + 1], z(poly[i + 1]), poly[i], z(poly[i]));
    }
    poly.forEach((a, i) => {
      const b = poly[(i + 1) % poly.length];
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      if (L < 1e-6) return;
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const n = { x: (b.y - a.y) / L, y: -(b.x - a.x) / L };
      // bordo esterno: appena fuori dal frammento non c'è più copertura
      if (inOutline({ x: m.x + n.x * 1e-3, y: m.y + n.y * 1e-3 }) && inOutline({ x: m.x - n.x * 1e-3, y: m.y - n.y * 1e-3 })) return;
      out = [n.x, 0, -n.y];
      tri(a, z(a), b, z(b), b, z(b) + g.th);
      tri(a, z(a), b, z(b) + g.th, a, z(a) + g.th);
    });
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, material);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}


function buildContext(
  p: Project,
  root: THREE.Group,
  M: (k: string, c: number, x?: Partial<THREE.MeshStandardMaterialParameters>) => THREE.Material,
) {
  const gl = p.site.groundLevel;
  const lot = p.site.lot.length > 2 ? p.site.lot : null;
  const all: Vec2[] = [...(lot ?? [])];
  for (const c of p.site.context) all.push(...(c.kind === 'albero' ? [c.p] : c.points));
  const bb = all.length ? bbox(all) : { minX: -20, minY: -20, maxX: 20, maxY: 20, w: 40, h: 40 };
  const size = Math.max(bb.w, bb.h) + 60;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(size, size), M('ground', COLORS.ground));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set((bb.minX + bb.maxX) / 2, gl - 0.02, -(bb.minY + bb.maxY) / 2);
  ground.receiveShadow = true;
  ground.userData.ground = true;
  root.add(ground);
  if (lot) {
    const m = extrudePolygon(lot, gl, 0.01, M('lot', COLORS.lot));
    m.receiveShadow = true;
    root.add(m);
  }
  for (const c of p.site.context) {
    if (c.kind === 'edificio' && c.points.length > 2) {
      const m = extrudePolygon(c.points, gl + c.height, c.height, M('context', COLORS.context));
      m.castShadow = m.receiveShadow = true;
      root.add(m);
    } else if (c.kind === 'strada') {
      for (let i = 0; i < c.points.length - 1; i++) {
        const m = segmentBox(c.points[i], c.points[i + 1], c.width, gl - 0.01, gl + 0.02, M('road', COLORS.road));
        m.receiveShadow = true;
        root.add(m);
      }
    } else if (c.kind === 'albero') {
      const crown = new THREE.Mesh(new THREE.SphereGeometry(c.radius, 16, 12), M('tree', COLORS.tree));
      crown.position.set(c.p.x, gl + c.radius * 1.6 + 1, -c.p.y);
      crown.castShadow = true;
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, c.radius * 1.6 + 1, 8), M('trunk', 0x6b5440));
      trunk.position.set(c.p.x, gl + (c.radius * 1.6 + 1) / 2, -c.p.y);
      trunk.castShadow = true;
      root.add(crown, trunk);
    }
  }
}

/** Direzione del sole nello spazio three.js, tenendo conto del nord geografico */
export function sunVector(p: Project) {
  const { azimuth, altitude } = sunPosition(p.site.latitude, p.site.longitude, p.site.sun.month, p.site.sun.day, p.site.sun.hour);
  const phi = ((azimuth + p.site.trueNorth) * Math.PI) / 180;
  const alt = (Math.max(altitude, 2) * Math.PI) / 180;
  const x = Math.sin(phi) * Math.cos(alt);
  const y = Math.cos(phi) * Math.cos(alt);
  return { vec: new THREE.Vector3(x, Math.sin(alt), -y).normalize(), azimuth, altitude };
}

export function disposeObject(o: THREE.Object3D) {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mt = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mt)) mt.forEach((x) => x.dispose());
    else mt?.dispose();
  });
}

/** Immagine assonometrica del modello per i fogli di stampa */
export function renderAxonometric(p: Project, widthPx: number, heightPx: number, cut?: AxoCut): string {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
  renderer.localClippingEnabled = true;
  renderer.setPixelRatio(1);
  renderer.setSize(widthPx, heightPx, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
  const model = buildScene(p, { context: false, cut });
  scene.add(model);
  const b = sceneBounds(p);
  const R = Math.max(b.w, b.h, b.top) * 0.85;
  // inquadratura sull'ingombro reale del modello (lo stesso calcolo del riquadro sulla tavola)
  const fr = axoFraming(p, cut);
  const aspect = widthPx / heightPx;
  const halfH = Math.max(fr.halfH, fr.halfW / aspect);
  const cam = new THREE.OrthographicCamera(-halfH * aspect, halfH * aspect, halfH, -halfH, 0.1, 1000);
  const target = new THREE.Vector3(...fr.center);
  cam.position.copy(target).add(new THREE.Vector3(...fr.dir).multiplyScalar(200));
  cam.lookAt(target);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb0a898, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.copy(target).add(new THREE.Vector3(-0.4, 1, 0.7).multiplyScalar(60));
  sun.target.position.copy(target);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -R * 1.5, right: R * 1.5, top: R * 1.5, bottom: -R * 1.5 });
  scene.add(sun, sun.target);
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(R * 6, R * 6), new THREE.ShadowMaterial({ opacity: 0.18 }));
  plane.rotation.x = -Math.PI / 2;
  plane.position.set(b.cx, p.site.groundLevel - 0.01, -b.cy);
  plane.receiveShadow = true;
  scene.add(plane);
  renderer.render(scene, cam);
  const url = renderer.domElement.toDataURL('image/png');
  disposeObject(scene);
  renderer.dispose();
  renderer.forceContextLoss();
  return url;
}
