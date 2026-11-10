import { useEffect, useMemo, useRef, useState } from 'react';
import { clearUnreadableBackup, downloadText, importProjectFile, resetToSample, unreadableBackup, useStore } from './model/store';
import { canUseFiles, detachFile, openProject, openRecent, recentFiles, saveProject, type RecentFile } from './model/files';
import { checkModel } from './model/checks';
import { emptyProject } from './model/defaults';
import { ProjectFormatError } from './model/validate';
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
  const notice = useStore((s) => s.notice);
  const setNotice = useStore((s) => s.setNotice);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(t);
  }, [notice, setNotice]);
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
      } else if (mod && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        const st = useStore.getState();
        st.setDrafting({ grid: !st.drafting.grid });
      } else if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        openRef.current();
      } else if (mod && e.altKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        newFileRef.current();
      } else if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        // Ctrl+S salva sul file del progetto, Ctrl+Maiusc+S chiede un nuovo file
        saveProject(e.shiftKey);
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
    detachFile();
    setPhase('inquadramento');
  };

  // ───────── File di progetto ─────────
  const fileName = useStore((s) => s.fileName);
  const fileSavedAt = useStore((s) => s.fileSavedAt);
  const saveFailed = useStore((s) => s.saveFailed);
  const [fileMenu, setFileMenu] = useState(false);
  const [recent, setRecent] = useState<RecentFile[]>([]);
  const showWarnings = (warnings: string[] | null) => {
    if (warnings?.length) alert(`Progetto aperto con alcune correzioni:\n\n• ${warnings.join('\n• ')}`);
  };
  const openFailed = (err: unknown) =>
    alert(err instanceof ProjectFormatError ? `Impossibile aprire il file: ${err.message}` : 'Il file non è un progetto Pennino valido.');
  const openAny = () => {
    setFileMenu(false);
    if (canUseFiles()) openProject().then(showWarnings, openFailed);
    else fileRef.current?.click();
  };
  const openRef = useRef(openAny);
  openRef.current = openAny;
  // il menu si chiude con Esc o con un clic fuori
  useEffect(() => {
    if (!fileMenu) return;
    const down = (e: PointerEvent) => !(e.target as Element).closest?.('.file-actions') && setFileMenu(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setFileMenu(false);
    window.addEventListener('pointerdown', down);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', down);
      window.removeEventListener('keydown', key);
    };
  }, [fileMenu]);
  const toggleFileMenu = () => {
    if (!fileMenu) recentFiles().then(setRecent);
    setFileMenu(!fileMenu);
  };

  // ───────── Avvisi di coerenza ─────────
  const issues = useMemo(() => checkModel(project), [project]);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const setActiveLevel = useStore((s) => s.setActiveLevel);
  const select = useStore((s) => s.select);
  const goToIssue = (id: string, levelId?: string) => {
    setPhase('modellazione');
    if (levelId) setActiveLevel(levelId);
    // dopo il cambio di fase, che azzera la selezione
    setTimeout(() => select('modello', [id]), 0);
  };
  const [backup, setBackup] = useState(() => !!unreadableBackup());

  newFileRef.current = newFile;

  const openFile = async (f: File) => {
    try {
      const { project: p, warnings } = await importProjectFile(await f.text());
      replace(p);
      detachFile();
      if (warnings.length) alert(`Progetto aperto con alcune correzioni:\n\n• ${warnings.join('\n• ')}`);
    } catch (err) {
      alert(err instanceof ProjectFormatError ? `Impossibile aprire il file: ${err.message}` : 'Il file non è un progetto Pennino valido.');
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
          <button className="icon-btn" onClick={openAny} title="Apri progetto (Ctrl+O)"><Icon name="open" /></button>
          <button className="icon-btn" onClick={() => saveProject()} title={fileName ? `Salva su ${fileName} (Ctrl+S)` : 'Salva progetto su file (Ctrl+S)'}><Icon name="save" /></button>
          <button className={`icon-btn file-caret ${fileMenu ? 'on' : ''}`} onClick={toggleFileMenu} title="Progetti recenti e Salva con nome" aria-label="Menu dei file">▾</button>
          {fileMenu && (
            <div className="file-menu">
              <button className="ctx-item" onClick={openAny}>Apri…  <kbd>Ctrl+O</kbd></button>
              <button className="ctx-item" onClick={() => { setFileMenu(false); saveProject(); }}>Salva  <kbd>Ctrl+S</kbd></button>
              <button className="ctx-item" onClick={() => { setFileMenu(false); saveProject(true); }}>Salva con nome…  <kbd>Ctrl+Maiusc+S</kbd></button>
              <div className="ctx-title">Progetti recenti</div>
              {recent.map((r) => (
                <button key={r.name} className="ctx-item" onClick={() => { setFileMenu(false); openRecent(r).then(showWarnings, openFailed); }}>
                  {r.name} <span className="muted">{new Date(r.at).toLocaleDateString('it-IT')}</span>
                </button>
              ))}
              {!recent.length && (
                <div className="ctx-note">{canUseFiles() ? 'Nessun progetto salvato su file da questo programma.' : 'In questo browser il progetto si scarica come file: l’elenco dei recenti richiede Chrome, Edge o l’app desktop.'}</div>
              )}
            </div>
          )}
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

      {issuesOpen && (
        <div className="issues-panel">
          <div className="layers-head">
            <b>Controlli del modello</b>
            <button className="link" onClick={() => setIssuesOpen(false)}>Chiudi</button>
          </div>
          {!issues.length && <p className="note">Nessun problema rilevato: muri, aperture, scale, solai e locali sono coerenti.</p>}
          {issues.map((it, i) => (
            <button key={i} className={`issue issue-${it.severity}`} onClick={() => goToIssue(it.id, it.levelId)} title="Vai all’elemento">
              <span className="issue-level">{project.levels.find((l) => l.id === it.levelId)?.name ?? '—'}</span>
              <span>{it.text}</span>
            </button>
          ))}
        </div>
      )}
      {notice && (
        <div className="notice" role="status" onClick={() => setNotice(null)}>
          {notice}
        </div>
      )}
      <footer className="statusbar">
        <span className="status-live">● Modello unico</span>
        <span className="mono">{project.levels.length} livelli · {count} elementi · {project.sheets.length} tavole</span>
        <span className="status-link" onClick={() => setPhase('computo')} title="Apri il computo">
          Computo <b className="mono">{fmtEuro(total)}</b>
        </span>
        <button className={`status-issues ${issues.length ? (issues.some((i) => i.severity === 'errore') ? 'bad' : 'warn') : ''}`} onClick={() => setIssuesOpen(!issuesOpen)} title="Controlli di coerenza del modello">
          {issues.length ? `${issues.length} ${issues.length === 1 ? 'avviso' : 'avvisi'}` : 'Nessun avviso'}
        </button>
        <span className="spacer" />
        {backup && (
          <button
            className="link warn"
            title="Il salvataggio locale trovato all’avvio non era leggibile o è stato corretto: qui scarichi l’originale"
            onClick={() => {
              const raw = unreadableBackup();
              if (raw) downloadText('progetto-recuperato.pennino.json', raw, 'application/json');
              clearUnreadableBackup();
              setBackup(false);
            }}
          >
            Scarica il salvataggio originale
          </button>
        )}
        <span className={saveFailed ? 'warn' : 'muted'}>
          {fileName && fileSavedAt
            ? `${fileName} · salvato alle ${new Date(fileSavedAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`
            : saveFailed
              ? 'Salvataggio locale non riuscito'
              : savedAt
                ? `Salvato in locale alle ${new Date(savedAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`
                : 'Salvataggio automatico attivo'}
        </span>
        <button
          className="link"
          onClick={() => {
            if (confirm('Ricaricare il progetto di esempio? Le modifiche non esportate andranno perse.')) {
              resetToSample();
              detachFile();
            }
          }}
        >
          Progetto di esempio
        </button>
      </footer>
    </div>
  );
}
