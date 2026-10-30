import { useMemo, useState } from 'react';
import { downloadText, useStore } from '../model/store';
import type { PriceItem, Project, WbsCategory } from '../model/types';
import { byId, fmt, fmtEuro, polygonArea } from '../model/geometry';
import { computeComputo, openingSchedule, projectMetrics, wallSchedule, WBS, type ComputoLine } from '../model/quantities';
import { Segmented, Stat } from '../ui/controls';
import { Icon } from '../ui/icons';

type Tab = 'computo' | 'abachi' | 'prezzi';

export function Computo() {
  const project = useStore((s) => s.project);
  const edit = useStore((s) => s.edit);
  const [tab, setTab] = useState<Tab>('computo');
  const [cat, setCat] = useState<WbsCategory | 'tutte'>('tutte');
  const [open, setOpen] = useState<string | null>(null);

  const lines = useMemo(() => computeComputo(project), [project]);
  const metrics = useMemo(() => projectMetrics(project), [project]);
  const byCat = WBS.map((c) => ({ c, amount: lines.filter((l) => l.category === c).reduce((s, l) => s + l.amount, 0), n: lines.filter((l) => l.category === c).length }));
  const works = byCat.filter((x) => x.c !== 'Cantiere e sicurezza').reduce((s, x) => s + x.amount, 0);
  const safety = byCat.find((x) => x.c === 'Cantiere e sicurezza')?.amount ?? 0;
  const total = works + safety;
  const shown = cat === 'tutte' ? lines : lines.filter((l) => l.category === cat);
  const missing = lines.filter((l) => !l.item);

  const setPrice = (code: string, price: number) =>
    edit((d) => {
      const it = d.prices.find((p) => p.code === code);
      if (it) it.price = price;
    });

  return (
    <div className="workspace">
      <aside className="side side-left">
        <div className="side-scroll">
          <div className="side-title">
            <span className="phase-num">04</span> Computo
          </div>
          <div className="subhead">Struttura WBS</div>
          <button className={`wbs-row ${cat === 'tutte' ? 'on' : ''}`} onClick={() => setCat('tutte')}>
            <span>Tutte le categorie</span>
            <b className="mono">{fmtEuro(total)}</b>
          </button>
          {byCat.map(({ c, amount, n }, i) => (
            <button key={c} className={`wbs-row ${cat === c ? 'on' : ''}`} onClick={() => setCat(c)} disabled={!n}>
              <span>
                <span className="mono muted">{String(i + 1).padStart(2, '0')}</span> {c}
              </span>
              <b className="mono">{fmtEuro(amount)}</b>
              <span className="wbs-bar">
                <span style={{ width: `${total ? (amount / total) * 100 : 0}%` }} />
              </span>
            </button>
          ))}
          <p className="note">Le quantità sono misurate sul modello (02) e sulla logistica di cantiere (05) a ogni modifica. Nessun inserimento manuale delle misure.</p>
          <div className="subhead">Prezzario</div>
          <p className="note">{project.priceListName}</p>
        </div>
      </aside>

      <main className="stage stage-doc">
        <div className="stats-row">
          <Stat label="Importo complessivo" value={fmtEuro(total)} accent note={`di cui sicurezza e cantiere ${fmtEuro(safety)}`} />
          <Stat label="Superficie lorda di pavimento" value={fmt(metrics.sul, 1)} unit="m²" note={`${fmtEuro(metrics.sul ? works / metrics.sul : 0)} / m²`} />
          <Stat label="Volume lordo" value={fmt(metrics.volume, 1)} unit="m³" note={`${fmtEuro(metrics.volume ? works / metrics.volume : 0)} / m³`} />
          <Stat label="Voci di computo" value={String(lines.length)} note={missing.length ? `${missing.length} senza prezzo` : 'tutte con prezzo'} />
        </div>

        <div className="stage-bar">
          <Segmented<Tab>
            value={tab}
            onChange={setTab}
            options={[
              { value: 'computo', label: 'Computo metrico estimativo' },
              { value: 'abachi', label: 'Abachi' },
              { value: 'prezzi', label: 'Elenco prezzi' },
            ]}
          />
          <div className="stage-bar-right">
            <span className="chip chip-live">● Sincronizzato con il modello</span>
            <button className="tab tab-icon" onClick={() => exportCsv(project, lines)}>
              <Icon name="download" size={15} /> Esporta CSV
            </button>
          </div>
        </div>

        <div className="doc-scroll">
          {tab === 'computo' && (
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 28 }}>N.</th>
                  <th style={{ width: 80 }}>Codice</th>
                  <th>Descrizione lavorazione</th>
                  <th style={{ width: 48 }}>U.M.</th>
                  <th className="num" style={{ width: 96 }}>Quantità</th>
                  <th className="num" style={{ width: 110 }}>Prezzo unit.</th>
                  <th className="num" style={{ width: 120 }}>Importo</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((l, i) => (
                  <LineRows key={l.code} n={i + 1} line={l} open={open === l.code} onToggle={() => setOpen(open === l.code ? null : l.code)} onPrice={(v) => setPrice(l.code, v)} />
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={6}>{cat === 'tutte' ? 'Totale complessivo' : `Totale ${cat}`}</td>
                  <td className="num mono">{fmtEuro(shown.reduce((s, l) => s + l.amount, 0))}</td>
                </tr>
              </tfoot>
            </table>
          )}
          {tab === 'abachi' && <Schedules project={project} />}
          {tab === 'prezzi' && <PriceList project={project} />}
        </div>
      </main>

      <aside className="side side-right">
        <div className="side-scroll">
          <div className="inspector">
            <div className="insp-kicker">Quadro economico sintetico</div>
            <h2 className="insp-title">{fmtEuro(total)}</h2>
            <div className="kv-grid kv-1">
              <div><span>A · Lavori a misura</span><b className="mono">{fmtEuro(works)}</b></div>
              <div><span>B · Oneri sicurezza e cantiere</span><b className="mono">{fmtEuro(safety)}</b></div>
              <div><span>Incidenza sicurezza</span><b className="mono">{fmt(total ? (safety / total) * 100 : 0, 1)} %</b></div>
            </div>
            <div className="subhead">Ripartizione</div>
            <Donut data={byCat.filter((x) => x.amount > 0).map((x) => ({ label: x.c, value: x.amount }))} />
            <div className="subhead">Indicatori</div>
            <div className="kv-grid kv-1">
              <div><span>Superficie coperta</span><b className="mono">{fmt(metrics.footprint, 1)} m²</b></div>
              <div><span>Superficie lotto</span><b className="mono">{fmt(metrics.lotArea, 0)} m²</b></div>
              <div><span>Superficie vetrata</span><b className="mono">{fmt(openingSchedule(project).filter((r) => r.category === 'finestra').reduce((s, r) => s + r.area, 0))} m²</b></div>
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}

function LineRows({ n, line: l, open, onToggle, onPrice }: { n: number; line: ComputoLine; open: boolean; onToggle: () => void; onPrice: (v: number) => void }) {
  const setPhase = useStore((s) => s.setPhase);
  const select = useStore((s) => s.select);
  const setLevel = useStore((s) => s.setActiveLevel);
  const project = useStore((s) => s.project);
  const [price, setPrice] = useState<string | null>(null);

  const goTo = (id: string, source: 'modello' | 'cantiere') => {
    if (source === 'cantiere') {
      setPhase('cantiere');
      select('cantiere', [id]);
      return;
    }
    const e = project.elements.find((x) => x.id === id);
    let lvl = e && 'levelId' in e ? e.levelId : undefined;
    if (e?.kind === 'opening') {
      const w = project.elements.find((x) => x.id === e.wallId);
      lvl = w && 'levelId' in w ? w.levelId : undefined;
    }
    setPhase('modellazione');
    if (lvl) setLevel(lvl);
    select('modello', [id]);
  };

  return (
    <>
      <tr className={`row-main ${open ? 'open' : ''}`} onClick={onToggle}>
        <td className="mono muted">{n}</td>
        <td className="mono accent">{l.code}</td>
        <td>
          <div className="row-desc">{l.item?.description ?? <span className="warn-text">Voce non presente nell’elenco prezzi</span>}</div>
          <div className="row-sub">{l.measurements.length} misure dal {l.measurements[0]?.source === 'cantiere' ? 'cantiere' : 'modello'} · {l.category}</div>
        </td>
        <td>{l.item?.unit ?? '—'}</td>
        <td className="num mono">{fmt(l.qty)}</td>
        <td className="num" onClick={(e) => e.stopPropagation()}>
          {l.item && (
            <input
              className="cell-input mono"
              value={price ?? fmt(l.item.price)}
              onFocus={() => setPrice(String(l.item!.price))}
              onChange={(e) => setPrice(e.target.value)}
              onBlur={() => {
                const v = parseFloat((price ?? '').replace(',', '.'));
                if (isFinite(v) && v >= 0) onPrice(v);
                setPrice(null);
              }}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
          )}
        </td>
        <td className="num mono strong">{fmtEuro(l.amount)}</td>
      </tr>
      {open &&
        l.measurements.map((m, i) => (
          <tr key={i} className="row-measure">
            <td />
            <td className="mono">{m.label.split(' · ')[0]}</td>
            <td>
              <span className="muted">{m.level}</span> · <span className="mono">{m.formula}</span>
              {m.label.includes(' · ') && <span className="muted"> · {m.label.split(' · ').slice(1).join(' · ')}</span>}
            </td>
            <td />
            <td className="num mono">{fmt(m.qty)}</td>
            <td colSpan={2} className="num">
              <button className="link" onClick={() => goTo(m.sourceId, m.source)}>
                Mostra {m.source === 'cantiere' ? 'in cantiere' : 'nel modello'} →
              </button>
            </td>
          </tr>
        ))}
    </>
  );
}

function Schedules({ project }: { project: Project }) {
  const openings = openingSchedule(project);
  const walls = wallSchedule(project);
  const slabs = project.elements.filter((e) => e.kind === 'slab');
  return (
    <div className="schedules">
      <h3 className="doc-h">Abaco dei serramenti</h3>
      <table className="table">
        <thead>
          <tr>
            <th>Sigla</th><th>Tipologia</th><th>Categoria</th><th className="num">L × H cm</th><th className="num">Davanzale</th><th className="num">Q.tà</th><th className="num">Sup. m²</th><th className="num">Uw</th><th>Livelli</th>
          </tr>
        </thead>
        <tbody>
          {openings.map((r) => (
            <tr key={r.typeId}>
              <td className="mono accent">{r.mark}</td><td>{r.name}</td><td>{r.category}</td>
              <td className="num mono">{Math.round(r.width * 100)} × {Math.round(r.height * 100)}</td>
              <td className="num mono">{Math.round(r.sill * 100)}</td>
              <td className="num mono strong">{r.count}</td>
              <td className="num mono">{fmt(r.area)}</td>
              <td className="num mono">{r.uw !== undefined ? fmt(r.uw) : '—'}</td>
              <td>{r.levels}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 className="doc-h">Abaco delle murature</h3>
      <table className="table">
        <thead>
          <tr>
            <th>Sigla</th><th>Tipologia</th><th>Livello</th><th className="num">L m</th><th className="num">H m</th><th className="num">Sp. cm</th><th className="num">Aperture</th><th className="num">Sup. netta m²</th><th className="num">Volume m³</th>
          </tr>
        </thead>
        <tbody>
          {walls.map((r) => (
            <tr key={r.id}>
              <td className="mono accent">{r.mark}</td><td>{r.type}</td><td>{r.level}</td>
              <td className="num mono">{fmt(r.length)}</td><td className="num mono">{fmt(r.height)}</td><td className="num mono">{fmt(r.thickness * 100, 1)}</td>
              <td className="num mono">{r.openings}</td><td className="num mono strong">{fmt(r.netArea)}</td><td className="num mono">{fmt(r.volume, 3)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={7}>Totale</td>
            <td className="num mono">{fmt(walls.reduce((s, r) => s + r.netArea, 0))}</td>
            <td className="num mono">{fmt(walls.reduce((s, r) => s + r.volume, 0), 3)}</td>
          </tr>
        </tfoot>
      </table>

      <h3 className="doc-h">Abaco dei solai e delle pavimentazioni</h3>
      <table className="table">
        <thead>
          <tr><th>Tipologia</th><th>Livello</th><th>Pavimento</th><th className="num">Spessore cm</th><th className="num">Superficie m²</th><th className="num">Volume m³</th></tr>
        </thead>
        <tbody>
          {slabs.map((s) => {
            if (s.kind !== 'slab') return null;
            const t = byId(project.catalog.slab, s.typeId);
            const A = polygonArea(s.points);
            return (
              <tr key={s.id}>
                <td>{t?.name}</td><td>{byId(project.levels, s.levelId)?.name}</td><td>{t?.finishName}</td>
                <td className="num mono">{fmt((t?.thickness ?? 0) * 100, 1)}</td><td className="num mono strong">{fmt(A)}</td><td className="num mono">{fmt(A * (t?.thickness ?? 0), 3)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PriceList({ project }: { project: Project }) {
  const edit = useStore((s) => s.edit);
  const used = new Set(computeComputo(project).map((l) => l.code));
  const upd = (code: string, patch: Partial<PriceItem>) =>
    edit((d) => {
      const it = d.prices.find((p) => p.code === code);
      if (it) Object.assign(it, patch);
    });
  return (
    <>
      <div className="doc-toolbar">
        <input
          className="cell-input cell-wide"
          defaultValue={project.priceListName}
          onBlur={(e) => edit((d) => void (d.priceListName = e.target.value))}
          title="Nome del prezzario"
        />
        <button
          className="btn"
          onClick={() =>
            edit((d) => {
              let n = d.prices.length + 1;
              while (d.prices.some((p) => p.code === `NP.${String(n).padStart(2, '0')}`)) n++;
              d.prices.push({ code: `NP.${String(n).padStart(2, '0')}`, description: 'Nuovo prezzo', unit: 'm²', price: 0, category: 'Finiture' });
            })
          }
        >
          <Icon name="plus" size={14} /> Nuovo prezzo
        </button>
      </div>
      <table className="table">
        <thead>
          <tr><th style={{ width: 90 }}>Codice</th><th>Descrizione</th><th style={{ width: 70 }}>U.M.</th><th style={{ width: 170 }}>Categoria</th><th className="num" style={{ width: 110 }}>Prezzo €</th><th style={{ width: 80 }}>Uso</th><th style={{ width: 30 }} /></tr>
        </thead>
        <tbody>
          {project.prices.map((p) => (
            <tr key={p.code}>
              <td className="mono accent">{p.code}</td>
              <td><input className="cell-input cell-wide" defaultValue={p.description} onBlur={(e) => e.target.value !== p.description && upd(p.code, { description: e.target.value })} /></td>
              <td>
                <select className="cell-input" value={p.unit} onChange={(e) => upd(p.code, { unit: e.target.value as PriceItem['unit'] })}>
                  {['m', 'm²', 'm³', 'cad', 'kg'].map((u) => <option key={u}>{u}</option>)}
                </select>
              </td>
              <td>
                <select className="cell-input" value={p.category} onChange={(e) => upd(p.code, { category: e.target.value as WbsCategory })}>
                  {WBS.map((c) => <option key={c}>{c}</option>)}
                </select>
              </td>
              <td className="num"><input className="cell-input mono" defaultValue={p.price.toFixed(2)} onBlur={(e) => { const v = parseFloat(e.target.value.replace(',', '.')); if (isFinite(v)) upd(p.code, { price: v }); }} /></td>
              <td>{used.has(p.code) ? <span className="badge badge-ok">in uso</span> : <span className="muted">—</span>}</td>
              <td>
                <button className="icon-btn" disabled={used.has(p.code)} title={used.has(p.code) ? 'Voce usata nel computo' : 'Elimina'} onClick={() => edit((d) => void (d.prices = d.prices.filter((x) => x.code !== p.code)))}>
                  <Icon name="trash" size={13} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

const DONUT_COLORS = ['#38bdf8', '#f59e0b', '#a78bfa', '#34d399', '#f472b6', '#94a3b8', '#fb7185', '#facc15'];

function Donut({ data }: { data: { label: string; value: number }[] }) {
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  let acc = 0;
  const R = 42;
  const C = 2 * Math.PI * R;
  return (
    <div className="donut">
      <svg viewBox="-60 -60 120 120" width={120} height={120}>
        {data.map((d, i) => {
          const len = (d.value / total) * C;
          const el = (
            <circle key={d.label} r={R} fill="none" stroke={DONUT_COLORS[i % DONUT_COLORS.length]} strokeWidth={14} strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-acc} transform="rotate(-90)" />
          );
          acc += len;
          return el;
        })}
      </svg>
      <div className="donut-legend">
        {data.map((d, i) => (
          <div key={d.label}>
            <span className="dot" style={{ background: DONUT_COLORS[i % DONUT_COLORS.length] }} />
            <span>{d.label}</span>
            <b className="mono">{fmt((d.value / total) * 100, 1)}%</b>
          </div>
        ))}
      </div>
    </div>
  );
}

function exportCsv(p: Project, lines: ComputoLine[]) {
  const num = (n: number) => n.toFixed(2).replace('.', ',');
  const rows = [['N.', 'Codice', 'Categoria', 'Descrizione', 'U.M.', 'Quantità', 'Prezzo unitario', 'Importo']];
  lines.forEach((l, i) => {
    rows.push([String(i + 1), l.code, l.category, l.item?.description ?? '', l.item?.unit ?? '', num(l.qty), num(l.item?.price ?? 0), num(l.amount)]);
    for (const m of l.measurements) rows.push(['', '', '', `   ${m.label} · ${m.level} · ${m.formula}`, '', num(m.qty), '', '']);
  });
  rows.push(['', '', '', 'TOTALE', '', '', '', num(lines.reduce((s, l) => s + l.amount, 0))]);
  const csv = rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(';')).join('\n');
  downloadText(`Computo_${p.name}.csv`, '﻿' + csv, 'text/csv');
}
