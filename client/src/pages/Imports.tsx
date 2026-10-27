import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Alert, Badge, Button, Card, Empty, Field, Loading, NumInput, PageHeader, StatusBadge, useAction, useConfirm, useLoad } from '../ui';
import { dateTime, num, sek } from '../format';
import { dec } from '../../../shared/decimal';

const KIND_LABEL: Record<string, string> = { batchworks_materials: 'Batchworks materials', batchworks_costing: 'Batchworks recipe costing', materials_csv: 'Kuna materials CSV' };

function IssueList({ issues }: { issues: any[] }) {
  if (!issues?.length) return <span className="muted small">No issues</span>;
  return (
    <ul className="warnings">{issues.map((i, k) => <li key={k} className={`w-${i.level}`}><span className="w-dot" />{i.field && <strong>{i.field}: </strong>}{i.message}</li>)}</ul>
  );
}

export default function Imports() {
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const list = useLoad<any[]>('/api/imports');
  const { run, busy } = useAction();
  const selected = sp.get('id');
  const [drag, setDrag] = useState(false);

  const upload = async (files: FileList | File[]) => {
    const arr = await Promise.all([...files].map(async (f) => ({ filename: f.name, text: await f.text() })));
    const r = await run(() => api.post('/api/imports/preview', { files: arr }), `${arr.length} file(s) ready for review`);
    if (r) { await list.reload(); setSp({ id: String(r.ids[0]) }); }
  };
  const pending = (list.data ?? []).filter((i) => i.status === 'preview');

  return (
    <div>
      <PageHeader title="Imports" subtitle="Upload Batchworks exports or Kuna CSV files. Nothing changes until you review the preview and apply it. Original values are kept with every imported record." />
      <div className="grid-main-side" style={{ gridTemplateColumns: '320px minmax(0, 1fr)' }}>
        <div className="stack">
          <Card title="Upload">
            <label className={`card`} style={{ display: 'block', padding: 20, textAlign: 'center', borderStyle: 'dashed', background: drag ? 'var(--accent-soft)' : 'var(--surface-2)', cursor: 'pointer' }}
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); upload(e.dataTransfer.files); }}>
              <input type="file" accept=".csv,text/csv" multiple hidden onChange={(e) => e.target.files && upload(e.target.files)} disabled={busy} />
              <div><strong>Choose CSV files</strong> or drop them here</div>
              <div className="muted small" style={{ marginTop: 6 }}>Materials file and recipe files can be uploaded together; materials are previewed first.</div>
            </label>
          </Card>
          <Card title="Import history" pad={false}>
            {!list.data ? <Loading error={list.error} /> : list.data.length === 0 ? <Empty title="No imports yet" /> : (
              <table className="table compact"><tbody>
                {list.data.map((i) => (
                  <tr key={i.id} className="clickable" onClick={() => setSp({ id: String(i.id) })} style={String(i.id) === selected ? { background: 'var(--accent-soft)' } : undefined}>
                    <td><div className="small"><strong>{i.filename}</strong></div><div className="muted small">{KIND_LABEL[i.kind]} · {dateTime(i.created_at)}</div></td>
                    <td><Badge tone={i.status === 'preview' ? 'warn' : i.status === 'applied' ? 'ok' : 'neutral'}>{i.status === 'preview' ? 'To review' : i.status}</Badge></td>
                  </tr>))}
              </tbody></table>
            )}
          </Card>
        </div>
        <div>
          {selected ? <ImportReview key={selected} id={Number(selected)} onDone={() => { list.reload(); const next = pending.find((p) => String(p.id) !== selected); setSp(next ? { id: String(next.id) } : {}); }} />
            : <Card><Empty title={pending.length ? `${pending.length} import(s) waiting for review` : 'Select or upload an import'} action={pending.length ? <Button kind="primary" onClick={() => setSp({ id: String(pending[pending.length - 1].id) })}>Review next</Button> : undefined}>Every row shows the original values, the proposed mapping and any warnings.</Empty></Card>}
          {pending.length > 0 && selected && <div className="muted small" style={{ marginTop: 8 }}>{pending.length} import(s) still waiting for review. <Button kind="link" onClick={() => nav('/recipes')}>Go to recipes</Button></div>}
        </div>
      </div>
    </div>
  );
}

function ImportReview({ id, onDone }: { id: number; onDone: () => void }) {
  const { data, error, reload } = useLoad<any>(`/api/imports/${id}`);
  const { run, busy } = useAction();
  const confirm = useConfirm();
  if (!data) return <Card><Loading error={error} /></Card>;
  const discard = async () => {
    if (!(await confirm({ title: 'Discard this import?', body: 'The preview is closed and nothing is imported. The file stays in the history.', danger: true, confirmText: 'Discard' }))) return;
    if (await run(() => api.post(`/api/imports/${id}/discard`), 'Import discarded')) onDone();
  };
  const header = (
    <div className="row-between" style={{ marginBottom: 12 }}>
      <div><h2>{data.filename}</h2><div className="muted small">{KIND_LABEL[data.kind]} · uploaded {dateTime(data.createdAt)} · <StatusBadge status={data.status === 'preview' ? 'draft' : data.status} /></div></div>
      {data.status === 'preview' && <Button kind="danger" onClick={discard} disabled={busy}>Discard</Button>}
    </div>
  );
  if (data.kind === 'batchworks_costing') return <Card>{header}<CostingReview data={data} onApplied={() => { reload(); onDone(); }} /></Card>;
  return <Card>{header}<MaterialsReview data={data} onApplied={() => { reload(); onDone(); }} /></Card>;
}

function MaterialsReview({ data, onApplied }: { data: any; onApplied: () => void }) {
  const { run, busy } = useAction();
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [open, setOpen] = useState<number | null>(null);
  const props: any[] = data.parsed.proposals;
  const counts = { create: props.filter((p) => p.action === 'create').length, price: props.filter((p) => p.action !== 'skip').length, review: props.filter((p) => p.needsReview).length, skip: props.filter((p) => p.action === 'skip').length };
  return (
    <div className="stack">
      <IssueList issues={data.parsed.fileIssues} />
      <Alert tone="info">{counts.create} new materials, {counts.price} prices, {counts.review} flagged for review{counts.skip ? `, ${counts.skip} rows with errors (skipped)` : ''}. Flagged materials import as <strong>Needs review</strong> and remain usable. Click a row to see all original values.</Alert>
      <div className="table-wrap"><table className="table compact">
        <thead><tr><th></th><th>Row</th><th>Material</th><th>Action</th><th>Proposed price</th><th>Warnings</th></tr></thead>
        <tbody>{props.map((p) => (
          <React.Fragment key={p.rowNo}>
            <tr className={p.action === 'skip' ? 'row-error' : p.needsReview ? 'row-missing' : ''}>
              <td>{data.status === 'preview' && p.action !== 'skip' && <input type="checkbox" checked={!excluded.has(p.rowNo)} onChange={(e) => { const n = new Set(excluded); e.target.checked ? n.delete(p.rowNo) : n.add(p.rowNo); setExcluded(n); }} />}</td>
              <td className="muted">{p.rowNo}</td>
              <td className="clickable" onClick={() => setOpen(open === p.rowNo ? null : p.rowNo)}><strong>{p.material.name}</strong><div className="muted small">{p.material.code} · {p.material.category} · per {p.material.baseUnit ?? '?'}</div></td>
              <td><Badge tone={p.action === 'create' ? 'info' : p.action === 'skip' ? 'error' : 'neutral'}>{p.action === 'create' ? 'Create' : p.action === 'skip' ? 'Skip' : p.action === 'update' ? 'Update' : 'Add price'}</Badge></td>
              <td className="small">{p.price ? <><strong>{num(p.price.landed, 4)} SEK/{p.material.baseUnit}</strong><div className="formula">{p.price.formula}</div><div className="muted">effective {p.price.effectiveDate}{p.price.rateDate ? ` · rate date ${p.price.rateDate}` : ''}</div></> : <Badge tone="warn">No price</Badge>}</td>
              <td style={{ maxWidth: 420 }}><IssueList issues={p.issues} /></td>
            </tr>
            {open === p.rowNo && <tr><td></td><td colSpan={5}><table className="table compact"><tbody>{Object.entries(p.original).map(([k, v]) => <tr key={k}><td className="muted" style={{ width: 200 }}>{k}</td><td>{String(v) || <span className="muted">(empty)</span>}</td></tr>)}</tbody></table></td></tr>}
          </React.Fragment>
        ))}</tbody>
      </table></div>
      {data.status === 'preview' && <div className="row"><Button kind="primary" disabled={busy} onClick={async () => { if (await run(() => api.post(`/api/imports/${data.id}/apply`, { excludeRows: [...excluded] }), 'Materials imported')) onApplied(); }}>Apply import ({props.filter((p) => p.action !== 'skip' && !excluded.has(p.rowNo)).length} rows)</Button></div>}
    </div>
  );
}

function CostingReview({ data, onApplied }: { data: any; onApplied: () => void }) {
  const a = data.parsed;
  const p = a.parsed;
  const [d, setD] = useState<any>(data.decisions?.decisions ? { ...a.proposed, ...data.decisions.decisions } : a.proposed);
  const set = (k: string, v: any) => setD((x: any) => ({ ...x, [k]: v }));
  const mats = useLoad<any[]>('/api/materials');
  const { run, busy } = useAction();
  useEffect(() => setD((x: any) => ({ ...x, materialMap: { ...a.proposed.materialMap, ...x.materialMap } })), [a.proposed.materialMap]);
  const isPreview = data.status === 'preview';
  const lab = p.labour[0];
  const unit = d.fillUnit === 'kg' || d.fillUnit === 'g' ? 'kg' : 'L';
  const scale = dec(d.defaultBatchQty) && dec(d.referenceBatchQty) ? dec(d.defaultBatchQty)!.div(d.referenceBatchQty) : null;

  return (
    <div className="stack">
      <div className="grid-2">
        <div>
          <h4>Original header</h4>
          <table className="table compact"><tbody>{Object.entries(p.header).map(([k, v]) => <tr key={k}><td className="muted">{k}</td><td>{String(v)}</td></tr>)}</tbody></table>
        </div>
        <div>
          <h4>Original summary vs. recomputed</h4>
          <table className="table compact"><thead><tr><th>Line</th><th className="num">Export</th><th className="num">Recomputed</th></tr></thead>
            <tbody>{a.totals.map((t: any) => <tr key={t.label}><td>{t.label}</td><td className="num">{t.original ?? '—'}</td><td className="num">{t.recomputed} {t.original && (t.ok ? <Badge tone="ok">✓</Badge> : <Badge tone="warn">≠</Badge>)}</td></tr>)}
              {Object.entries(p.summary).filter(([k]) => /Sell price|Profit|Overhead/.test(k)).map(([k, v]: any) => <tr key={k}><td className="muted">{k}</td><td className="num muted">{v[0] ?? ''}</td><td className="muted small">not imported as fact</td></tr>)}
            </tbody></table>
        </div>
      </div>

      <div><h4>Findings</h4><IssueList issues={a.issues} /></div>

      <div>
        <h4>Ingredient lines</h4>
        <div className="table-wrap"><table className="table compact">
          <thead><tr><th>Ingredient (original)</th><th className="num">Qty</th><th className="num">Export price</th><th className="num">Export cost</th><th className="num">Qty × price</th><th className="num">Ratio</th><th>Maps to material</th><th className="num">Current price</th></tr></thead>
          <tbody>{a.lineChecks.map((l: any, i: number) => {
            const ing = p.ingredients[i];
            return (
              <tr key={l.name}>
                <td>{l.name}</td><td className="num">{ing.quantity} {ing.unit}</td><td className="num">{ing.unitPrice}/{ing.per}</td><td className="num">{l.original}</td>
                <td className="num">{l.computedRaw ?? '—'}</td><td className="num">{l.ratio ? `×${l.ratio}` : '—'}</td>
                <td>{isPreview ? (
                  <select className="input input-sm" style={{ minWidth: 190 }} value={String(d.materialMap?.[l.name] ?? 'create')} onChange={(e) => set('materialMap', { ...d.materialMap, [l.name]: e.target.value === 'create' ? 'create' : Number(e.target.value) })}>
                    <option value="create">Create “{l.name}” (no price)</option>
                    {(mats.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>) : l.matchedName ?? 'created'}
                  {l.note && <div className="muted small">{l.note}</div>}</td>
                <td className="num">{l.currentPrice ? num(l.currentPrice, 4) : <span className="muted">—</span>}</td>
              </tr>);
          })}
          </tbody>
        </table></div>
      </div>

      {p.packaging.length > 0 && <div><h4>Packaging (original)</h4><table className="table compact"><thead><tr><th>Item</th><th className="num">“Per unit”</th><th className="num">Price</th><th className="num">Cost</th></tr></thead><tbody>{p.packaging.map((x: any) => <tr key={x.name}><td>{x.name}</td><td className="num">{x.perUnit}</td><td className="num">{x.unitPrice}/{x.per}</td><td className="num">{x.cost}</td></tr>)}</tbody></table></div>}

      <Card title="Confirm the intended meaning" className="no-shadow">
        <div className="form-grid">
          <Field label="Product name"><input className="input" value={d.productName} disabled={!isPreview} onChange={(e) => set('productName', e.target.value)} /></Field>
          <Field label="Product code"><input className="input" value={d.productCode} disabled={!isPreview} onChange={(e) => set('productCode', e.target.value)} /></Field>
          <Field label={`Reference batch (${unit})`} hint="Recipe quantities are for this amount."><NumInput value={d.referenceBatchQty} disabled={!isPreview} onChange={(v) => set('referenceBatchQty', v)} /></Field>
          <Field label={`Default production batch (${unit})`} hint={scale ? `Calculator scales recipe quantities ×${num(scale, 4)} once.` : undefined}><NumInput value={d.defaultBatchQty} disabled={!isPreview} onChange={(v) => set('defaultBatchQty', v)} /></Field>
          <Field label="Expected yield (%)" hint="Export shows 100 %: no losses recorded."><NumInput value={d.yieldPct} disabled={!isPreview} onChange={(v) => set('yieldPct', v)} /></Field>
          <Field label="Target gross margin (%)" hint="Optional; not an approved price."><NumInput value={d.targetMarginPct ?? ''} disabled={!isPreview} onChange={(v) => set('targetMarginPct', v || null)} /></Field>
        </div>

        {lab && (
          <div style={{ marginTop: 14 }}>
            <div className="field-label">Labour “{lab.name}”: export shows rate {lab.rate} SEK and {lab.hours} hours ({lab.cost} SEK)</div>
            <div className="stack" style={{ gap: 6, marginTop: 6 }}>
              {[
                ['exclude', 'Do not import labour (enter labour per batch instead)'],
                ['unresolved', 'Decide later (costing stays incomplete, original values kept)'],
                ['fixed', `Fixed ${lab.cost} SEK per batch (does not scale with batch size)`],
                ['swapped', `Rate and hours reversed: ${lab.hours} SEK/h × ${lab.rate} h per batch`],
                ['rate_x_hours', `As exported: ${lab.rate} SEK/h × ${lab.hours} h`],
              ].map(([k, label]) => <label key={k} className="check"><input type="radio" disabled={!isPreview} checked={d.labourChoice === k} onChange={() => set('labourChoice', k)} /> {label}</label>)}
            </div>
          </div>
        )}

        {p.packaging.length > 0 && (
          <div className="form-grid" style={{ marginTop: 14 }}>
            <Field label="Packaging format name"><input className="input" value={d.packagingName} disabled={!isPreview} onChange={(e) => set('packagingName', e.target.value)} /></Field>
            <Field label="Fill per package" hint={`Proposed: ${d.defaultBatchQty} ${unit} ÷ ${p.packaging[0].perUnit} packages`}>
              <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}><NumInput value={d.fillQty ?? ''} disabled={!isPreview} onChange={(v) => set('fillQty', v || null)} />
                <select className="input" style={{ width: 70 }} value={d.fillUnit} disabled={!isPreview} onChange={(e) => set('fillUnit', e.target.value)}>{['L', 'mL', 'kg', 'g'].map((u) => <option key={u}>{u}</option>)}</select></div>
            </Field>
            <Field label="Each component per package" hint={`Export shows ${p.packaging[0].perUnit} “per unit”, read as the batch total.`}><NumInput value={d.qtyPerPackage ?? ''} disabled={!isPreview} onChange={(v) => set('qtyPerPackage', v || null)} /></Field>
          </div>
        )}

        <label className="check" style={{ marginTop: 14 }}><input type="checkbox" disabled={!isPreview} checked={d.confirmed} onChange={(e) => set('confirmed', e.target.checked)} /> I confirm the batch, unit and packaging interpretation above.</label>
        <div className="muted small" style={{ marginTop: 4 }}>The recipe is imported as a draft. It stays <strong>Needs review</strong> until this is confirmed. Labour is not part of the recipe by default: enter it per production batch in the batch calculator or on the batch record.</div>
      </Card>

      {isPreview ? (
        <div className="row"><Button kind="primary" disabled={busy} onClick={async () => { if (await run(() => api.post(`/api/imports/${data.id}/apply`, { decisions: d }), `${d.productName} imported as a draft recipe`)) onApplied(); }}>Import recipe</Button>
          {mats.data && a.lineChecks.some((l: any) => !l.materialId && d.materialMap?.[l.name] === 'create') && <span className="muted small">Some ingredients will be created without a price. Import the materials file first to match them.</span>}
        </div>
      ) : <Alert tone="ok">Applied {dateTime(data.appliedAt)}. Expected export total for comparison: {sek(p.summary['Batch total']?.[0])}.</Alert>}
    </div>
  );
}
