import type { Underlay } from '../model/types';
import { useImageUrl } from '../model/images';

/** Basi raster sotto al disegno, in coordinate di progetto (m) */
export function UnderlayLayer({ underlays, selectedId }: { underlays: Underlay[]; selectedId?: string | null }) {
  return (
    <g className="underlays">
      {underlays.filter((u) => u.visible).map((u) => (
        <UnderlayImage key={u.id} u={u} selected={u.id === selectedId} />
      ))}
    </g>
  );
}

function UnderlayImage({ u, selected }: { u: Underlay; selected: boolean }) {
  const url = useImageUrl(u.imageId);
  return (
    <g transform={`rotate(${-u.rotation} ${u.x} ${-u.y})`}>
      {url && <image href={url} x={u.x} y={-(u.y + u.height)} width={u.width} height={u.height} opacity={u.opacity} preserveAspectRatio="none" />}
      {selected && <rect x={u.x} y={-(u.y + u.height)} width={u.width} height={u.height} className="underlay-sel" vectorEffect="non-scaling-stroke" />}
    </g>
  );
}

/** Angoli del raster in coordinate di progetto (per inquadrare la vista) */
export function underlayCorners(u: Underlay) {
  const a = (u.rotation * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [
    [0, 0],
    [u.width, 0],
    [u.width, u.height],
    [0, u.height],
  ].map(([dx, dy]) => ({ x: u.x + dx * c - dy * s, y: u.y + dx * s + dy * c }));
}
