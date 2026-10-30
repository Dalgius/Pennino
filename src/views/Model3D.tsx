import { useEffect, useRef, useState } from 'react';
import { useStore } from '../model/store';
import { fmt } from '../model/geometry';
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
  const [azimuth, setAzimuth] = useState(0);
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
    const onCam = () => setAzimuth((controls.getAzimuthalAngle() * 180) / Math.PI);
    controls.addEventListener('change', onCam);
    onCam();
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

  // Geometria: si ricostruisce quando cambia il modello, non quando cambia solo il sole
  const site = project.site;
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    if (c.model) {
      c.scene.remove(c.model);
      disposeObject(c.model);
    }
    c.model = buildScene(project, { selectedIds, maxElevation });
    c.scene.add(c.model);
    c.scene.background = new THREE.Color(dark ? 0x1a1c22 : 0xeef0f2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.elements, project.levels, project.catalog, site.context, site.lot, site.groundLevel, selectedIds, maxElevation, dark]);

  // Sole: direzione da latitudine, longitudine, data, ora e nord geografico
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    const b = sceneBounds(project);
    const target = new THREE.Vector3(b.cx, 0, -b.cy);
    const sv = sunVector(project);
    c.sun.position.copy(target).add(sv.vec.clone().multiplyScalar(80));
    c.sun.target.position.copy(target);
    const R = Math.max(b.w, b.h) + 30;
    Object.assign(c.sun.shadow.camera, { left: -R, right: R, top: R, bottom: -R, near: 1, far: 250 });
    c.sun.shadow.camera.updateProjectionMatrix();
    c.sun.intensity = sv.altitude > 0 ? 2.6 : 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site.latitude, site.longitude, site.trueNorth, site.sun, project.elements, revision]);

  return (
    <div className="view3d-wrap">
      <div ref={host} className="view3d" />
      <SunHud cameraAzimuth={azimuth} />
    </div>
  );
}

const MONTHS = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];

/** Bussola e sole: il nord ruota con la vista, l'ora si regola dal cursore */
function SunHud({ cameraAzimuth }: { cameraAzimuth: number }) {
  const site = useStore((s) => s.project.site);
  const editLive = useStore((s) => s.editLive);
  const checkpoint = useStore((s) => s.checkpoint);
  const project = useStore((s) => s.project);
  const sv = sunVector(project);
  const h = Math.floor(site.sun.hour);
  const m = Math.round((site.sun.hour - h) * 60);
  return (
    <div className="hud3d">
      <svg width="52" height="52" viewBox="-26 -26 52 52" className="hud3d-compass" aria-label="Nord geografico">
        <circle r="22" />
        <g style={{ transform: `rotate(${cameraAzimuth + site.trueNorth}deg)` }}>
          <path d="M0,-19 L5,4 L0,0 L-5,4 Z" className="hud3d-n" />
          <text y="-8" textAnchor="middle" transform="translate(0 -9)">N</text>
        </g>
      </svg>
      <div className="hud3d-sun">
        <div className="mono">
          {site.sun.day} {MONTHS[site.sun.month - 1]} · ore {String(h).padStart(2, '0')}:{String(m).padStart(2, '0')}
        </div>
        <div className="muted mono">
          {sv.altitude > 0 ? `sole az ${fmt(sv.azimuth, 0)}° · h ${fmt(sv.altitude, 0)}°` : 'sole sotto l’orizzonte'}
        </div>
        <input
          type="range"
          min={4}
          max={21}
          step={0.25}
          value={site.sun.hour}
          aria-label="Ora del giorno"
          onPointerDown={checkpoint}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            editLive((d) => {
              d.site.sun.hour = v;
            });
          }}
        />
      </div>
    </div>
  );
}
