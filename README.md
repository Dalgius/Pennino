# Pennino

Applicazione BIM pensata per gli architetti: si lavora per **fasi** che seguono il processo progettuale, e non per menu. Ogni fase apre un proprio ambiente di lavoro, ma tutte leggono e scrivono lo **stesso modello informativo**.

| Fase | Ambiente di lavoro |
| --- | --- |
| **01 · Inquadramento** | Localizzazione, coordinate, catasto, nord geografico e soleggiamento, lotto e contesto (strade, edifici, alberi), livelli con quote e interpiani, verifiche urbanistiche (H max, Rc, distanze) |
| **02 · Modellazione** | Muri stratificati, solai, pilastri, travi, porte, finestre, scale, coperture piane o a falde; tipologie modificabili; pianta, prospetti, 3D o pianta + 3D affiancate |
| **03 · Layout** | Tavole A3/A2/A1, viste collegate al modello (piante con quote automatiche, prospetti, assonometria, planimetria, abachi, legenda), cartiglio, stampa/PDF ed esportazione SVG |
| **04 · Computo** | Computo metrico estimativo per WBS calcolato dal modello, abachi di serramenti, murature e solai, elenco prezzi modificabile, esportazione CSV |
| **05 · Cantiere** | Planimetria di cantiere sul lotto e sul contesto di 01: recinzioni, accessi, aree (deposito, baraccamenti…), gru con verifica del raggio, mezzi, viabilità; gli oneri entrano nel computo |

## Un solo modello

```
            ┌────────────── Project (src/model/types.ts) ──────────────┐
            │ site · levels · catalog · elements · sheets · prices ·   │
            │ siteLogistics                                             │
            └───────────────────────────────────────────────────────────┘
   01 scrive site, levels        02 scrive elements, catalog       05 scrive siteLogistics
        │                              │                                 │
        ▼                              ▼                                 ▼
   PlanView · ElevationView · SiteView · scene3d   ← viste generate, mai copiate
        │                              │
   03 Layout (fogli = riferimenti)    04 computeComputo() = funzione pura del modello
```

- Le viste nei fogli sono **riferimenti** (`Viewport`: tipo, livello, fronte, scala), non disegni salvati: se si modifica un muro in 02, la pianta in A.02 e il prospetto in A.03 si ridisegnano.
- Il computo è una **funzione pura** (`src/model/quantities.ts`): ogni tipologia ha una voce di elenco prezzi e l'unità di misura della voce decide che cosa misurare (m → lunghezza, m² → superficie netta, m³ → volume, cad → numero). Per esempio, i muri si misurano detraendo le aperture.
- Il cantiere (05) usa lotto e contesto di 01 e l'impronta dell'edificio di 02; recinzioni, aree e gru diventano voci della categoria «Cantiere e sicurezza».
- Modificando la tipologia (per esempio la stratigrafia di un muro) si aggiornano tutte le istanze.
- Annulla/ripeti su tutto il modello, salvataggio automatico locale e file di progetto `.pennino.json`.

## Avvio

```bash
npm install
npm run dev
```

`npm run build` genera la versione statica in `dist/`.

## Comandi principali (02 · Modellazione)

| Tasto | Strumento | | Tasto | Azione |
| --- | --- | --- | --- | --- |
| V | Seleziona | | Esc | termina / annulla |
| M | Muro | | Invio | applica la lunghezza digitata, chiude i poligoni |
| S | Solaio | | Canc | elimina la selezione |
| P / T | Pilastro / Trave | | Maiusc | disegno libero (disattiva l'ortogonale) |
| O / F | Porta / Finestra | | F8 | ortogonale sì/no |
| G | Scala | | Spazio + trascina, tasto centrale | sposta la vista |
| C | Copertura | | Ctrl+Z / Ctrl+Maiusc+Z | annulla / ripeti |

Mentre si disegna un muro basta digitare la lunghezza (per esempio `4.20`) e premere Invio. Alt+1…5 cambia fase.

## Struttura

```
src/
  model/       types · geometry · quantities (computo/abachi) · edit (selezione, aggancio) · store · defaults
  views/       PlanView · ElevationView · SiteView · SheetView · scene3d · Model3D
  phases/      Inquadramento · Modellazione (+ ispettore e tipologie) · Layout · Computo · Cantiere
  ui/          Canvas2D (tavolo da disegno) · controlli · icone · useSiteEditor
```

Stack: React 19, TypeScript, Three.js, Zustand + Immer, Vite.

## Prossimi passi

- Import/export IFC 4 (web-ifc) e DXF.
- Sezioni verticali con piano di taglio, locali e superfici utili, quote libere sui fogli.
- Muri curvi, solai con fori, coperture a padiglione, stratigrafie dei solai.
- Prezzari regionali importabili e cronoprogramma/4D del cantiere.
