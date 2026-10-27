import React, { useMemo, useRef, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from 'recharts';
import { COST_CATEGORIES, type CostingResult } from '../../shared/engine';
import { num, pct, qty, sek } from './format';
import { Badge, Button, NumInput, Warnings } from './ui';

export interface MaterialOption { id: number; code: string; name: string; baseUnit: string; category: string; archived?: boolean; currentPrice?: { landedUnitPriceSek: string } | null; reviewStatus?: string }

/** Searchable material selector for spreadsheet rows. */
export function MaterialPicker({ value, options, onChange, filter, placeholder = 'Search material…' }: { value: number | null; options: MaterialOption[]; onChange: (id: number | null) => void; filter?: (m: MaterialOption) => boolean; placeholder?: string }) {
  const current = options.find((o) => o.id === value);
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [hl, setHl] = useState(0);
  const ref = useRef<HTMLInputElement>(null);
  const list = useMemo(() => {
    const t = text.toLowerCase();
    return options.filter((o) => !o.archived && (!filter || filter(o)) && (!t || o.name.toLowerCase().includes(t) || o.code.toLowerCase().includes(t))).slice(0, 40);
  }, [text, options, filter]);
  const pick = (o: MaterialOption) => { onChange(o.id); setOpen(false); setText(''); ref.current?.blur(); };
  return (
    <div className="combo">
      <input
        ref={ref}
        className="input input-sm"
        value={open ? text : current ? current.name : ''}
        placeholder={current ? current.name : placeholder}
        onFocus={() => { setOpen(true); setText(''); setHl(0); }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => { setText(e.target.value); setHl(0); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { setHl((h) => Math.min(h + 1, list.length - 1)); e.preventDefault(); }
          if (e.key === 'ArrowUp') { setHl((h) => Math.max(h - 1, 0)); e.preventDefault(); }
          if (e.key === 'Enter' && list[hl]) { pick(list[hl]); e.preventDefault(); }
          if (e.key === 'Escape') { setOpen(false); ref.current?.blur(); }
        }}
      />
      {open && (
        <div className="combo-list">
          {list.length === 0 && <div className="combo-item muted">No match. Add the material under Materials first.</div>}
          {list.map((o, i) => (
            <div key={o.id} className={`combo-item ${i === hl ? 'hl' : ''}`} onMouseDown={() => pick(o)} onMouseEnter={() => setHl(i)}>
              <span>{o.name} <span className="muted small">{o.code}</span></span>
              <span className="muted small nowrap">{o.currentPrice ? `${num(o.currentPrice.landedUnitPriceSek, 2)} SEK/${o.baseUnit}` : o.currentPrice === null ? 'no price' : o.baseUnit}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const SECTION_LABELS: Record<string, string> = { ingredients: 'Ingredients', ...COST_CATEGORIES, packaging: 'Packaging' };
export const SECTION_COLORS: Record<string, string> = {
  ingredients: '#2f7a62', consumable: '#8aa79a', labour: '#4f6fa8', setup_cleaning: '#7d8fbf', testing: '#a37a3c', utilities_equipment: '#b39b6b', overhead: '#7a6a9a', other: '#9a9a9a', packaging: '#c0784f',
};

/** Full itemised breakdown with quantities, rates and formulas. */
export function CostBreakdown({ result, showFormulas = true }: { result: CostingResult; showFormulas?: boolean }) {
  const sections = ['ingredients', ...Object.keys(COST_CATEGORIES), 'packaging'];
  return (
    <div className="table-wrap">
      <table className="table compact">
        <thead><tr><th>Line</th><th className="num">Quantity</th><th className="num">Rate</th>{showFormulas && <th>Calculation</th>}<th className="num">Batch cost</th></tr></thead>
        <tbody>
          {sections.map((s) => {
            const lines = result.lines.filter((l) => l.section === s);
            if (!lines.length) return null;
            const subtotal = s === 'packaging' ? result.packagingCost : result.sections[s];
            return (
              <React.Fragment key={s}>
                <tr className="section-row"><td colSpan={showFormulas ? 4 : 3}>{SECTION_LABELS[s]}</td><td className="num">{sek(subtotal)}</td></tr>
                {lines.map((l) => (
                  <tr key={l.ref} className={l.status === 'missing' ? 'row-missing' : l.status === 'error' ? 'row-error' : ''}>
                    <td>{l.label} {l.status !== 'ok' && <Badge tone={l.status === 'missing' ? 'warn' : 'error'}>{l.status === 'missing' ? 'Missing' : 'Error'}</Badge>} {l.priceOverridden && <Badge tone="accent">Scenario price</Badge>}</td>
                    <td className="num nowrap">{l.quantity ? qty(l.quantity, l.quantityUnit, 6) : '—'}</td>
                    <td className="num nowrap">{l.rate ? `${num(l.rate, 4)} ${l.rateUnit ?? ''}` : '—'}</td>
                    {showFormulas && <td className="formula">{l.formula}</td>}
                    <td className="num nowrap">{l.amount ? sek(l.amount) : l.section === 'packaging' && l.status === 'ok' ? '—' : <span className="muted">not costed</span>}</td>
                  </tr>
                ))}
              </React.Fragment>
            );
          })}
        </tbody>
        <tfoot>
          <tr><td colSpan={showFormulas ? 4 : 3}>Total batch cost {result.complete ? '' : <Badge tone="warn">Incomplete</Badge>}</td><td className="num">{sek(result.totalBatchCost)}</td></tr>
        </tfoot>
      </table>
    </div>
  );
}

/** Summary of the batch result: outputs, unit costs and warnings. */
export function CostSummary({ result, title = 'Estimated cost' }: { result: CostingResult; title?: string }) {
  const u = result.outputUnit;
  const isActual = result.basis === 'actual';
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row-between">
        <span className={isActual ? 'tag-act' : 'tag-est'}>{isActual ? 'Actual' : title}</span>
        {result.complete ? <Badge tone="ok">Complete</Badge> : <Badge tone="warn">Incomplete costing</Badge>}
      </div>
      <div className="grid-2" style={{ gap: 10 }}>
        <div><div className="muted small">Cost per sellable {u}</div><div className="big-number">{sek(result.costPerOutputUnit)}</div></div>
        <div><div className="muted small">Cost per package</div><div className="big-number">{result.costPerPackage ? sek(result.costPerPackage) : '—'}</div></div>
      </div>
      <div className="summary-list small">
        <span className="lbl">Reference batch (recipe quantities)</span><span className="val">{qty(result.referenceBatchQty, u)}</span>
        <span className="lbl">Selected production scale</span><span className="val">{qty(result.batchQty, u)} <span className="muted">(×{num(result.scaleFactor, 4)})</span></span>
        <span className="lbl">Yield {result.yieldSource === 'override' ? '(override)' : result.yieldSource === 'actual' ? '(actual)' : result.yieldSource === 'stages' ? '(from loss stages)' : ''}</span><span className="val">{pct(result.yieldPct, 2)}</span>
        <span className="lbl">Expected finished output</span><span className="val">{qty(result.expectedOutputQty, u)}</span>
        {result.packagedUnits && <><span className="lbl">Packaged units</span><span className="val">{num(result.packagedUnits, 0)} × {qty(result.fillQtyInOutputUnit, u)}</span></>}
        {result.fillRemainder && result.fillRemainder !== '0' && <><span className="lbl">Unfilled remainder</span><span className="val">{qty(result.fillRemainder, u)}</span></>}
        <span className="lbl">Sellable output (cost denominator)</span><span className="val">{qty(result.sellableQty, u)}</span>
        <span className="lbl total">Production cost (excl. packaging)</span><span className="val total">{sek(result.productionCost)}</span>
        {result.packagingCost && <><span className="lbl">Packaging ({sek(result.packagingPerPackage)} / package)</span><span className="val">{sek(result.packagingCost)}</span></>}
        <span className="lbl total">Total batch cost</span><span className="val total">{sek(result.totalBatchCost)}</span>
      </div>
      <Warnings items={result.warnings} />
    </div>
  );
}

export function SectionChart({ result }: { result: CostingResult; height?: number }) {
  const [hover, setHover] = useState<string | null>(null);
  const data = Object.entries({ ...result.sections, ...(result.packagingCost ? { packaging: result.packagingCost } : {}) })
    .map(([k, v]) => ({ key: k, name: SECTION_LABELS[k] ?? k, value: Number(v) }))
    .filter((d) => d.value > 0)
    .sort((a, b) => b.value - a.value);
  if (!data.length) return <div className="muted small">No costed lines yet.</div>;
  const total = data.reduce((s, d) => s + d.value, 0);
  const max = data[0].value;
  const sellable = Number(result.sellableQty) || null;
  return (
    <div className="hbars" onMouseLeave={() => setHover(null)}>
      {data.map((d) => (
        <div key={d.key} className="hbar-row" onMouseEnter={() => setHover(d.key)}>
          <div className="hbar-label">{d.name}</div>
          <div className="hbar-track">
            <div className="hbar-fill" style={{ width: `${(d.value / max) * 100}%`, background: SECTION_COLORS[d.key] ?? '#999' }} />
            {hover === d.key && (
              <div className="hbar-tip">
                <strong>{d.name}</strong><br />{sek(d.value)} per batch · {((d.value / total) * 100).toFixed(1)} %
                {sellable ? <><br />{sek(d.value / sellable)} per sellable {result.outputUnit}</> : null}
              </div>
            )}
          </div>
          <div className="hbar-val">{((d.value / total) * 100).toFixed(0)} %</div>
        </div>
      ))}
    </div>
  );
}

export function ProductCostChart({ rows, unitLabel, onSelect }: { rows: { id: number; name: string; sections: Record<string, string>; complete: boolean }[]; unitLabel: string; onSelect?: (id: number) => void }) {
  const keys = ['ingredients', ...Object.keys(COST_CATEGORIES)].filter((k) => rows.some((r) => Number(r.sections[k] ?? 0) > 0));
  const data = rows.map((r) => ({ id: r.id, name: r.name + (r.complete ? '' : ' *'), ...Object.fromEntries(keys.map((k) => [k, Number(r.sections[k] ?? 0)])) }));
  return (
    <ResponsiveContainer width="100%" height={Math.max(220, rows.length * 34 + 60)}>
      <BarChart data={data} layout="vertical" margin={{ left: 10, right: 20, top: 4, bottom: 4 }} onClick={(e: any) => e?.activePayload?.[0] && onSelect?.(e.activePayload[0].payload.id)}>
        <CartesianGrid horizontal={false} stroke="#eef0ec" />
        <XAxis type="number" tickFormatter={(v) => num(v, 0)} fontSize={11} label={{ value: unitLabel, position: 'insideBottomRight', offset: -2, fontSize: 11 }} />
        <YAxis type="category" dataKey="name" width={190} fontSize={12} />
        <Tooltip formatter={(v: any, n: any) => [sek(v), SECTION_LABELS[n] ?? n]} />
        <Legend formatter={(v) => SECTION_LABELS[v] ?? v} wrapperStyle={{ fontSize: 12 }} />
        {keys.map((k) => <Bar key={k} dataKey={k} stackId="a" fill={SECTION_COLORS[k]} cursor="pointer" isAnimationActive={false} />)}
      </BarChart>
    </ResponsiveContainer>
  );
}

export type BatchCostRow = { category: string; description: string; amount: string };
export const BATCH_COST_CATEGORIES: Record<string, string> = {
  labour: 'Labour', setup_cleaning: 'Setup and cleaning', testing: 'Quality testing', utilities_equipment: 'Utilities and equipment', consumable: 'Consumables', other: 'Other',
};

/** Costs entered for one specific batch (e.g. labour), added as fixed amounts on top of the recipe. */
export function BatchCostsEditor({ rows, onChange, disabled }: { rows: BatchCostRow[]; onChange: (rows: BatchCostRow[]) => void; disabled?: boolean }) {
  const set = (i: number, patch: Partial<BatchCostRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="stack" style={{ gap: 6 }}>
      {rows.map((r, i) => (
        <div key={i} className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
          <select className="input input-sm" style={{ width: 170 }} disabled={disabled} value={r.category} onChange={(e) => set(i, { category: e.target.value })}>
            {Object.entries(BATCH_COST_CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <input className="input input-sm" disabled={disabled} value={r.description} placeholder="e.g. 2 operators × 3 h" onChange={(e) => set(i, { description: e.target.value })} />
          <NumInput className="input-sm" style={{ width: 120 }} disabled={disabled} value={r.amount} placeholder="SEK" onChange={(v) => set(i, { amount: v })} />
          {!disabled && <button className="icon-btn" title="Remove" onClick={() => onChange(rows.filter((_, j) => j !== i))}>×</button>}
        </div>
      ))}
      {!disabled && <div><Button size="sm" onClick={() => onChange([...rows, { category: 'labour', description: '', amount: '' }])}>{rows.length ? 'Add another cost' : 'Add labour or other batch cost'}</Button></div>}
    </div>
  );
}

export const validBatchCosts = (rows: BatchCostRow[]) => rows.filter((r) => r.amount !== '').map((r) => ({ category: r.category, description: r.description, amount: r.amount.replace(',', '.') }));
