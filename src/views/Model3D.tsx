import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Project } from '../model/types';
import { buildScene, disposeObject, sceneBounds, sunVector } from './scene3d';

interface Props {
  project: Project;
  revision: number;
  selectedIds: string[];
  maxElevation?: number;
  onPick?: (id: string | null) => void;
  dark: boolean;
}

/** Vista 3D navigabile, rigenerata a ogni modifica del modello */
export function Model3D({ project, revision, selectedIds, maxElevation, onPick, dark }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const ctx = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    model: THREE.Group | null;
    sun: THREE.DirectionalLight;
    raf: number;
  } | null>(null);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  useEffect(() => {
    const el = host.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 2000);
    const b = sceneBounds(project);
    const target = new THREE.Vector3(b.cx, b.top / 3, -b.cy);
    camera.position.copy(target).add(new THREE.Vector3(-1, 0.8, 1.1).multiplyScalar(Math.max(b.w, b.h) * 1.4 + 10));
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(target);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI / 2 - 0.02;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x9c9384, 1.1));
    const sun = new THREE.DirectionalLight(0xfff4e0, 2.6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004;
    scene.add(sun, sun.target);

    const resize = () => {
      const w = el.clientWidth || 1;
      const h = el.clientHeight || 1;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    const loop = () => {
      controls.update();
      renderer.render(scene, camera);
      ctx.current!.raf = requestAnimationFrame(loop);
    };
    ctx.current = { renderer, scene, camera, controls, model: null, sun, raf: 0 };
    loop();

    // Selezione con un clic (senza trascinamento)
    let down: { x: number; y: number } | null = null;
    const pd = (e: PointerEvent) => (down = { x: e.clientX, y: e.clientY });
    const pu = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 || e.button !== 0) return;
      const r = renderer.domElement.getBoundingClientRect();
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
      const model = ctx.current?.model;
      if (!model) return;
      const hit = ray.intersectObject(model, true).find((h) => h.object.userData.id);
      onPickRef.current?.(hit ? (hit.object.userData.id as string) : null);
    };
    renderer.domElement.addEventListener('pointerdown', pd);
    renderer.domElement.addEventListener('pointerup', pu);

    return () => {
      cancelAnimationFrame(ctx.current!.raf);
      ro.disconnect();
      controls.dispose();
      disposeObject(scene);
      renderer.dispose();
      el.removeChild(renderer.domElement);
      ctx.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    if (c.model) {
      c.scene.remove(c.model);
      disposeObject(c.model);
    }
    c.model = buildScene(project, { selectedIds, maxElevation });
    c.scene.add(c.model);
    const b = sceneBounds(project);
    const target = new THREE.Vector3(b.cx, 0, -b.cy);
    const sv = sunVector(project);
    c.sun.position.copy(target).add(sv.vec.clone().multiplyScalar(80));
    c.sun.target.position.copy(target);
    const R = Math.max(b.w, b.h) + 30;
    Object.assign(c.sun.shadow.camera, { left: -R, right: R, top: R, bottom: -R, near: 1, far: 250 });
    c.sun.shadow.camera.updateProjectionMatrix();
    c.sun.intensity = sv.altitude > 0 ? 2.6 : 0.3;
    c.scene.background = new THREE.Color(dark ? 0x1a1c22 : 0xeef0f2);
  }, [project, revision, selectedIds, maxElevation, dark]);

  return <div ref={host} className="view3d" />;
}
