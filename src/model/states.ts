// Stati del progetto nelle ristrutturazioni: ogni elemento è esistente, da demolire o nuovo.
// Una vista mostra lo stato di fatto (esistente + demolito), il progetto (esistente + nuovo)
// oppure la comparativa (tutto, con demolizioni in giallo e costruzioni in rosso).

import type { BuildingElement, ElementStatus, Project, ViewState } from './types';
import { cached } from './cache';

export const STATUS_LABEL: Record<ElementStatus, string> = {
  nuovo: 'Nuova costruzione',
  esistente: 'Esistente',
  demolito: 'Da demolire',
};

export const VIEW_STATE_LABEL: Record<ViewState, string> = {
  progetto: 'Progetto',
  fatto: 'Stato di fatto',
  comparativa: 'Comparativa',
};

export const statusOf = (e: BuildingElement): ElementStatus => e.status ?? 'nuovo';

/** Il progetto usa gli stati? (c'è almeno un elemento esistente o da demolire) */
export function usesStates(p: Project) {
  return cached(p, 'usesStates', () => p.elements.some((e) => statusOf(e) !== 'nuovo'));
}

function visibleIn(e: BuildingElement, state: ViewState) {
  const s = statusOf(e);
  return state === 'comparativa' || (state === 'fatto' ? s !== 'nuovo' : s !== 'demolito');
}

/**
 * Progetto ridotto agli elementi presenti nello stato dato. Le aperture seguono il loro stato e
 * quello del muro che le ospita. Senza elementi esistenti o demoliti il progetto resta com'è.
 */
export function projectInState(p: Project, state: ViewState = 'progetto'): Project {
  if (!usesStates(p) || state === 'comparativa') return p;
  return cached(p, `state:${state}`, () => {
    const keep = new Set(p.elements.filter((e) => e.kind !== 'opening' && visibleIn(e, state)).map((e) => e.id));
    const elements = p.elements.filter((e) => (e.kind === 'opening' ? keep.has(e.wallId) && visibleIn(e, state) : keep.has(e.id)));
    return Object.freeze({ ...p, elements });
  });
}
