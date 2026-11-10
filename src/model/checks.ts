// Controlli di coerenza del modello: problemi che l'utente può voler correggere, con l'elemento
// a cui si riferiscono. Non bloccano nulla: sono un elenco consultabile.

import type { Project, Wall } from './types';
import { cached } from './cache';
import { byId, dist, JOIN_TOL, openingSpans, pointInPolygon, projectOnSegment, slabOutline, sortedLevels, stairSteps, wallLength, wallThickness } from './geometry';
import { isHabitable, MIN_LIGHT_RATIO, MIN_ROOM_HEIGHT, roomInfo } from './rooms';
import { projectInState } from './states';

export interface Issue {
  /** elemento (o locale) a cui si riferisce */
  id: string;
  levelId?: string;
  severity: 'errore' | 'avviso';
  text: string;
}

const fmt = (v: number, d = 2) => v.toFixed(d).replace('.', ',');

export function checkModel(project: Project): Issue[] {
  return cached(project, 'checks', () => run(projectInState(project, 'progetto'), project));
}

function run(p: Project, full: Project): Issue[] {
  const out: Issue[] = [];
  const levels = sortedLevels(p);
  const wallsOf = (levelId: string) => p.elements.filter((e): e is Wall => e.kind === 'wall' && e.levelId === levelId);

  for (const lv of levels) {
    const walls = wallsOf(lv.id);
    for (const w of walls) {
      const L = wallLength(w);
      if (L < 0.05) {
        out.push({ id: w.id, levelId: lv.id, severity: 'errore', text: 'Muro di lunghezza quasi nulla.' });
        continue;
      }
      // estremo che sfiora un altro muro senza toccarlo: quasi sempre una giunzione mancata
      for (const end of [w.a, w.b]) {
        let near = Infinity;
        let joined = false;
        for (const o of walls) {
          if (o.id === w.id) continue;
          const d = projectOnSegment(end, o.a, o.b).d;
          if (d < JOIN_TOL) joined = true;
          else near = Math.min(near, d - wallThickness(byId(p.catalog.wall, o.typeId)) / 2);
        }
        if (!joined && near < 0.15)
          out.push({ id: w.id, levelId: lv.id, severity: 'avviso', text: `Un estremo del muro è a ${fmt(Math.max(0, near) * 100, 0)} cm da un altro muro senza collegarsi.` });
      }
      // muri sovrapposti sullo stesso asse
      for (const o of walls) {
        if (o.id <= w.id) continue;
        const a = projectOnSegment(o.a, w.a, w.b);
        const b = projectOnSegment(o.b, w.a, w.b);
        if (a.d < JOIN_TOL && b.d < JOIN_TOL && Math.abs(a.t - b.t) * L > 0.05 && Math.min(a.t, b.t) < 1 - 1e-3 && Math.max(a.t, b.t) > 1e-3 && dist(o.a, o.b) > 0.05) {
          const lo = Math.max(0, Math.min(a.t, b.t));
          const hi = Math.min(1, Math.max(a.t, b.t));
          if ((hi - lo) * L > 0.05) out.push({ id: o.id, levelId: lv.id, severity: 'errore', text: 'Muro sovrapposto a un altro sullo stesso asse.' });
        }
      }
      // aperture: dentro il muro e non sovrapposte
      const spans = openingSpans(p, w);
      for (const o of p.elements) {
        if (o.kind !== 'opening' || o.wallId !== w.id) continue;
        const t = byId(p.catalog.opening, o.typeId);
        if (!t) continue;
        if (o.offset - t.width / 2 < -1e-3 || o.offset + t.width / 2 > L + 1e-3)
          out.push({ id: o.id, levelId: lv.id, severity: 'errore', text: `${t.category === 'porta' ? 'Porta' : 'Finestra'} che esce dal muro.` });
        if (t.sill + t.height > lv.height + 1e-3 && lv.height > 0)
          out.push({ id: o.id, levelId: lv.id, severity: 'avviso', text: `${t.category === 'porta' ? 'Porta' : 'Finestra'} più alta dell’interpiano (${fmt(t.sill + t.height)} m su ${fmt(lv.height)} m).` });
      }
      for (let i = 0; i + 1 < spans.length; i++)
        if (spans[i + 1].start < spans[i].end - 1e-3) out.push({ id: spans[i + 1].opening.id, levelId: lv.id, severity: 'errore', text: 'Aperture sovrapposte nello stesso muro.' });
    }

    for (const e of p.elements) {
      if (!('levelId' in e) || e.levelId !== lv.id) continue;
      if (e.kind === 'stair') {
        const s = stairSteps(p, e);
        const blondel = 2 * s.h + s.tread;
        if (s.h > 0.18 + 1e-4) out.push({ id: e.id, levelId: lv.id, severity: 'avviso', text: `Scala con alzata di ${fmt(s.h * 100, 1)} cm (massimo consigliato 18 cm).` });
        if (s.tread < 0.25 - 1e-4) out.push({ id: e.id, levelId: lv.id, severity: 'avviso', text: `Scala con pedata di ${fmt(s.tread * 100, 1)} cm (minimo consigliato 25 cm).` });
        else if (blondel < 0.615 || blondel > 0.645)
          out.push({ id: e.id, levelId: lv.id, severity: 'avviso', text: `Scala fuori dalla regola 2a + p = 62–64 cm (${fmt(blondel * 100, 1)} cm).` });
        if (e.width < 0.8 - 1e-4) out.push({ id: e.id, levelId: lv.id, severity: 'avviso', text: `Scala larga ${fmt(e.width * 100, 0)} cm (minimo consigliato 80 cm).` });
      }
      if (e.kind === 'slab' && lv !== levels[0]) {
        // un solaio in quota deve avere sotto almeno un muro, una trave o un pilastro
        const below = levels[levels.indexOf(lv) - 1];
        const outline = slabOutline(p, e);
        const grown = (q: { x: number; y: number }) => pointInPolygon(q, outline) || outline.some((a, i) => projectOnSegment(q, a, outline[(i + 1) % outline.length]).d < 0.3);
        const supported = p.elements.some(
          (s) => 'levelId' in s && s.levelId === below.id && ((s.kind === 'wall' && (grown(s.a) || grown(s.b))) || (s.kind === 'beam' && (grown(s.a) || grown(s.b))) || (s.kind === 'column' && grown(s.p))),
        );
        if (!supported) out.push({ id: e.id, levelId: lv.id, severity: 'avviso', text: 'Solaio senza muri, travi o pilastri sottostanti che lo sostengano.' });
      }
    }
  }

  // locali: contorno, rapporto aeroilluminante, altezza (sul progetto, non sullo stato di fatto)
  for (const r of full.rooms ?? []) {
    const info = roomInfo(p, r);
    if (!info.shape) {
      out.push({ id: r.id, levelId: r.levelId, severity: 'errore', text: `Locale «${r.name}»: i muri attorno non chiudono più il vano.` });
      continue;
    }
    if (!isHabitable(r)) continue;
    if (info.ratio < MIN_LIGHT_RATIO - 1e-4)
      out.push({ id: r.id, levelId: r.levelId, severity: 'avviso', text: `Locale «${r.name}»: rapporto aeroilluminante ${info.ratio > 0 ? `1/${fmt(1 / info.ratio, 1)}` : 'nullo'} (minimo 1/8).` });
    if (info.height > 0 && info.height < MIN_ROOM_HEIGHT - 1e-4)
      out.push({ id: r.id, levelId: r.levelId, severity: 'avviso', text: `Locale «${r.name}»: altezza netta ${fmt(info.height)} m (minimo ${fmt(MIN_ROOM_HEIGHT)} m).` });
  }
  return out;
}
