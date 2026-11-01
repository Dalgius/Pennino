// Icone a tratto, disegnate come simboli grafici da tavola.

const paths: Record<string, string> = {
  select: 'M5 3 L5 17 L9 13 L12 19 L14 18 L11 12 L16 12 Z',
  wall: 'M3 8 H21 V13 H3 Z M3 8 L8 13 M8 8 L13 13 M13 8 L18 13 M18 8 L21 11',
  slab: 'M3 15 L9 9 H21 L15 15 Z M3 15 V17 H15 L21 11 V9',
  column: 'M8 3 H16 V21 H8 Z M8 7 H16 M8 17 H16',
  beam: 'M2 9 H22 V14 H2 Z M5 14 V20 M19 14 V20',
  door: 'M5 20 V4 H11 M11 4 V20 M11 20 A9 9 0 0 0 20 11 M5 20 H20',
  window: 'M4 6 H20 V18 H4 Z M12 6 V18 M4 12 H20',
  stair: 'M3 20 H7 V16 H11 V12 H15 V8 H19 V4 H21',
  roof: 'M2 13 L12 5 L22 13 M5 11 V19 H19 V11',
  section: 'M3 12 H6 M9 12 H11 M14 12 H16 M19 12 H21 M3 12 V6 M21 12 V6 M3 6 L1.5 8 M3 6 L4.5 8 M21 6 L19.5 8 M21 6 L22.5 8',
  level: 'M3 7 H21 M3 12 H21 M3 17 H21 M17 4 L20 7 L17 10',
  site: 'M3 5 L9 3 L15 5 L21 3 V19 L15 21 L9 19 L3 21 Z M9 3 V19 M15 5 V21',
  sheet: 'M5 3 H15 L19 7 V21 H5 Z M15 3 V7 H19 M8 17 H16 M8 14 H13',
  table: 'M3 5 H21 V19 H3 Z M3 10 H21 M3 14.5 H21 M9 5 V19',
  crane: 'M7 21 V5 M4 21 H10 M7 5 H21 M7 5 L11 9 M18 5 V12 M16 12 H20 M7 9 H11',
  fence: 'M3 20 V8 M9 20 V8 M15 20 V8 M21 20 V8 M3 11 H21 M3 16 H21',
  gate: 'M3 20 V5 M21 20 V5 M3 8 H21 M3 8 L21 18 M3 18 H21',
  area: 'M4 4 H20 V20 H4 Z M4 10 L10 4 M4 16 L16 4 M8 20 L20 8 M14 20 L20 14',
  truck: 'M2 7 H14 V16 H2 Z M14 10 H18 L21 13 V16 H14 M6 18 A1.5 1.5 0 1 0 6.01 18 M17 18 A1.5 1.5 0 1 0 17.01 18',
  path: 'M4 20 C 8 14, 6 10, 12 9 S 18 4, 20 3',
  building: 'M4 21 V8 L12 4 L20 8 V21 Z M9 21 V15 H15 V21',
  road: 'M8 3 L4 21 M16 3 L20 21 M12 4 V7 M12 10 V13 M12 16 V19',
  tree: 'M12 21 V13 M12 3 A6 6 0 1 0 12.01 3',
  lot: 'M4 6 L18 3 L21 17 L7 21 Z',
  undo: 'M9 14 L4 9 L9 4 M4 9 H15 A5 5 0 0 1 15 19 H11',
  redo: 'M15 14 L20 9 L15 4 M20 9 H9 A5 5 0 0 0 9 19 H13',
  newfile: 'M6 3 H14 L18 7 V21 H6 Z M14 3 V7 H18 M12 11 V17 M9 14 H15',
  save: 'M5 3 H17 L21 7 V21 H3 V3 Z M7 3 V8 H15 V3 M7 21 V13 H17 V21',
  open: 'M3 7 V19 H19 L22 10 H7 L4 19 M3 7 H9 L11 9 H18 V10',
  sun: 'M12 8 A4 4 0 1 0 12.01 8 M12 2 V4 M12 20 V22 M2 12 H4 M20 12 H22 M5 5 L6.5 6.5 M17.5 17.5 L19 19 M5 19 L6.5 17.5 M17.5 6.5 L19 5',
  moon: 'M20 14 A8 8 0 1 1 10 4 A6 6 0 0 0 20 14 Z',
  plus: 'M12 5 V19 M5 12 H19',
  trash: 'M4 7 H20 M9 7 V4 H15 V7 M6 7 L7 21 H17 L18 7 M10 11 V17 M14 11 V17',
  print: 'M6 9 V3 H18 V9 M6 18 H3 V10 H21 V18 H18 M6 14 H18 V21 H6 Z',
  download: 'M12 3 V15 M7 10 L12 15 L17 10 M4 19 H20',
  edit: 'M4 20 H8 L19 9 L15 5 L4 16 Z M13 7 L17 11',
  copy: 'M8 8 H20 V20 H8 Z M4 16 V4 H16',
  eye: 'M2 12 C 5 6, 19 6, 22 12 C 19 18, 5 18, 2 12 Z M12 9.5 A2.5 2.5 0 1 0 12.01 9.5',
  north: 'M12 3 L17 20 L12 16 L7 20 Z',
  link: 'M10 14 L14 10 M8 12 L5.5 14.5 A3.5 3.5 0 0 0 10.5 19.5 L13 17 M16 12 L18.5 9.5 A3.5 3.5 0 0 0 13.5 4.5 L11 7',
};

export function Icon({ name, size = 18 }: { name: keyof typeof paths | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" className="icon">
      <path d={paths[name] ?? ''} />
    </svg>
  );
}
