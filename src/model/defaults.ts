import type { BuildingElement, Opening, Project, Vec2, Wall } from './types';
import { uid } from './geometry';

const P = (x: number, y: number): Vec2 => ({ x, y });

/** Progetto di esempio: una casa unifamiliare su due livelli con portico */
export function sampleProject(): Project {
  const L0 = 'lvl_pt';
  const L1 = 'lvl_p1';
  const els: BuildingElement[] = [];

  const wall = (levelId: string, typeId: string, a: Vec2, b: Vec2): Wall => {
    const w: Wall = { id: uid('w'), kind: 'wall', levelId, typeId, a, b };
    els.push(w);
    return w;
  };
  const open = (w: Wall, typeId: string, offset: number, flip = false) => {
    const o: Opening = { id: uid('o'), kind: 'opening', wallId: w.id, typeId, offset, flip };
    els.push(o);
  };

  for (const lvl of [L0, L1]) {
    const s = wall(lvl, 'wt_est', P(0, 0), P(12, 0));
    const e = wall(lvl, 'wt_est', P(12, 0), P(12, 9));
    const n = wall(lvl, 'wt_est', P(12, 9), P(0, 9));
    const o = wall(lvl, 'wt_est', P(0, 9), P(0, 0));
    if (lvl === L0) {
      open(s, 'ot_pf', 1.6);
      open(s, 'ot_pf', 4.4);
      open(s, 'ot_fin', 10);
      open(e, 'ot_fin', 2.5);
      open(e, 'ot_fin', 7);
      open(n, 'ot_fin', 3);
      open(n, 'ot_fin', 9.2);
      open(o, 'ot_ing', 4.2);
      const t1 = wall(lvl, 'wt_tram', P(8, 0), P(8, 5));
      const t2 = wall(lvl, 'wt_tram', P(8, 5), P(12, 5));
      open(t1, 'ot_int', 3.9, true);
      open(t2, 'ot_int', 1.2);
    } else {
      open(s, 'ot_pf', 3);
      open(s, 'ot_fin', 9);
      open(e, 'ot_fin', 2.2);
      open(e, 'ot_fin', 6.8);
      open(n, 'ot_fin', 3.4);
      open(o, 'ot_fin', 4.5);
      const t1 = wall(lvl, 'wt_tram', P(6, 0), P(6, 9));
      const t2 = wall(lvl, 'wt_tram', P(6, 4.5), P(12, 4.5));
      open(t1, 'ot_int', 6.2);
      open(t1, 'ot_int', 2.2, true);
      open(t2, 'ot_int', 1.0);
    }
  }

  els.push(
    { id: uid('s'), kind: 'slab', levelId: L0, typeId: 'st_platea', points: [P(0, 0), P(12, 0), P(12, 9), P(0, 9)] },
    { id: uid('s'), kind: 'slab', levelId: L0, typeId: 'st_est', points: [P(0, -2.6), P(6.2, -2.6), P(6.2, 0), P(0, 0)] },
    {
      id: uid('s'),
      kind: 'slab',
      levelId: L1,
      typeId: 'st_lc',
      points: [P(0, -2.6), P(6.2, -2.6), P(6.2, 0), P(12, 0), P(12, 9), P(5.8, 9), P(5.8, 7.5), P(0.7, 7.5), P(0.7, 9), P(0, 9)],
    },
    { id: uid('c'), kind: 'column', levelId: L0, typeId: 'ct_30', p: P(0.15, -2.45) },
    { id: uid('c'), kind: 'column', levelId: L0, typeId: 'ct_30', p: P(6.05, -2.45) },
    { id: uid('b'), kind: 'beam', levelId: L0, typeId: 'bt_30', a: P(0.15, -2.45), b: P(6.05, -2.45) },
    { id: uid('sc'), kind: 'stair', levelId: L0, a: P(0.9, 8.15), b: P(5.6, 8.15), width: 1.05 },
    {
      id: uid('r'),
      kind: 'roof',
      levelId: L1,
      typeId: 'rt_legno',
      points: [P(0, 0), P(12, 0), P(12, 9), P(0, 9)],
      shape: 'falde',
      pitch: 22,
      overhang: 0.6,
    },
  );

  return {
    version: 1,
    name: 'Casa sul lago',
    site: {
      address: 'Via dei Mille 12',
      municipality: 'Como (CO)',
      cadastre: 'Fg. 14 · Mapp. 389',
      latitude: 45.8081,
      longitude: 9.0852,
      crs: 'EPSG:6707 · RDN2008 / UTM 32N',
      altitude: 212.4,
      trueNorth: 8,
      groundLevel: -0.15,
      lot: [P(-8, -10), P(24, -10), P(24, 17), P(-8, 17)],
      context: [
        { id: uid('k'), kind: 'strada', name: 'Via dei Mille', points: [P(-24, -15), P(40, -15)], width: 8 },
        { id: uid('k'), kind: 'edificio', name: 'Edificio confinante', points: [P(28, -2), P(37, -2), P(37, 11), P(28, 11)], height: 9.5 },
        { id: uid('k'), kind: 'edificio', name: 'Autorimessa', points: [P(-19, 4), P(-12, 4), P(-12, 10), P(-19, 10)], height: 3.2 },
        { id: uid('k'), kind: 'albero', name: 'Tiglio', p: P(11, 14.5), radius: 2.4 },
        { id: uid('k'), kind: 'albero', name: 'Acero', p: P(5.5, 14), radius: 2.2 },
      ],
      zoning: { zone: 'B2 · residenziale di completamento', maxHeight: 10.5, minBoundaryDistance: 5, maxCoverage: 0.4 },
      sun: { month: 6, day: 21, hour: 15 },
    },
    levels: [
      { id: L0, name: 'Piano terra', elevation: 0, height: 3.2 },
      { id: L1, name: 'Piano primo', elevation: 3.2, height: 3.0 },
    ],
    catalog: {
      wall: [
        {
          id: 'wt_est',
          name: 'Muro esterno a cappotto 43',
          priceCode: 'MUR.01',
          layers: [
            { name: 'Rasatura cappotto', thickness: 0.015, role: 'finitura', color: '#d9d2c3', priceCode: 'FIN.02' },
            { name: 'Isolante EPS grafitato', thickness: 0.1, role: 'isolante', color: '#e8b04a' },
            { name: 'Blocco laterizio portante', thickness: 0.3, role: 'struttura', color: '#b5654a' },
            { name: 'Intonaco civile', thickness: 0.015, role: 'finitura', color: '#ece8df', priceCode: 'FIN.01' },
          ],
        },
        {
          id: 'wt_tram',
          name: 'Tramezzo in laterizio 11',
          priceCode: 'MUR.02',
          layers: [
            { name: 'Intonaco civile', thickness: 0.015, role: 'finitura', color: '#ece8df', priceCode: 'FIN.01' },
            { name: 'Forato in laterizio', thickness: 0.08, role: 'struttura', color: '#c27b5f' },
            { name: 'Intonaco civile', thickness: 0.015, role: 'finitura', color: '#ece8df', priceCode: 'FIN.01' },
          ],
        },
        {
          id: 'wt_setto',
          name: 'Setto in c.a. 30',
          priceCode: 'STR.03',
          layers: [{ name: 'Calcestruzzo C30/37', thickness: 0.3, role: 'struttura', color: '#9aa0a6' }],
        },
      ],
      slab: [
        { id: 'st_platea', name: 'Platea su vespaio aerato', thickness: 0.5, priceCode: 'SOL.02', finishName: 'Gres porcellanato', finishPriceCode: 'FIN.03' },
        { id: 'st_lc', name: 'Solaio in laterocemento 20+5', thickness: 0.36, priceCode: 'SOL.01', finishName: 'Parquet rovere', finishPriceCode: 'FIN.05' },
        { id: 'st_est', name: 'Pavimentazione esterna', thickness: 0.15, priceCode: 'SOL.03', finishName: 'Lastre in pietra', finishPriceCode: 'FIN.04' },
      ],
      column: [
        { id: 'ct_30', name: 'Pilastro c.a. 30×30', width: 0.3, depth: 0.3, material: 'C30/37', priceCode: 'STR.01' },
        { id: 'ct_40', name: 'Pilastro c.a. 30×50', width: 0.3, depth: 0.5, material: 'C30/37', priceCode: 'STR.01' },
      ],
      beam: [{ id: 'bt_30', name: 'Trave c.a. 30×40', width: 0.3, height: 0.4, material: 'C30/37', priceCode: 'STR.02' }],
      opening: [
        { id: 'ot_int', category: 'porta', name: 'Porta interna 80×210', width: 0.8, height: 2.1, sill: 0, priceCode: 'SER.01' },
        { id: 'ot_ing', category: 'porta', name: 'Portoncino 100×220', width: 1.0, height: 2.2, sill: 0, priceCode: 'SER.02' },
        { id: 'ot_fin', category: 'finestra', name: 'Finestra 120×150', width: 1.2, height: 1.5, sill: 0.9, priceCode: 'SER.03', uw: 1.1 },
        { id: 'ot_pf', category: 'finestra', name: 'Portafinestra 160×240', width: 1.6, height: 2.4, sill: 0, priceCode: 'SER.04', uw: 1.2 },
      ],
      roof: [
        { id: 'rt_legno', name: 'Copertura in legno ventilata', thickness: 0.32, priceCode: 'COP.01' },
        { id: 'rt_piana', name: 'Copertura piana a verde', thickness: 0.45, priceCode: 'COP.02' },
      ],
    },
    elements: els,
    sections: [{ id: 'sez_a', name: 'A', a: P(3, -5), b: P(3, 13), depth: 40, flip: true }],
    sheets: [
      {
        id: 'sh_01',
        number: 'A.01',
        title: 'Inquadramento e planimetria generale',
        format: 'A3',
        revision: '00',
        date: '2026-10-30',
        viewports: [
          { id: uid('vp'), kind: 'planimetria', title: 'Planimetria generale', x: 18, y: 22, scale: 200 },
          { id: uid('vp'), kind: 'legenda', title: 'Legenda', x: 262, y: 22, scale: 1 },
        ],
      },
      {
        id: 'sh_02',
        number: 'A.02',
        title: 'Piante piano terra e piano primo',
        format: 'A3',
        revision: '00',
        date: '2026-10-30',
        viewports: [
          { id: uid('vp'), kind: 'pianta', title: 'Pianta piano terra', x: 22, y: 30, scale: 100, levelId: L0, showDimensions: true },
          { id: uid('vp'), kind: 'pianta', title: 'Pianta piano primo', x: 196, y: 30, scale: 100, levelId: L1, showDimensions: true },
        ],
      },
      {
        id: 'sh_03',
        number: 'A.03',
        title: 'Prospetti e vista assonometrica',
        format: 'A3',
        revision: '00',
        date: '2026-10-30',
        viewports: [
          { id: uid('vp'), kind: 'prospetto', title: 'Prospetto sud', x: 20, y: 24, scale: 100, direction: 'sud' },
          { id: uid('vp'), kind: 'prospetto', title: 'Prospetto est', x: 20, y: 140, scale: 100, direction: 'est' },
          { id: uid('vp'), kind: 'assonometria', title: 'Assonometria', x: 200, y: 24, scale: 150 },
        ],
      },
      {
        id: 'sh_04',
        number: 'A.04',
        title: 'Abaco dei serramenti',
        format: 'A3',
        revision: '00',
        date: '2026-10-30',
        viewports: [{ id: uid('vp'), kind: 'abaco', title: 'Abaco aperture', x: 20, y: 24, scale: 1, schedule: 'aperture' }],
      },
      {
        id: 'sh_05',
        number: 'A.05',
        title: 'Sezione A–A′',
        format: 'A3',
        revision: '00',
        date: '2026-10-30',
        viewports: [{ id: uid('vp'), kind: 'sezione', title: 'Sezione A–A′', x: 30, y: 30, scale: 100, sectionId: 'sez_a' }],
      },
    ],
    titleBlock: {
      studio: 'Studio di architettura',
      designer: 'Arch. Nome Cognome',
      client: 'Committente privato',
      projectCode: '2026-014',
      stage: 'Progetto definitivo',
    },
    priceListName: 'Elenco prezzi di esempio 2026 · valori indicativi',
    prices: [
      { code: 'STR.01', description: 'Pilastri in c.a. C30/37 compresi casseri e armatura', unit: 'm³', price: 540, category: 'Strutture' },
      { code: 'STR.02', description: 'Travi in c.a. C30/37 compresi casseri e armatura', unit: 'm³', price: 560, category: 'Strutture' },
      { code: 'STR.03', description: 'Setti in c.a. C30/37 compresi casseri e armatura', unit: 'm³', price: 500, category: 'Strutture' },
      { code: 'MUR.01', description: 'Muratura portante in laterizio con cappotto termico', unit: 'm²', price: 148, category: 'Murature' },
      { code: 'MUR.02', description: 'Tramezzo in laterizio forato da 8 cm', unit: 'm²', price: 46, category: 'Murature' },
      { code: 'SOL.01', description: 'Solaio in laterocemento 20+5 con getto di completamento', unit: 'm²', price: 96, category: 'Solai' },
      { code: 'SOL.02', description: 'Platea di fondazione su vespaio aerato con igloo', unit: 'm²', price: 165, category: 'Solai' },
      { code: 'SOL.03', description: 'Sottofondo per pavimentazione esterna', unit: 'm²', price: 38, category: 'Solai' },
      { code: 'COP.01', description: 'Copertura in legno ventilata, coibentata, con manto in coppi', unit: 'm²', price: 185, category: 'Coperture' },
      { code: 'COP.02', description: 'Copertura piana a verde estensivo', unit: 'm²', price: 160, category: 'Coperture' },
      { code: 'SER.01', description: 'Porta interna tamburata laccata', unit: 'cad', price: 480, category: 'Serramenti' },
      { code: 'SER.02', description: 'Portoncino blindato classe 3', unit: 'cad', price: 2300, category: 'Serramenti' },
      { code: 'SER.03', description: 'Finestra in legno-alluminio triplo vetro', unit: 'm²', price: 640, category: 'Serramenti' },
      { code: 'SER.04', description: 'Portafinestra in legno-alluminio triplo vetro', unit: 'm²', price: 660, category: 'Serramenti' },
      { code: 'SCA.01', description: 'Scala a rampa in c.a. con rivestimento in pietra', unit: 'cad', price: 5200, category: 'Scale' },
      { code: 'FIN.01', description: 'Intonaco civile per interni a base calce', unit: 'm²', price: 24, category: 'Finiture' },
      { code: 'FIN.02', description: 'Rasatura armata e finitura per cappotto', unit: 'm²', price: 36, category: 'Finiture' },
      { code: 'FIN.03', description: 'Pavimento in gres porcellanato', unit: 'm²', price: 58, category: 'Finiture' },
      { code: 'FIN.04', description: 'Pavimentazione esterna in lastre di pietra', unit: 'm²', price: 85, category: 'Finiture' },
      { code: 'FIN.05', description: 'Pavimento in parquet di rovere', unit: 'm²', price: 92, category: 'Finiture' },
      { code: 'CAN.01', description: 'Recinzione di cantiere in pannelli h 2.00 m (nolo)', unit: 'm', price: 18, category: 'Cantiere e sicurezza' },
      { code: 'CAN.02', description: 'Accesso carrabile con cancello e segnaletica', unit: 'cad', price: 650, category: 'Cantiere e sicurezza' },
      { code: 'CAN.03', description: 'Area baraccamenti (uffici, spogliatoi, servizi)', unit: 'm²', price: 42, category: 'Cantiere e sicurezza' },
      { code: 'CAN.04', description: 'Area di deposito e stoccaggio materiali', unit: 'm²', price: 6, category: 'Cantiere e sicurezza' },
      { code: 'CAN.05', description: 'Gru a torre: montaggio, nolo e smontaggio', unit: 'cad', price: 9800, category: 'Cantiere e sicurezza' },
      { code: 'CAN.06', description: 'Viabilità di cantiere in misto stabilizzato', unit: 'm²', price: 14, category: 'Cantiere e sicurezza' },
      { code: 'CAN.07', description: 'Area attrezzata per lavorazioni / rifiuti / parcheggio', unit: 'm²', price: 8, category: 'Cantiere e sicurezza' },
    ],
    siteLogistics: [
      { id: uid('cn'), kind: 'recinzione', height: 2, points: [P(-7.5, -9.5), P(23.5, -9.5), P(23.5, 16.5), P(-7.5, 16.5), P(-7.5, -9.5)] },
      { id: uid('cn'), kind: 'accesso', name: 'Accesso carrabile', p: P(14, -9.5), width: 6, rotation: 0 },
      { id: uid('cn'), kind: 'accesso', name: 'Accesso pedonale', p: P(-3, -9.5), width: 1.5, rotation: 0 },
      { id: uid('cn'), kind: 'gru', name: 'Gru a torre GT-01', p: P(17, 3), radius: 22 },
      { id: uid('cn'), kind: 'area', name: 'Deposito materiali', use: 'deposito', points: [P(15.5, 8), P(23, 8), P(23, 16), P(15.5, 16)] },
      { id: uid('cn'), kind: 'area', name: 'Baraccamenti', use: 'baraccamenti', points: [P(-7, 11), P(-1, 11), P(-1, 16), P(-7, 16)] },
      { id: uid('cn'), kind: 'percorso', name: 'Viabilità interna', width: 4, points: [P(14, -9.5), P(14, -4), P(20, -4), P(20, 7.5)] },
      { id: uid('cn'), kind: 'mezzo', vehicle: 'autobetoniera', p: P(17, -6.5), rotation: 90 },
    ],
  };
}

/** Progetto vuoto: un livello, nessun elemento; tipologie, prezzi e cartiglio vengono dal progetto corrente */
export function emptyProject(from: Project): Project {
  const base = sampleProject();
  const lvl = 'lvl_' + Math.random().toString(36).slice(2, 8);
  return {
    ...base,
    name: 'Nuovo progetto',
    site: {
      ...base.site,
      address: '',
      municipality: '',
      cadastre: '',
      lot: [],
      context: [],
      underlays: [],
    },
    levels: [{ id: lvl, name: 'Piano terra', elevation: 0, height: 3 }],
    catalog: JSON.parse(JSON.stringify(from.catalog)),
    prices: JSON.parse(JSON.stringify(from.prices)),
    priceListName: from.priceListName,
    titleBlock: { ...from.titleBlock },
    elements: [],
    sections: [],
    siteLogistics: [],
    sheets: [
      {
        id: 'sh_' + Math.random().toString(36).slice(2, 8),
        number: 'A.01',
        title: 'Nuova tavola',
        format: 'A3',
        revision: '00',
        date: new Date().toISOString().slice(0, 10),
        viewports: [],
      },
    ],
  };
}
