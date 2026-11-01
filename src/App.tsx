import { useEffect, useMemo, useRef } from 'react';
import { exportProjectFile, importProjectFile, resetToSample, useStore } from './model/store';
import { emptyProject } from './model/defaults';
import type { Phase } from './model/types';
import { fmtEuro } from './model/geometry';
import { computeComputo } from './model/quantities';
import { Icon } from './ui/icons';
import { Inquadramento } from './phases/Inquadramento';
import { Modellazione } from './phases/Modellazione';
import { Layout } from './phases/Layout';
import { Computo } from './phases/Computo';
import { Cantiere } from './phases/Cantiere';

const PHASES: { id: Phase; n: string; name: string; sub: string }[] = [
  { id: 'inquadramento', n: '01', name: 'Inquadramento', sub: 'Luogo · quote · livelli' },
  { id: 'modellazione', n: '02', name: 'Modellazione', sub: 'Muri · solai · aperture' },
  { id: 'layout', n: '03', name: 'Layout', sub: 'Tavole · viste · stampa' },
  { id: 'computo', n: '04', name: 'Computo', sub: 'Abachi · quantità · importi' },
  { id: 'cantiere', n: '05', name: 'Cantiere', sub: 'Recinzioni · mezzi · viabilità' },
];

export function App() {
  const phase = useStore((s) => s.phase);
  const setPhase = useStore((s) => s.setPhase);
  const project = useStore((s) => s.project);
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const savedAt = useStore((s) => s.savedAt);
  const replace = useStore((s) => s.replaceProject);
  const fileRef = useRef<HTMLInputElement>(null);
  const newFileRef = useRef<() => void>(() => {});

  useEffect(() => {
    document.documentElement.dataset.theme = theme === 'scuro' ? 'dark' : 'light';
  }, [theme]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const inField = (e.target as HTMLElement).tagName === 'INPUT';
      if (mod && e.key.toLowerCase() === 'z' && !inField) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && e.key.toLowerCase() === 'y' && !inField) {
        e.preventDefault();
        redo();
      } else if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        fileRef.current?.click();
      } else if (mod && e.altKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        newFileRef.current();
      } else if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        exportProjectFile(useStore.getState().project);
      } else if (e.altKey && /^[1-5]$/.test(e.key)) {
        e.preventDefault();
        setPhase(PHASES[Number(e.key) - 1].id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, setPhase]);

  const total = useMemo(() => computeComputo(project).reduce((s, l) => s + l.amount, 0), [project]);
  const count = project.elements.length;

  const edit = useStore((s) => s.edit);
  const newFile = () => {
    if (!confirm('Creare un nuovo progetto vuoto? Il progetto attuale, se non l’hai salvato su file, andrà perso.')) return;
    replace(emptyProject(useStore.getState().project));
    setPhase('inquadramento');
  };

  newFileRef.current = newFile;

  const openFile = async (f: File) => {
    try {
      replace(await importProjectFile(await f.text()));
    } catch {
      alert('Il file non è un progetto Pennino valido.');
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <svg width="22" height="22" viewBox="0 0 24 24" className="brand-mark" aria-hidden>
            <path d="M4 20 L14 4 L18 6 L8 22 Z M14 4 L16 1 L20 3 L18 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
          </svg>
          <div className="brand-text">
            <div className="brand-name">PENNINO</div>
            <input
              key={project.name}
              className="brand-project"
              defaultValue={project.name}
              title="Nome del progetto (clic per rinominare)"
              aria-label="Nome del progetto"
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && v !== project.name) edit((d) => void (d.name = v));
                else e.target.value = project.name;
              }}
            />
          </div>
        </div>
        <div className="file-actions">
          <button className="icon-btn" onClick={newFile} title="Nuovo progetto (Ctrl+Alt+N)"><Icon name="newfile" /></button>
          <button className="icon-btn" onClick={() => fileRef.current?.click()} title="Apri progetto (Ctrl+O)"><Icon name="open" /></button>
          <button className="icon-btn" onClick={() => exportProjectFile(project)} title="Salva progetto su file (Ctrl+S)"><Icon name="save" /></button>
          <span className="sep" />
          <button className="icon-btn" onClick={undo} disabled={!canUndo} title="Annulla (Ctrl+Z)"><Icon name="undo" /></button>
          <button className="icon-btn" onClick={redo} disabled={!canRedo} title="Ripeti (Ctrl+Maiusc+Z)"><Icon name="redo" /></button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) openFile(f);
              e.target.value = '';
            }}
          />
        </div>
        <nav className="phases">
          {PHASES.map((p, i) => (
            <button key={p.id} className={`phase ${phase === p.id ? 'on' : ''}`} onClick={() => setPhase(p.id)} title={`Alt+${i + 1}`}>
              <span className="phase-n mono">{p.n}</span>
              <span className="phase-txt">
                <span className="phase-name">{p.name}</span>
                <span className="phase-sub">{p.sub}</span>
              </span>
            </button>
          ))}
        </nav>
        <div className="top-actions">
          <button className="icon-btn" onClick={toggleTheme} title={theme === 'scuro' ? 'Tema chiaro' : 'Tema scuro'}>
            <Icon name={theme === 'scuro' ? 'sun' : 'moon'} />
          </button>
        </div>
      </header>

      <div className="content">
        {phase === 'inquadramento' && <Inquadramento />}
        {phase === 'modellazione' && <Modellazione />}
        {phase === 'layout' && <Layout />}
        {phase === 'computo' && <Computo />}
        {phase === 'cantiere' && <Cantiere />}
      </div>

      <footer className="statusbar">
        <span className="status-live">● Modello unico</span>
        <span className="mono">{project.levels.length} livelli · {count} elementi · {project.sheets.length} tavole</span>
        <span className="status-link" onClick={() => setPhase('computo')} title="Apri il computo">
          Computo <b className="mono">{fmtEuro(total)}</b>
        </span>
        <span className="spacer" />
        <span className="muted">{savedAt ? `Salvato in locale alle ${new Date(savedAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}` : 'Salvataggio automatico attivo'}</span>
        <button
          className="link"
          onClick={() => {
            if (confirm('Ricaricare il progetto di esempio? Le modifiche non esportate andranno perse.')) resetToSample();
          }}
        >
          Progetto di esempio
        </button>
      </footer>
    </div>
  );
}
