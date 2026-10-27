import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Alert, Badge, Button, Card, Empty, Field, Loading, NumInput, PageHeader, SaveState, StatusBadge, Tabs, useAction, useConfirm, useLoad } from '../ui';
import { CostSummary, MaterialPicker, SectionChart, type MaterialOption } from '../components';
import { ProductForm } from './Recipes';
import { dateTime, num, pct, sek } from '../format';
import { calculateCosting, convertQty, COST_BASES, COST_CATEGORIES, PERCENT_BASES, type MaterialPrice, type RecipeForCosting } from '../../../shared/engine';
import { dec } from '../../../shared/decimal';

type Draft = {
  referenceBatchQty: string; defaultBatchQty: string; yieldMode: 'direct' | 'stages'; yieldPct: string; lossStages: { name: string; pct: string }[];
  instructions: string; notes: string;
  ingredients: { materialId: number | null; quantity: string; unit: any; note: string; needsReview?: boolean }[];
  costItems: any[];
};

const toDraft = (v: any): Draft => ({
  referenceBatchQty: v.referenceBatchQty ?? '', defaultBatchQty: v.defaultBatchQty ?? '', yieldMode: v.yieldMode, yieldPct: v.yieldPct ?? '',
  lossStages: v.lossStages ?? [], instructions: v.instructions ?? '', notes: v.notes ?? '',
  ingredients: v.ingredients.map((i: any) => ({ materialId: i.materialId, quantity: i.quantity ?? '', unit: i.unit, note: i.note ?? '', needsReview: i.needsReview })),
  costItems: v.costItems.map((c: any) => ({ ...c, rate: c.rate ?? '', hours: c.hours ?? '', stepSize: c.stepSize ?? '', note: c.note ?? '' })),
});

export function materialsToPrices(mats: any[]): Record<number, MaterialPrice> {
  return Object.fromEntries(mats.map((m) => [m.id, { id: m.id, code: m.code, name: m.name, baseUnit: m.baseUnit, densityKgPerL: m.densityKgPerL, unitPriceSek: m.currentPrice?.landedUnitPriceSek ?? null, needsReview: m.reviewStatus === 'needs_review' }]));
}

export default function RecipeEditor() {
  const { productId } = useParams();
  const [sp, setSp] = useSearchParams();
  const { can } = useAuth();
  const nav = useNavigate();
  const confirm = useConfirm();
  const product = useLoad<any>(`/api/products/${productId}`);
  const mats = useLoad<any[]>('/api/materials?archived=1');
  const versionId = Number(sp.get('v')) || product.data?.currentVersionId || product.data?.versions[0]?.id;
  const version = useLoad<any>(versionId ? `/api/recipe-versions/${versionId}` : null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState(sp.get('tab') ?? 'formulation');
  const [editingProduct, setEditingProduct] = useState(false);
  const [previewFormat, setPreviewFormat] = useState<number | ''>('');
  const { run, busy } = useAction();

  useEffect(() => { if (version.data) { setDraft(toDraft(version.data)); setDirty(false); if (!version.data.importOriginal) setTab((t) => (t === 'import' ? 'formulation' : t)); } }, [version.data]);
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const v = version.data;
  const p = product.data;
  const editable = !!v && v.status === 'draft' && can('recipes.write');
  const prices = useMemo(() => materialsToPrices(mats.data ?? []), [mats.data]);
  const fmt = p?.packagingFormats.find((f: any) => f.id === previewFormat);
  const result = useMemo(() => {
    if (!draft || !p || !can('costs.read')) return null;
    const recipe: RecipeForCosting = { outputUnit: p.outputUnit, ...draft, ingredients: draft.ingredients, costItems: draft.costItems };
    return calculateCosting({
      recipe, batchQty: draft.defaultBatchQty || draft.referenceBatchQty, materials: prices,
      packaging: fmt ? { name: fmt.name, fillQty: fmt.fillQty, fillUnit: fmt.fillUnit, components: fmt.components, needsReview: fmt.needsReview } : null,
    });
  }, [draft, p, prices, fmt, can]);
  const refResult = useMemo(() => {
    if (!draft || !p || !can('costs.read')) return null;
    return calculateCosting({ recipe: { outputUnit: p.outputUnit, ...draft }, batchQty: draft.referenceBatchQty, materials: prices });
  }, [draft, p, prices, can]);

  if (!p || !mats.data) return <Loading error={product.error || mats.error} />;
  if (!v || !draft) return <Loading error={version.error} />;

  const upd = (fn: (d: Draft) => Draft) => { setDraft((d) => fn(d!)); setDirty(true); };
  const save = async () => {
    const r = await run(() => api.put(`/api/recipe-versions/${v.id}`, { ...draft, ingredients: draft.ingredients.filter((i) => i.materialId || i.quantity) }), 'Draft saved');
    if (r) { version.setData(r); product.reload(); }
  };
  const switchVersion = async (id: number) => {
    if (dirty && !(await confirm({ title: 'Discard unsaved changes?', danger: true, confirmText: 'Discard' }))) return;
    setSp({ v: String(id) });
  };
  const newVersion = async () => {
    const r = await run(() => api.post(`/api/recipe-versions/${v.id}/new-version`), 'New draft version created');
    if (r) { await product.reload(); setSp({ v: String(r.id) }); }
  };
  const approve = async () => {
    if (dirty) return void (await confirm({ title: 'Save first', body: 'Save the draft before approving.' }));
    if (!(await confirm({ title: `Approve v${v.versionNo}?`, body: <>The version becomes locked and is used for current estimates and quotations. {p.versions.some((x: any) => x.status === 'approved') && 'The previously approved version is archived (kept for history).'}</>, confirmText: 'Approve' }))) return;
    if (await run(() => api.post(`/api/recipe-versions/${v.id}/approve`), 'Recipe approved')) { version.reload(); product.reload(); }
  };
  const ingTotalMass = draft.ingredients.reduce((s, i) => {
    const m = i.materialId ? prices[i.materialId] : null;
    const q = dec(i.quantity);
    if (!q || !m || (i.unit !== 'g' && i.unit !== 'kg')) return s;
    return s.plus(convertQty(q, i.unit, 'kg').ok ? (convertQty(q, i.unit, 'kg') as any).value : 0);
  }, dec('0')!);

  return (
    <div>
      <PageHeader
        title={<span className="row" style={{ gap: 8 }}>{p.name} <StatusBadge status={v.status} />{v.reviewStatus === 'needs_review' && <StatusBadge status="needs_review" />}</span>}
        subtitle={<>{p.code} · sold per {p.outputUnit}{p.description ? ` · ${p.description}` : ''}{can('costs.read') && p.targetMarginPct ? ` · target margin ${pct(p.targetMarginPct)}` : ''}</>}
        actions={<>
          <select className="input" style={{ width: 'auto' }} value={v.id} onChange={(e) => switchVersion(Number(e.target.value))}>
            {p.versions.map((x: any) => <option key={x.id} value={x.id}>v{x.versionNo} · {x.status}{x.reviewStatus === 'needs_review' ? ' · needs review' : ''}</option>)}
          </select>
          {can('recipes.write') && <Button onClick={() => setEditingProduct(true)}>Product settings</Button>}
          {can('costs.read') && <Button onClick={() => nav(`/calculator?versionId=${v.id}`)}>Open in calculator</Button>}
          {can('recipes.write') && <Button onClick={newVersion} disabled={busy}>{v.status === 'draft' ? 'Copy as new version' : 'Edit as new version'}</Button>}
          {editable && <Button kind="primary" onClick={save} disabled={busy || !dirty}>Save draft</Button>}
        </>} />

      {v.status !== 'draft' && <Alert tone="info">Version {v.versionNo} is {v.status}{v.approvedAt ? ` (approved ${dateTime(v.approvedAt)} by ${v.approvedByName ?? '—'})` : ''} and locked. {can('recipes.write') && 'Use “Edit as new version” to make changes; this version stays unchanged for saved records.'} Used by {v.usage.costings} costings, {v.usage.quotes} quotation lines and {v.usage.batches} batches.</Alert>}
      {v.reviewStatus === 'needs_review' && v.reviewNotes && (
        <Alert tone="warn"><div className="row-between"><strong>Needs review</strong>{editable && <Button size="sm" onClick={async () => {
          if (dirty) await save();
          if (await confirm({ title: 'Mark this version as reviewed?', body: <>Confirm these items are resolved:<ul>{v.reviewNotes.split('\n').map((n: string, i: number) => <li key={i}>{n}</li>)}</ul></>, confirmText: 'Mark reviewed' }) && await run(() => api.post(`/api/recipe-versions/${v.id}/review`, { status: 'ok' }), 'Marked as reviewed')) version.reload();
        }}>Mark reviewed</Button>}</div>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{v.reviewNotes.split('\n').map((n: string, i: number) => <li key={i}>{n}</li>)}</ul></Alert>
      )}

      <div className="row-between" style={{ margin: '14px 0 0' }}>
        <Tabs value={tab} onChange={(t) => setTab(t)} tabs={[
          { id: 'formulation', label: 'Formulation' }, { id: 'costs', label: `Production costs (${draft.costItems.length})` }, { id: 'packaging', label: `Packaging (${p.packagingFormats.filter((f: any) => !f.archived).length})` },
          { id: 'instructions', label: 'Instructions' }, { id: 'quality', label: 'Quality specs' }, ...(v.importOriginal ? [{ id: 'import', label: 'Imported data' }] : []),
        ]} />
        {editable && <SaveState dirty={dirty} saving={busy} savedAt={v.updatedAt ? dateTime(v.updatedAt) : null} />}
      </div>

      <div className={can('costs.read') ? 'grid-main-side' : ''}>
        <div className="stack">
          {tab === 'formulation' && <>
            <Card title="Batch and yield">
              <div className="form-grid">
                <Field label={`Reference batch size (${p.outputUnit})`} hint="Ingredient quantities below are for this batch."><NumInput value={draft.referenceBatchQty} disabled={!editable} onChange={(x) => upd((d) => ({ ...d, referenceBatchQty: x }))} /></Field>
                <Field label={`Default production scale (${p.outputUnit})`} hint="Used for estimates; change per batch in the calculator."><NumInput value={draft.defaultBatchQty} disabled={!editable} onChange={(x) => upd((d) => ({ ...d, defaultBatchQty: x }))} /></Field>
                <Field label="Yield method"><select className="input" disabled={!editable} value={draft.yieldMode} onChange={(e) => upd((d) => ({ ...d, yieldMode: e.target.value as any }))}><option value="direct">Overall expected yield</option><option value="stages">Loss stages</option></select></Field>
                {draft.yieldMode === 'direct' ? <Field label="Expected finished yield (%)" hint="Sellable output ÷ batch size."><NumInput value={draft.yieldPct} disabled={!editable} onChange={(x) => upd((d) => ({ ...d, yieldPct: x }))} /></Field>
                  : <Field label="Combined yield"><div className="input" style={{ display: 'flex', alignItems: 'center' }}>{refResult?.yieldPct ? pct(refResult.yieldPct, 2) : '—'}</div></Field>}
              </div>
              {draft.yieldMode === 'stages' && (
                <table className="table compact sheet" style={{ marginTop: 10 }}><thead><tr><th>Loss stage</th><th className="num">Loss %</th><th></th></tr></thead>
                  <tbody>{draft.lossStages.map((s, i) => (
                    <tr key={i}><td><input className="input input-sm" disabled={!editable} value={s.name} onChange={(e) => upd((d) => ({ ...d, lossStages: d.lossStages.map((x, j) => j === i ? { ...x, name: e.target.value } : x) }))} placeholder="e.g. Filtration" /></td>
                      <td style={{ width: 120 }}><NumInput className="input-sm" disabled={!editable} value={s.pct} onChange={(val) => upd((d) => ({ ...d, lossStages: d.lossStages.map((x, j) => j === i ? { ...x, pct: val } : x) }))} /></td>
                      <td style={{ width: 40 }}>{editable && <button className="icon-btn" onClick={() => upd((d) => ({ ...d, lossStages: d.lossStages.filter((_, j) => j !== i) }))}>×</button>}</td></tr>))}
                  </tbody></table>
              )}
              {draft.yieldMode === 'stages' && editable && <Button size="sm" style={{ marginTop: 6 }} onClick={() => upd((d) => ({ ...d, lossStages: [...d.lossStages, { name: '', pct: '' }] }))}>Add loss stage</Button>}
              <div className="muted small" style={{ marginTop: 8 }}>Each loss is counted once: either one overall yield or compounded stages, never both. Ingredient volumes are not assumed to add up to the finished volume.</div>
            </Card>

            <Card title={`Ingredients for the ${num(draft.referenceBatchQty)} ${p.outputUnit} reference batch`} pad={false}
              actions={<span className="muted small">{ingTotalMass.gt(0) && `${num(ingTotalMass, 4)} kg of mass-based ingredients`}</span>}>
              <div className="table-wrap"><table className="table compact sheet">
                <thead><tr><th style={{ width: 28 }}>#</th><th style={{ minWidth: 220 }}>Material</th><th className="num" style={{ width: 110 }}>Quantity</th><th style={{ width: 80 }}>Unit</th>
                  {can('costs.read') && <><th className="num">Price</th><th className="num">Cost (ref. batch)</th><th className="num">Share</th></>}<th>Note</th><th></th></tr></thead>
                <tbody>
                  {draft.ingredients.map((ing, i) => {
                    const line = refResult?.lines.find((l) => l.ref === `ing-${i}`);
                    const m = ing.materialId ? prices[ing.materialId] : null;
                    const share = line?.amount && refResult?.sections.ingredients && Number(refResult.sections.ingredients) > 0 ? Number(line.amount) / Number(refResult.sections.ingredients) * 100 : null;
                    return (
                      <tr key={i} className={line?.status === 'missing' ? 'row-missing' : line?.status === 'error' ? 'row-error' : ''}>
                        <td className="muted">{i + 1}</td>
                        <td>{editable ? <MaterialPicker value={ing.materialId} options={(mats.data as MaterialOption[]).filter((x) => !x.archived || x.id === ing.materialId)} onChange={(id) => upd((d) => ({ ...d, ingredients: d.ingredients.map((x, j) => j === i ? { ...x, materialId: id } : x) }))} />
                          : <Link to={`/materials/${ing.materialId}`}>{m?.name ?? '—'}</Link>}</td>
                        <td><NumInput className="input-sm" disabled={!editable} value={ing.quantity} invalid={ing.needsReview && !ing.quantity} placeholder={ing.needsReview ? 'enter' : ''} onChange={(x) => upd((d) => ({ ...d, ingredients: d.ingredients.map((y, j) => j === i ? { ...y, quantity: x } : y) }))} /></td>
                        <td><select className="input input-sm" disabled={!editable} value={ing.unit} onChange={(e) => upd((d) => ({ ...d, ingredients: d.ingredients.map((y, j) => j === i ? { ...y, unit: e.target.value } : y) }))}>{['g', 'kg', 'mL', 'L', 'pc'].map((u) => <option key={u}>{u}</option>)}</select></td>
                        {can('costs.read') && <>
                          <td className="num nowrap small">{m?.unitPriceSek ? `${num(m.unitPriceSek, 2)}/${m.baseUnit}` : m ? <Badge tone="warn">No price</Badge> : ''}</td>
                          <td className="num nowrap" title={line?.formula}>{line?.amount ? sek(line.amount) : line?.status === 'error' ? <Badge tone="error" title={line.message}>{line.message?.includes('density') ? 'Needs density' : 'Error'}</Badge> : '—'}</td>
                          <td className="num small muted">{share != null ? `${share.toFixed(1)} %` : ''}</td>
                        </>}
                        <td><input className="input input-sm" disabled={!editable} value={ing.note} onChange={(e) => upd((d) => ({ ...d, ingredients: d.ingredients.map((y, j) => j === i ? { ...y, note: e.target.value } : y) }))} /></td>
                        <td>{editable && <button className="icon-btn" title="Remove" onClick={() => upd((d) => ({ ...d, ingredients: d.ingredients.filter((_, j) => j !== i) }))}>×</button>}</td>
                      </tr>);
                  })}
                  {draft.ingredients.length === 0 && <tr><td colSpan={9}><Empty title="No ingredients yet">Add rows and pick materials from the catalogue.</Empty></td></tr>}
                </tbody>
                {can('costs.read') && refResult && <tfoot><tr><td colSpan={5}>Ingredient cost for the reference batch</td><td className="num">{sek(refResult.sections.ingredients)}</td><td colSpan={3}></td></tr></tfoot>}
              </table></div>
              {editable && <div className="card-body" style={{ paddingTop: 8 }}><Button size="sm" onClick={() => upd((d) => ({ ...d, ingredients: [...d.ingredients, { materialId: null, quantity: '', unit: 'g', note: '' }] }))}>Add ingredient</Button></div>}
            </Card>
          </>}

          {tab === 'costs' && <CostItemsEditor draft={draft} editable={editable} upd={upd} outputUnit={p.outputUnit} result={result} />}
          {tab === 'packaging' && <PackagingEditor product={p} materials={mats.data} prices={prices} onChanged={product.reload} />}
          {tab === 'instructions' && (
            <Card title="Production instructions and notes">
              <div className="stack">
                <Field label="Processing steps"><textarea className="input" style={{ minHeight: 220 }} disabled={!editable} value={draft.instructions} onChange={(e) => upd((d) => ({ ...d, instructions: e.target.value }))} placeholder="1. Weigh ingredients…" /></Field>
                <Field label="Notes"><textarea className="input" disabled={!editable} value={draft.notes} onChange={(e) => upd((d) => ({ ...d, notes: e.target.value }))} /></Field>
              </div>
            </Card>
          )}
          {tab === 'quality' && <QualitySpecs product={p} onChanged={product.reload} />}
          {tab === 'import' && v.importOriginal && <ImportOriginal o={v.importOriginal} />}

          <div className="row">
            {editable && <Button kind="primary" onClick={save} disabled={busy || !dirty}>Save draft</Button>}
            {can('recipes.approve') && v.status === 'draft' && <Button onClick={approve} disabled={busy}>Approve version</Button>}
            {can('recipes.write') && v.status !== 'archived' && <Button kind="danger" onClick={async () => { if (await confirm({ title: `Archive v${v.versionNo}?`, body: 'It stays in history and in saved records, but is no longer used for estimates.', danger: true, confirmText: 'Archive' }) && await run(() => api.post(`/api/recipe-versions/${v.id}/archive`), 'Version archived')) { version.reload(); product.reload(); } }}>Archive version</Button>}
            {can('recipes.write') && <Button onClick={async () => { const r = await run(() => api.post(`/api/products/${p.id}/duplicate`), 'Recipe duplicated as a new product'); if (r) nav(`/recipes/${r.id}`); }}>Duplicate recipe</Button>}
            {can('recipes.write') && <Button kind="danger" onClick={async () => { if (await confirm({ title: p.archived ? `Restore ${p.name}?` : `Archive ${p.name}?`, body: p.archived ? undefined : 'The product and its recipes are hidden from lists. Saved records are kept.', danger: !p.archived, confirmText: p.archived ? 'Restore' : 'Archive' }) && await run(() => api.post(`/api/products/${p.id}/archive`, { archived: !p.archived }), 'Saved')) product.reload(); }}>{p.archived ? 'Restore product' : 'Archive product'}</Button>}
          </div>
        </div>

        {can('costs.read') && result && (
          <div className="stack" style={{ position: 'sticky', top: 16 }}>
            <Card title="Live estimate" actions={<select className="input input-sm" style={{ width: 'auto' }} value={previewFormat} onChange={(e) => setPreviewFormat(e.target.value ? Number(e.target.value) : '')}><option value="">Bulk (no packaging)</option>{p.packagingFormats.filter((f: any) => !f.archived).map((f: any) => <option key={f.id} value={f.id}>{f.name}</option>)}</select>}>
              <CostSummary result={result} title={`Estimate at ${num(result.batchQty)} ${p.outputUnit}${dirty ? ' (unsaved)' : ''}`} />
            </Card>
            <Card title="Cost structure"><SectionChart result={result} height={200} /></Card>
          </div>
        )}
      </div>
      {editingProduct && <ProductForm product={p} onClose={() => setEditingProduct(false)} onSaved={() => { setEditingProduct(false); product.reload(); }} />}
    </div>
  );
}

function CostItemsEditor({ draft, editable, upd, outputUnit, result }: { draft: Draft; editable: boolean; upd: (fn: (d: Draft) => Draft) => void; outputUnit: string; result: any }) {
  const set = (i: number, k: string, val: any) => upd((d) => ({ ...d, costItems: d.costItems.map((c, j) => (j === i ? { ...c, [k]: val } : c)) }));
  return (
    <Card title="Labour, testing, consumables, utilities and overhead" pad={false}>
      <div className="card-body" style={{ paddingBottom: 0 }}><div className="muted small">Fixed costs do not change with batch size. Hourly costs scale only when “scales” is ticked. Step costs charge once per started step (e.g. one lab test per 500 {outputUnit}). Percentages apply to other production costs, never to themselves or packaging.</div></div>
      <div className="table-wrap"><table className="table compact sheet">
        <thead><tr><th>Category</th><th>Description</th><th>Basis</th><th className="num">Rate</th><th>Quantity / base</th><th className="num">Batch cost</th><th></th></tr></thead>
        <tbody>{draft.costItems.map((c, i) => {
          const line = result?.lines.find((l: any) => l.ref === `cost-${i}`);
          return (
            <tr key={i} className={line?.status === 'missing' ? 'row-missing' : ''}>
              <td><select className="input input-sm" disabled={!editable} value={c.category} onChange={(e) => set(i, 'category', e.target.value)}>{Object.entries(COST_CATEGORIES).filter(([k]) => k !== 'outsourcing' || c.category === k).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></td>
              <td><input className="input input-sm" disabled={!editable} value={c.description} onChange={(e) => set(i, 'description', e.target.value)} />{c.note && <div className="muted small">{c.note}</div>}</td>
              <td><select className="input input-sm" disabled={!editable} value={c.basis} onChange={(e) => set(i, 'basis', e.target.value)}>{Object.entries(COST_BASES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></td>
              <td style={{ width: 110 }}><NumInput className="input-sm" disabled={!editable} invalid={c.needsReview && !c.rate} value={c.rate} placeholder={c.basis === 'percent' ? '%' : 'SEK'} onChange={(x) => set(i, 'rate', x)} /></td>
              <td>
                {c.basis === 'per_hour' && <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}><NumInput className="input-sm" disabled={!editable} value={c.hours} onChange={(x) => set(i, 'hours', x)} placeholder="hours" style={{ width: 80 }} /><label className="check small"><input type="checkbox" disabled={!editable} checked={!!c.hoursScale} onChange={(e) => set(i, 'hoursScale', e.target.checked)} /> scales</label></div>}
                {c.basis === 'step' && <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}><span className="small muted">every</span><NumInput className="input-sm" disabled={!editable} value={c.stepSize} onChange={(x) => set(i, 'stepSize', x)} style={{ width: 80 }} /><span className="small muted">{outputUnit}</span></div>}
                {c.basis === 'percent' && <select className="input input-sm" disabled={!editable} value={c.percentBase ?? 'production'} onChange={(e) => set(i, 'percentBase', e.target.value)}>{Object.entries(PERCENT_BASES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}
                {(c.basis === 'per_batch_qty' || c.basis === 'per_output_qty') && <span className="small muted">× {c.basis === 'per_batch_qty' ? 'batch size' : 'sellable output'} ({outputUnit})</span>}
                {c.category === 'overhead' && <label className="check small"><input type="checkbox" disabled={!editable} checked={!!c.includesUtilities} onChange={(e) => set(i, 'includesUtilities', e.target.checked)} /> includes utilities</label>}
              </td>
              <td className="num nowrap" title={line?.formula}>{line?.amount ? sek(line.amount) : <span className="muted small">{line?.message ?? '—'}</span>}</td>
              <td>{editable && <button className="icon-btn" onClick={() => upd((d) => ({ ...d, costItems: d.costItems.filter((_, j) => j !== i) }))}>×</button>}</td>
            </tr>);
        })}
          {draft.costItems.length === 0 && <tr><td colSpan={7}><Empty title="No production costs">Without labour, testing or overhead the cost covers ingredients and packaging only.</Empty></td></tr>}
        </tbody>
      </table></div>
      {editable && <div className="card-body row" style={{ paddingTop: 8 }}>
        {[['labour', 'per_hour', 'Production labour'], ['setup_cleaning', 'fixed', 'Setup and cleaning'], ['testing', 'fixed', 'Laboratory test'], ['consumable', 'per_batch_qty', 'Filters and consumables'], ['utilities_equipment', 'per_hour', 'Equipment / utilities'], ['overhead', 'percent', 'Manufacturing overhead']].map(([cat, basis, label]) => (
          <Button key={cat} size="sm" onClick={() => upd((d) => ({ ...d, costItems: [...d.costItems, { category: cat, description: label, basis, rate: '', hours: '', hoursScale: false, stepSize: '', percentBase: 'production', includesUtilities: false, note: '' }] }))}>+ {COST_CATEGORIES[cat as keyof typeof COST_CATEGORIES]}</Button>
        ))}
      </div>}
    </Card>
  );
}

function PackagingEditor({ product, materials, prices, onChanged }: { product: any; materials: any[]; prices: Record<number, MaterialPrice>; onChanged: () => void }) {
  const { can } = useAuth();
  const [editing, setEditing] = useState<any | null>(null);
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const save = async () => {
    const body = { name: editing.name, fillQty: editing.fillQty ?? '', fillUnit: editing.fillUnit, notes: editing.notes ?? null, needsReview: false, components: editing.components.filter((c: any) => c.materialId) };
    const r = await run(() => (editing.id ? api.put(`/api/packaging/${editing.id}`, body) : api.post(`/api/products/${product.id}/packaging`, body)), 'Packaging format saved');
    if (r) { setEditing(null); onChanged(); }
  };
  const perPackage = (f: any) => {
    let total = dec('0')!;
    for (const c of f.components) {
      const pr = c.materialId ? dec(prices[c.materialId]?.unitPriceSek) : null;
      const q = dec(c.qtyPerPackage);
      if (!pr || !q) return null;
      total = total.plus(pr.times(q));
    }
    return total;
  };
  return (
    <Card title="Packaging formats" actions={can('recipes.write') && !editing && <Button size="sm" kind="primary" onClick={() => setEditing({ name: '', fillQty: '', fillUnit: product.outputUnit, notes: '', components: [{ materialId: null, qtyPerPackage: '1' }] })}>Add format</Button>}>
      <div className="muted small" style={{ marginBottom: 10 }}>Packaging is costed per format. Component quantities are per package in each component's base unit. Changes here affect current estimates only; saved costings keep the format they used.</div>
      {editing ? (
        <div className="stack">
          <div className="form-grid">
            <Field label="Format name"><input className="input" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="e.g. 1 L in 1.5 L Tritan bottle" /></Field>
            <Field label="Fill quantity per package"><div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}><NumInput value={editing.fillQty} onChange={(x) => setEditing({ ...editing, fillQty: x })} /><select className="input" style={{ width: 70 }} value={editing.fillUnit} onChange={(e) => setEditing({ ...editing, fillUnit: e.target.value })}>{(product.outputUnit === 'L' ? ['L', 'mL'] : ['kg', 'g']).map((u: string) => <option key={u}>{u}</option>)}</select></div></Field>
          </div>
          <table className="table compact sheet"><thead><tr><th>Component</th><th className="num">Qty per package</th><th className="num">Price</th><th></th></tr></thead>
            <tbody>{editing.components.map((c: any, i: number) => (
              <tr key={i}><td><MaterialPicker value={c.materialId} options={materials} onChange={(id) => setEditing({ ...editing, components: editing.components.map((x: any, j: number) => j === i ? { ...x, materialId: id } : x) })} /></td>
                <td style={{ width: 130 }}><NumInput className="input-sm" value={c.qtyPerPackage ?? ''} onChange={(x) => setEditing({ ...editing, components: editing.components.map((y: any, j: number) => j === i ? { ...y, qtyPerPackage: x } : y) })} /></td>
                <td className="num small">{c.materialId && prices[c.materialId] ? (prices[c.materialId].unitPriceSek ? `${num(prices[c.materialId].unitPriceSek, 3)}/${prices[c.materialId].baseUnit}` : <Badge tone="warn">No price</Badge>) : ''}</td>
                <td><button className="icon-btn" onClick={() => setEditing({ ...editing, components: editing.components.filter((_: any, j: number) => j !== i) })}>×</button></td></tr>))}</tbody></table>
          <div className="row"><Button size="sm" onClick={() => setEditing({ ...editing, components: [...editing.components, { materialId: null, qtyPerPackage: '1' }] })}>Add component</Button><span className="spacer" />
            <span className="small">Packaging per package: <strong>{perPackage(editing) ? sek(perPackage(editing)) : '—'}</strong></span></div>
          <div className="row"><Button kind="primary" disabled={busy || !editing.name} onClick={save}>Save format</Button><Button onClick={() => setEditing(null)}>Cancel</Button></div>
        </div>
      ) : product.packagingFormats.length === 0 ? <Empty title="No packaging formats">The product is costed in bulk until a format is added.</Empty> : (
        <table className="table compact"><thead><tr><th>Format</th><th className="num">Fill</th><th>Components</th><th className="num">Per package</th><th></th></tr></thead>
          <tbody>{product.packagingFormats.map((f: any) => (
            <tr key={f.id} style={f.archived ? { opacity: 0.5 } : undefined}>
              <td>{f.name} {f.needsReview && <StatusBadge status="needs_review" />}{f.archived && <Badge>Archived</Badge>}</td>
              <td className="num">{f.fillQty ? `${num(f.fillQty)} ${f.fillUnit}` : <Badge tone="warn">not set</Badge>}</td>
              <td className="small">{f.components.map((c: any) => `${c.qtyPerPackage ?? '?'} × ${c.materialName}`).join(', ')}</td>
              <td className="num">{perPackage(f) ? sek(perPackage(f)) : <Badge tone="warn">Incomplete</Badge>}</td>
              <td className="nowrap">{can('recipes.write') && <><Button size="sm" onClick={() => setEditing({ ...f, components: f.components.map((c: any) => ({ ...c })) })}>Edit</Button>{' '}
                <Button size="sm" kind="ghost" onClick={async () => { if ((f.archived || await confirm({ title: `Archive ${f.name}?`, danger: true, confirmText: 'Archive' })) && await run(() => api.post(`/api/packaging/${f.id}/archive`, { archived: !f.archived }), 'Saved')) onChanged(); }}>{f.archived ? 'Restore' : 'Archive'}</Button></>}</td>
            </tr>))}</tbody></table>
      )}
    </Card>
  );
}

function QualitySpecs({ product, onChanged }: { product: any; onChanged: () => void }) {
  const { can } = useAuth();
  const [f, setF] = useState<any>({ parameter: '', unit: '', minValue: '', maxValue: '', targetText: '', method: '' });
  const { run, busy } = useAction();
  return (
    <Card title="Quality specifications">
      <Alert tone="info">Specifications are configured by your quality team. The system does not supply acceptance limits and does not by itself establish food-safety compliance.</Alert>
      {product.qualitySpecs.length === 0 ? <Empty title="No specifications configured" /> : (
        <table className="table compact" style={{ marginTop: 10 }}><thead><tr><th>Parameter</th><th className="num">Min</th><th className="num">Max</th><th>Target / text</th><th>Method</th><th></th></tr></thead>
          <tbody>{product.qualitySpecs.map((s: any) => <tr key={s.id} style={s.active ? undefined : { opacity: 0.5 }}><td>{s.parameter} {s.unit && <span className="muted">({s.unit})</span>}</td><td className="num">{s.min_value ?? '—'}</td><td className="num">{s.max_value ?? '—'}</td><td>{s.target_text ?? '—'}</td><td>{s.method ?? '—'}</td>
            <td>{can('quality.write') && <Button size="sm" kind="ghost" onClick={async () => { if (await run(() => api.put(`/api/quality-specs/${s.id}`, { parameter: s.parameter, unit: s.unit, minValue: s.min_value ?? '', maxValue: s.max_value ?? '', targetText: s.target_text, method: s.method, active: !s.active }), 'Saved')) onChanged(); }}>{s.active ? 'Deactivate' : 'Activate'}</Button>}</td></tr>)}</tbody></table>
      )}
      {can('quality.write') && (
        <div className="form-grid" style={{ marginTop: 14, alignItems: 'end' }}>
          <Field label="Parameter"><input className="input" value={f.parameter} onChange={(e) => setF({ ...f, parameter: e.target.value })} placeholder="e.g. pH" /></Field>
          <Field label="Unit"><input className="input" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} /></Field>
          <Field label="Min (optional)"><NumInput value={f.minValue} onChange={(x) => setF({ ...f, minValue: x })} /></Field>
          <Field label="Max (optional)"><NumInput value={f.maxValue} onChange={(x) => setF({ ...f, maxValue: x })} /></Field>
          <Field label="Target / text spec"><input className="input" value={f.targetText} onChange={(e) => setF({ ...f, targetText: e.target.value })} /></Field>
          <Field label="Method"><input className="input" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })} /></Field>
          <Button kind="primary" disabled={busy || !f.parameter} onClick={async () => { if (await run(() => api.post(`/api/products/${product.id}/quality-specs`, f), 'Specification added')) { setF({ parameter: '', unit: '', minValue: '', maxValue: '', targetText: '', method: '' }); onChanged(); } }}>Add specification</Button>
        </div>
      )}
    </Card>
  );
}

function ImportOriginal({ o }: { o: any }) {
  return (
    <Card title="Original imported data (unchanged)">
      <div className="stack">
        <div className="grid-2">
          <table className="table compact"><tbody>{Object.entries(o.header ?? {}).map(([k, v]) => <tr key={k}><td className="muted">{k}</td><td>{String(v)}</td></tr>)}</tbody></table>
          <table className="table compact"><tbody>{Object.entries(o.summary ?? {}).map(([k, v]: any) => <tr key={k}><td className="muted">{k}</td><td>{(v as string[]).join(' · ')}</td></tr>)}</tbody></table>
        </div>
        <table className="table compact"><thead><tr><th>Ingredient</th><th className="num">Qty</th><th className="num">Price</th><th className="num">Cost</th><th className="num">Ratio to qty × price</th></tr></thead>
          <tbody>{(o.ingredients ?? []).map((i: any, k: number) => <tr key={k}><td>{i.name}</td><td className="num">{i.quantity} {i.unit}</td><td className="num">{i.unitPrice}/{i.per}</td><td className="num">{i.cost}</td><td className="num">{o.lineChecks?.[k]?.ratio ? `×${o.lineChecks[k].ratio}` : '—'}</td></tr>)}</tbody></table>
        {o.packaging?.length > 0 && <table className="table compact"><thead><tr><th>Packaging</th><th className="num">Per unit</th><th className="num">Price</th><th className="num">Cost</th></tr></thead><tbody>{o.packaging.map((i: any, k: number) => <tr key={k}><td>{i.name}</td><td className="num">{i.perUnit}</td><td className="num">{i.unitPrice}/{i.per}</td><td className="num">{i.cost}</td></tr>)}</tbody></table>}
        {o.labour?.length > 0 && <table className="table compact"><thead><tr><th>Labour</th><th className="num">Rate</th><th className="num">Hours</th><th className="num">Cost</th></tr></thead><tbody>{o.labour.map((i: any, k: number) => <tr key={k}><td>{i.name}</td><td className="num">{i.rate}</td><td className="num">{i.hours}</td><td className="num">{i.cost}</td></tr>)}</tbody></table>}
        <details><summary>Import decisions</summary><pre className="raw">{JSON.stringify(o.decisions, null, 2)}</pre></details>
      </div>
    </Card>
  );
}
