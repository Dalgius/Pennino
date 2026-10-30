// Costruzione della scena 3D a partire dal modello informativo.
// Mappatura assi: modello (x, y, z) → three.js (x, z, −y).

import * as THREE from 'three';
import { bandPolygon, endAt, startAt, wallGeom, type WallGeom } from '../model/walls';
import { fixtureSpec, leafSpans } from '../model/openings';
import type { Opening, OpeningType, Project, Vec2, Wall } from '../model/types';
import {
  bbox,
  byId,
  dist,
  levelAbove,
  openingSpans,
  roofRidgeRise,
  sunPosition,
  wallHeight,
  wallLength,
} from '../model/geometry';

export interface SceneOptions {
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

function extrudePolygon(points: Vec2[], zTop: number, thickness: number, material: THREE.Material) {
  const geo = new THREE.ExtrudeGeometry(shapeFrom(points), { depth: thickness, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(geo, material);
  m.position.y = zTop - thickness;
  return m;
}

export function buildScene(p: Project, opts: SceneOptions = {}) {
  const root = new THREE.Group();
  const sel = new Set(opts.selectedIds ?? []);
  const maxZ = opts.maxElevation ?? Infinity;
  const cache = new Map<string, THREE.Material>();
  const M = (key: string, color: number, extra?: Partial<THREE.MeshStandardMaterialParameters>) => {
    if (!cache.has(key)) cache.set(key, mat(color, extra));
    return cache.get(key)!;
  };
  const selMat = mat(COLORS.selected, { emissive: COLORS.selected, emissiveIntensity: 0.35 });
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
      root.add(tag(extrudePolygon(e.points, z0, t?.thickness ?? 0.3, pick(e.id, M('slab', COLORS.slab))), e.id));
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
      const next = levelAbove(p, e.levelId);
      const rise = next ? next.elevation - z0 : lvl.height;
      const steps = Math.max(2, Math.ceil(rise / 0.18));
      const h = rise / steps;
      const L = dist(e.a, e.b);
      const g = new THREE.Group();
      for (let i = 0; i < steps; i++) {
        const t0 = (i / steps) * L;
        const t1 = ((i + 1) / steps) * L;
        const d = { x: (e.b.x - e.a.x) / L, y: (e.b.y - e.a.y) / L };
        const a = { x: e.a.x + d.x * t0, y: e.a.y + d.y * t0 };
        const b = { x: e.a.x + d.x * t1, y: e.a.y + d.y * t1 };
        g.add(tag(segmentBox(a, b, e.width, z0 + i * h, z0 + (i + 1) * h, pick(e.id, M('stair', COLORS.stair))), e.id));
      }
      root.add(g);
    } else if (e.kind === 'roof') {
      const t = byId(p.catalog.roof, e.typeId);
      const th = t?.thickness ?? 0.3;
      const base = z0 + lvl.height;
      if (e.shape === 'piana' || e.points.length < 3) {
        root.add(tag(extrudePolygon(e.points, base + th, th, pick(e.id, M('roofFlat', COLORS.roofFlat))), e.id));
      } else {
        const roof = gableRoof(e.points, e.pitch, e.overhang, base, th, pick(e.id, M('roof', COLORS.roof, { side: THREE.DoubleSide })));
        roof.traverse((c) => tag(c, e.id));
        root.add(roof);
      }
    }
  }

  if (opts.context !== false) buildContext(p, root, M);
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
  const H = wallHeight(p, w);
  const L = wallLength(w);
  if (L < 1e-3) return;
  const g = wallGeom(p, w);
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
    add(s.start, s.end, head, H);
    buildFixture(p, w, g, s.opening, s.type, s.start, s.end, z0 + sill, z0 + head, root, M, sel, wallMat, pick);
    cur = s.end;
  }
  if (cur === 'inizio' || Math.max(endAt(g, g.half), endAt(g, -g.half)) > cur + 1e-3) add(cur, 'fine', 0, H);
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
) {
  const spec = fixtureSpec(p, w, g, o, t);
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
  // davanzale o soglia
  const sg = g.extSign;
  const outerFrame = spec.fc + sg * (spec.fd / 2);
  if (spec.hasSill || spec.hasThreshold) {
    const tip = sg * (g.half + (spec.hasSill ? 0.04 : 0.02));
    const ext = spec.hasSill ? 0.03 : 0;
    box(start - ext, end + ext, (outerFrame + tip) / 2, Math.abs(tip - outerFrame), zb - 0.04, zb, M('sill', 0xd8d4cc));
  }
}

function gableRoof(points: Vec2[], pitch: number, o: number, base: number, th: number, material: THREE.Material) {
  const b = bbox(points);
  const alongX = b.w >= b.h;
  const half = (alongX ? b.h : b.w) / 2;
  const rise = roofRidgeRise(points, pitch);
  const slope = rise / half;
  const span = half + o;
  const zb = (t: number) => base + rise - slope * Math.abs(t);
  const s = new THREE.Shape();
  s.moveTo(-span, zb(-span));
  s.lineTo(0, base + rise);
  s.lineTo(span, zb(span));
  s.lineTo(span, zb(span) + th);
  s.lineTo(0, base + rise + th);
  s.lineTo(-span, zb(-span) + th);
  s.closePath();
  const length = (alongX ? b.w : b.h) + 2 * o;
  const geo = new THREE.ExtrudeGeometry(s, { depth: length, bevelEnabled: false });
  const m = new THREE.Mesh(geo, material);
  // Timpani: volume triangolare sotto le falde, a filo dei muri
  const g = new THREE.Shape();
  g.moveTo(-half, base);
  g.lineTo(half, base);
  g.lineTo(0, base + rise);
  g.closePath();
  const gable = new THREE.Mesh(
    new THREE.ExtrudeGeometry(g, { depth: length - 2 * o, bevelEnabled: false }),
    new THREE.MeshStandardMaterial({ color: 0xe9e4d8, roughness: 0.85 }),
  );
  gable.position.z = o;
  gable.castShadow = gable.receiveShadow = true;
  const group = new THREE.Group();
  group.add(m, gable);
  if (alongX) {
    group.rotation.y = Math.PI / 2;
    group.position.set(b.minX - o, 0, -(b.minY + b.h / 2));
  } else {
    group.position.set(b.minX + b.w / 2, 0, -(b.maxY + o));
  }
  return group;
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

export function sceneBounds(p: Project) {
  const pts: Vec2[] = [];
  for (const e of p.elements) {
    if (e.kind === 'wall' || e.kind === 'beam' || e.kind === 'stair') pts.push(e.a, e.b);
    else if (e.kind === 'slab' || e.kind === 'roof') pts.push(...e.points);
    else if (e.kind === 'column') pts.push(e.p);
  }
  const b = pts.length ? bbox(pts) : { minX: -5, minY: -5, maxX: 5, maxY: 5, w: 10, h: 10 };
  const top = Math.max(3, ...p.levels.map((l) => l.elevation + l.height)) + 2;
  return { ...b, top, cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2 };
}

/** Immagine assonometrica del modello per i fogli di stampa */
export function renderAxonometric(p: Project, widthPx: number, heightPx: number): string {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
  renderer.setPixelRatio(1);
  renderer.setSize(widthPx, heightPx, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
  const model = buildScene(p, { context: false });
  scene.add(model);
  const b = sceneBounds(p);
  const R = Math.max(b.w, b.h, b.top) * 0.85;
  const aspect = widthPx / heightPx;
  const cam = new THREE.OrthographicCamera(-R * aspect, R * aspect, R, -R, 0.1, 500);
  const target = new THREE.Vector3(b.cx, b.top / 3, -b.cy);
  cam.position.copy(target).add(new THREE.Vector3(-1, 0.9, 1).normalize().multiplyScalar(120));
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
