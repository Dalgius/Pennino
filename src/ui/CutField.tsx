// Scelta dello spaccato assonometrico: nessuno, taglio orizzontale sopra un livello, taglio lungo
// una sezione. Usato nella Vista 3D e nelle assonometrie delle tavole.

import type { AxoCut, Project } from '../model/types';
import { sortedLevels } from '../model/geometry';
import { NumberField, SelectField } from './controls';

const keyOf = (c?: AxoCut) => (!c ? '' : c.kind === 'piano' ? `piano:${c.levelId}` : `sezione:${c.sectionId}`);

export function CutField({ project: p, cut, onChange, compact }: { project: Project; cut?: AxoCut; onChange: (c: AxoCut | undefined) => void; compact?: boolean }) {
  const levels = sortedLevels(p).filter((l) => l.kind !== 'copertura');
  const options = [
    { value: '', label: 'Nessuno · modello intero' },
    ...levels.map((l) => ({ value: `piano:${l.id}`, label: `Orizzontale · ${l.name}` })),
    ...(p.sections ?? []).map((s) => ({ value: `sezione:${s.id}`, label: `Lungo la sezione ${s.name}` })),
  ];
  const set = (v: string) => {
    if (!v) return onChange(undefined);
    const [kind, id] = v.split(':');
    onChange(kind === 'piano' ? { kind: 'piano', levelId: id, height: cut?.kind === 'piano' ? cut.height : 1.2 } : { kind: 'sezione', sectionId: id });
  };
  return (
    <>
      <SelectField label="Spaccato" value={keyOf(cut)} options={options} onChange={set} />
      {cut?.kind === 'piano' && (
        <NumberField label="Quota di taglio dal piano" unit="m" value={cut.height} step={0.1} min={0.1} onChange={(v) => onChange({ ...cut, height: v })} />
      )}
      {!compact && cut && (
        <p className="note">
          {cut.kind === 'piano'
            ? 'Si toglie tutto ciò che sta sopra la quota di taglio: si vede il piano con muri, aperture e arredi fissi, le superfici tagliate campite di scuro.'
            : 'Si toglie la parte davanti al piano della sezione (dalla parte opposta alle frecce): la vista guarda la faccia tagliata, di sbieco.'}
        </p>
      )}
    </>
  );
}
