// Localizzazione: ricerca dell'indirizzo, quota del terreno e coordinate piane UTM.

export interface GeoResult {
  label: string;
  latitude: number;
  longitude: number;
  municipality: string;
  address: string;
}

/** Ricerca di un indirizzo su OpenStreetMap (Nominatim) */
export async function geocode(query: string): Promise<GeoResult[]> {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=5&accept-language=it&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Servizio di ricerca non disponibile (${res.status})`);
  const list = (await res.json()) as {
    display_name: string;
    lat: string;
    lon: string;
    address?: Record<string, string>;
  }[];
  return list.map((r) => {
    const a = r.address ?? {};
    const town = a.city ?? a.town ?? a.village ?? a.municipality ?? a.hamlet ?? '';
    const prov = a['ISO3166-2-lvl6']?.split('-')[1] ?? a.county ?? '';
    const street = [a.road ?? a.pedestrian ?? a.square ?? '', a.house_number ?? ''].filter(Boolean).join(' ');
    return {
      label: r.display_name,
      latitude: parseFloat(r.lat),
      longitude: parseFloat(r.lon),
      municipality: town ? (prov && prov.length <= 3 ? `${town} (${prov})` : town) : '',
      address: street,
    };
  });
}

/** Quota del terreno s.l.m. dal modello digitale del terreno di Open-Meteo */
export async function terrainElevation(lat: number, lon: number): Promise<number | null> {
  const res = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`);
  if (!res.ok) return null;
  const j = (await res.json()) as { elevation?: number[] };
  return typeof j.elevation?.[0] === 'number' ? j.elevation[0] : null;
}

/** Sistema di riferimento consigliato: RDN2008 / UTM in Italia, WGS84 / UTM altrove */
export function suggestedCrs(lat: number, lon: number): string {
  const zone = utmZone(lon);
  const hemi = lat >= 0 ? 'N' : 'S';
  const inItaly = lat > 35 && lat < 48 && lon > 6 && lon < 19;
  if (inItaly && zone >= 32 && zone <= 34) return `EPSG:${6707 + zone - 32} · RDN2008 / UTM ${zone}N`;
  return `EPSG:${lat >= 0 ? 32600 + zone : 32700 + zone} · WGS84 / UTM ${zone}${hemi}`;
}

export const utmZone = (lon: number) => Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));

/** Conversione geografiche → UTM (ellissoide GRS80/WGS84) */
export function toUtm(lat: number, lon: number) {
  const zone = utmZone(lon);
  const a = 6378137;
  const f = 1 / 298.257222101;
  const k0 = 0.9996;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);
  const rad = Math.PI / 180;
  const phi = lat * rad;
  const lam0 = ((zone - 1) * 6 - 180 + 3) * rad;
  const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const T = Math.tan(phi) ** 2;
  const C = ep2 * Math.cos(phi) ** 2;
  const A = Math.cos(phi) * (lon * rad - lam0);
  const M =
    a *
    ((1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * phi -
      ((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * phi) +
      ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * phi) -
      ((35 * e2 ** 3) / 3072) * Math.sin(6 * phi));
  const easting =
    k0 * N * (A + ((1 - T + C) * A ** 3) / 6 + ((5 - 18 * T + T ** 2 + 72 * C - 58 * ep2) * A ** 5) / 120) + 500000;
  let northing =
    k0 *
    (M +
      N *
        Math.tan(phi) *
        (A ** 2 / 2 + ((5 - T + 9 * C + 4 * C ** 2) * A ** 4) / 24 + ((61 - 58 * T + T ** 2 + 600 * C - 330 * ep2) * A ** 6) / 720));
  if (lat < 0) northing += 10000000;
  return { zone, easting, northing };
}

/**
 * Convergenza del meridiano: angolo tra nord di rete UTM e nord geografico (gradi).
 * Utile se il nord di progetto coincide con il nord della cartografia.
 */
export function gridConvergence(lat: number, lon: number) {
  const lam0 = (utmZone(lon) - 1) * 6 - 180 + 3;
  return Math.atan(Math.tan(((lon - lam0) * Math.PI) / 180) * Math.sin((lat * Math.PI) / 180)) * (180 / Math.PI);
}
