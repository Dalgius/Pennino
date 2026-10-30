import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Vec2 } from '../model/types';

export interface CanvasPointer {
  type: 'down' | 'move' | 'up' | 'dblclick' | 'leave';
  world: Vec2;
  button: number;
  shift: boolean;
  alt: boolean;
  /** pixel → metri */
  zoom: number;
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface Props {
  bounds: Bounds;
  onPointer?: (e: CanvasPointer) => void;
  cursor?: string;
  grid?: boolean;
  children: (zoom: number) => ReactNode;
  /** Elementi HTML sovrapposti (HUD) */
  hud?: ReactNode;
  className?: string;
}

/** Tavolo da disegno: pan con tasto centrale/destro o spazio, zoom con la rotella */
export function Canvas2D({ bounds, onPointer, cursor = 'default', grid = true, children, hud, className }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ tx: 0, ty: 0, z: 30 });
  const [size, setSize] = useState({ w: 800, h: 600 });
  const pan = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const space = useRef(false);
  const fitted = useRef(false);

  const fit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    const bw = Math.max(1, bounds.maxX - bounds.minX);
    const bh = Math.max(1, bounds.maxY - bounds.minY);
    const z = Math.min(w / (bw * 1.15), h / (bh * 1.15));
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    setView({ z, tx: w / 2 - cx * z, ty: h / 2 + cy * z });
  }, [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY]);

  useLayoutEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
      if (!fitted.current && el.clientWidth > 0) {
        fitted.current = true;
        fit();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  useEffect(() => {
    const kd = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !(e.target instanceof HTMLInputElement)) space.current = true;
    };
    const ku = (e: KeyboardEvent) => {
      if (e.code === 'Space') space.current = false;
    };
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    return () => {
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
    };
  }, []);

  // Zoom con rotella (listener non passivo per poter bloccare lo scroll della pagina)
  useEffect(() => {
    const el = ref.current!;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      setView((v) => {
        const k = Math.exp(-e.deltaY * 0.0015);
        const z = Math.min(2000, Math.max(0.5, v.z * k));
        const f = z / v.z;
        return { z, tx: mx - (mx - v.tx) * f, ty: my - (my - v.ty) * f };
      });
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);

  const toWorld = (e: React.PointerEvent | React.MouseEvent): Vec2 => {
    const r = ref.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left - view.tx) / view.z, y: -(e.clientY - r.top - view.ty) / view.z };
  };

  const emit = (type: CanvasPointer['type'], e: React.PointerEvent | React.MouseEvent) =>
    onPointer?.({ type, world: toWorld(e), button: e.button, shift: e.shiftKey, alt: e.altKey, zoom: view.z });

  const fromHud = (e: React.SyntheticEvent) => !!(e.target as Element).closest?.('[data-hud]');

  const onDown = (e: React.PointerEvent) => {
    if (fromHud(e)) return;
    if (e.button === 1 || e.button === 2 || (e.button === 0 && space.current)) {
      pan.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
      (e.target as Element).setPointerCapture?.(e.pointerId);
      e.preventDefault();
      return;
    }
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    emit('down', e);
  };
  const onMove = (e: React.PointerEvent) => {
    if (fromHud(e) && !pan.current) return;
    if (pan.current) {
      const p = pan.current;
      setView((v) => ({ ...v, tx: p.tx + e.clientX - p.x, ty: p.ty + e.clientY - p.y }));
      return;
    }
    emit('move', e);
  };
  const onUp = (e: React.PointerEvent) => {
    if (pan.current) {
      pan.current = null;
      return;
    }
    if (fromHud(e)) return;
    emit('up', e);
  };

  // Griglia adattiva: passo che resta tra 12 e 120 px
  const gridLines = () => {
    if (!grid) return null;
    const steps = [0.1, 0.5, 1, 5, 10, 50, 100];
    const step = steps.find((s) => s * view.z >= 14) ?? 100;
    const major = step * 5;
    const x0 = -view.tx / view.z;
    const x1 = (size.w - view.tx) / view.z;
    const y1 = view.ty / view.z;
    const y0 = -(size.h - view.ty) / view.z;
    const lines: ReactNode[] = [];
    for (let x = Math.floor(x0 / step) * step; x <= x1; x += step) {
      const isMajor = Math.abs(x / major - Math.round(x / major)) < 1e-6;
      const sx = x * view.z + view.tx;
      lines.push(<line key={`x${x.toFixed(3)}`} x1={sx} y1={0} x2={sx} y2={size.h} className={isMajor ? 'grid-major' : 'grid-minor'} />);
    }
    for (let y = Math.floor(y0 / step) * step; y <= y1; y += step) {
      const isMajor = Math.abs(y / major - Math.round(y / major)) < 1e-6;
      const sy = -y * view.z + view.ty;
      lines.push(<line key={`y${y.toFixed(3)}`} x1={0} y1={sy} x2={size.w} y2={sy} className={isMajor ? 'grid-major' : 'grid-minor'} />);
    }
    const ox = view.tx;
    const oy = view.ty;
    lines.push(
      <g key="origin" className="grid-origin">
        <line x1={ox - 10} y1={oy} x2={ox + 24} y2={oy} />
        <line x1={ox} y1={oy + 10} x2={ox} y2={oy - 24} />
      </g>,
    );
    return { lines, step };
  };
  const g = gridLines();
  // Scala grafica equivalente (a 96 dpi)
  const ratio = Math.round(1000 / (view.z / (96 / 25.4)));

  return (
    <div
      ref={ref}
      className={`canvas2d ${className ?? ''}`}
      style={{ cursor: pan.current ? 'grabbing' : cursor }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerLeave={(e) => emit('leave', e)}
      onDoubleClick={(e) => !fromHud(e) && emit('dblclick', e)}
      onContextMenu={(e) => e.preventDefault()}
    >
      <svg width={size.w} height={size.h}>
        {g && g.lines}
        <g transform={`translate(${view.tx} ${view.ty}) scale(${view.z})`}>{children(view.z)}</g>
      </svg>
      <div className="canvas-hud-bottom" data-hud>
        <button className="chip" onClick={fit} title="Inquadra tutto">
          Inquadra
        </button>
        <span className="chip mono" title="Scala di visualizzazione a schermo">
          ≈ 1:{ratio}
        </span>
        {g && <span className="chip mono">griglia {g.step < 1 ? `${g.step * 100} cm` : `${g.step} m`}</span>}
      </div>
      <div data-hud style={{ display: 'contents' }}>
        {hud}
      </div>
    </div>
  );
}
