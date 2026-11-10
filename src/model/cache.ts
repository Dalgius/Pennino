// Memoria dei calcoli derivati dal progetto.
//
// Il progetto nello store è immutabile (ogni modifica produce un nuovo oggetto, congelato da Immer):
// un risultato calcolato da un certo oggetto-progetto resta valido finché esiste quell'oggetto.
// I progetti non congelati (bozze di Immer, oggetti costruiti a mano nei test) possono cambiare
// sul posto: per quelli non si memorizza nulla.

const store = new WeakMap<object, Map<string, unknown>>();

/** Risultato di make() per questo progetto e questa chiave, calcolato una volta sola */
export function cached<T>(project: object, key: string, make: () => T): T {
  if (!Object.isFrozen(project)) return make();
  let m = store.get(project);
  if (!m) store.set(project, (m = new Map()));
  if (m.has(key)) return m.get(key) as T;
  const v = make();
  m.set(key, v);
  return v;
}
