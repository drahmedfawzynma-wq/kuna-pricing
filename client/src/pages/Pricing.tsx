import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Alert, Badge, Button, Card, Empty, Field, Loading, NumInput, PageHeader, StatusBadge, Tabs, useAction, useConfirm, useLoad } from '../ui';
import { MaterialPicker } from '../components';
import { date, num, pct, sek, todayIso } from '../format';
import { downstreamPrice, grossProfit, marginPct, markupPct, priceForMargin, priceForMarkup, withVat } from '../../../shared/pricing';
import { dec } from '../../../shared/decimal';
import type { CostingResult } from '../../../shared/engine';

export default function Pricing() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') ?? (can('pricing.read') ? 'calculate' : 'list');
  return (
    <div>
      <PageHeader title="Pricing & scenarios" subtitle="Three separate levels: Kuna production cost, Kuna selling price to the customer, and an optional suggested downstream retail price. Results are gross margin and estimated gross profit, not company net profit. Prices exclude VAT unless stated." />
      <Tabs value={tab} onChange={(t) => { const n = new URLSearchParams(sp); n.set('tab', t); setSp(n); }} tabs={[
        ...(can('pricing.read') ? [{ id: 'calculate', label: 'Price calculator' }] : []),
        { id: 'list', label: 'Price list' },
        ...(can('pricing.read') ? [{ id: 'scenarios', label: 'Scenarios' }] : []),
      ]} />
      {tab === 'calculate' && can('pricing.read') && <PriceCalculator />}
      {tab === 'list' && <PriceList />}
      {tab === 'scenarios' && can('pricing.read') && <Scenarios />}
    </div>
  );
}

function useProductSelection(initialVersionId?: number | null) {
  const products = useLoad<any[]>('/api/products');
  const [productId, setProductId] = useState<number | null>(null);
  const product = useLoad<any>(productId ? `/api/products/${productId}` : null);
  const [versionId, setVersionId] = useState<number | null>(initialVersionId ?? null);
  useEffect(() => {
    if (initialVersionId && !productId) api.get(`/api/recipe-versions/${initialVersionId}`).then((v) => setProductId(v.productId)).catch(() => {});
  }, [initialVersionId, productId]);
  useEffect(() => { if (product.data && !product.data.versions.some((v: any) => v.id === versionId)) setVersionId(product.data.currentVersionId); }, [product.data, versionId]);
  return { products, productId, setProductId, product, versionId, setVersionId };
}

function PriceCalculator() {
  const { can } = useAuth();
  const [sp] = useSearchParams();
  const sel = useProductSelection(Number(sp.get('versionId')) || null);
  const customers = useLoad<any[]>('/api/customers');
  const settings = useLoad<any>('/api/settings');
  const [batchQty, setBatchQty] = useState(sp.get('batchQty') ?? '');
  const [formatId, setFormatId] = useState<number | ''>(sp.get('formatId') ? Number(sp.get('formatId')) : '');
  const [method, setMethod] = useState<'margin' | 'markup' | 'manual'>('margin');
  const [methodValue, setMethodValue] = useState('');
  const [manualPrice, setManualPrice] = useState('');
  const [customerId, setCustomerId] = useState<number | ''>('');
  const [minQty, setMinQty] = useState('1');
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso());
  const [notes, setNotes] = useState('');
  const [sellingCharges, setSellingCharges] = useState('');
  const [showVat, setShowVat] = useState(false);
  const [vatPct, setVatPct] = useState('');
  const [ds, setDs] = useState({ enabled: false, acq: '', other: '', margin: '', vat: '' });
  const [result, setResult] = useState<CostingResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { run, busy } = useAction();
  const p = sel.product.data;

  useEffect(() => { if (p?.targetMarginPct && !methodValue) setMethodValue(p.targetMarginPct); }, [p]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (settings.data && !vatPct) { setVatPct(settings.data.settings.default_vat_pct); setShowVat(settings.data.settings.show_vat_inclusive === '1'); } }, [settings.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!sel.versionId) return;
    const t = setTimeout(() => api.post('/api/costings/calculate', { recipeVersionId: sel.versionId, batchQty: batchQty || null, packagingFormatId: formatId || null })
      .then((r) => { setResult(r); setErr(null); if (!batchQty) setBatchQty(r.batchQty ?? ''); }).catch((e) => setErr(e.message)), 250);
    return () => clearTimeout(t);
  }, [sel.versionId, batchQty, formatId]);

  const per = formatId ? 'package' : `${p?.outputUnit ?? 'L'}`;
  const unitCost = result ? (formatId ? result.costPerPackage : result.costPerOutputUnit) : null;
  const priceRes = !unitCost ? null : method === 'margin' ? priceForMargin(unitCost, methodValue) : method === 'markup' ? priceForMarkup(unitCost, methodValue) : manualPrice ? { ok: true as const, value: dec(manualPrice)?.toDecimalPlaces(2).toFixed(2) ?? '' } : null;
  const price = priceRes?.ok ? priceRes.value : null;
  const m = price && unitCost ? marginPct(price, unitCost) : null;
  const mk = price && unitCost ? markupPct(price, unitCost) : null;
  const gp = price && unitCost ? grossProfit(price, unitCost) : null;
  const units = result ? (formatId ? result.packagedUnits : result.sellableQty) : null;
  const contribution = gp && sellingCharges ? dec(gp)!.minus(dec(sellingCharges) ?? 0) : null;
  const dsAcq = ds.acq || price || '';
  const dsVat = ds.vat || settings.data?.settings.food_vat_pct || '';
  const down = ds.enabled ? downstreamPrice({ acquisitionCost: dsAcq, otherCostsPerUnit: ds.other, marginPct: ds.margin, vatPct: dsVat }) : null;
  const target = p?.targetMarginPct;

  if (!sel.products.data) return <Loading error={sel.products.error} />;
  return (
    <div className="grid-main-side">
      <div className="stack">
        <Card title="1 · Kuna production cost">
          <div className="form-grid">
            <Field label="Product"><select className="input" value={sel.productId ?? ''} onChange={(e) => { sel.setProductId(Number(e.target.value) || null); sel.setVersionId(null); setFormatId(''); setBatchQty(''); setMethodValue(''); }}>
              <option value="">Select…</option>{sel.products.data.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
            <Field label="Recipe version"><select className="input" value={sel.versionId ?? ''} disabled={!p} onChange={(e) => { sel.setVersionId(Number(e.target.value)); setBatchQty(''); }}>{p?.versions.map((v: any) => <option key={v.id} value={v.id}>v{v.versionNo} · {v.status}</option>)}</select></Field>
            <Field label={`Production scale (${p?.outputUnit ?? 'L'})`}><NumInput value={batchQty} onChange={setBatchQty} disabled={!p} /></Field>
            <Field label="Sell as"><select className="input" value={formatId} disabled={!p} onChange={(e) => setFormatId(e.target.value ? Number(e.target.value) : '')}><option value="">Bulk, per {p?.outputUnit ?? 'L'}</option>{p?.packagingFormats.filter((f: any) => !f.archived).map((f: any) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></Field>
          </div>
          {err && <Alert tone="error">{err}</Alert>}
          {result && <div style={{ marginTop: 12 }} className="row">
            <div><div className="muted small">Unit cost per {per}</div><div className="big-number tag-est">{sek(unitCost)}</div></div>
            <div className="muted small">Batch {num(result.batchQty)} {result.outputUnit} · {num(units, 2)} sellable {formatId ? 'packages' : result.outputUnit} · total {sek(result.totalBatchCost)}</div>
            {!result.complete && <Alert tone="warn">Incomplete costing: {result.warnings.filter((w) => w.level !== 'info').slice(0, 3).map((w) => w.message).join(' ')} Prices cannot be approved until it is complete.</Alert>}
          </div>}
        </Card>

        <Card title="2 · Kuna selling price to the customer">
          <div className="row" style={{ marginBottom: 10 }}>
            {(['margin', 'markup', 'manual'] as const).map((k) => <label key={k} className="check"><input type="radio" checked={method === k} onChange={() => setMethod(k)} /> {k === 'margin' ? 'Target gross margin' : k === 'markup' ? 'Markup on cost' : 'Enter price manually'}</label>)}
          </div>
          <div className="form-grid">
            {method !== 'manual' ? <Field label={method === 'margin' ? 'Gross margin (%)' : 'Markup (%)'} hint={method === 'margin' ? 'Price = unit cost ÷ (1 − margin)' : 'Price = unit cost × (1 + markup)'} error={priceRes && !priceRes.ok ? priceRes.error : null}><NumInput value={methodValue} onChange={setMethodValue} /></Field>
              : <Field label={`Selling price per ${per} (SEK, excl. VAT)`}><NumInput value={manualPrice} onChange={setManualPrice} /></Field>}
            <Field label="Customer" hint="Blank = general price list"><select className="input" value={customerId} onChange={(e) => setCustomerId(e.target.value ? Number(e.target.value) : '')}><option value="">All customers</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
            <Field label="Volume tier: from quantity" hint={`Minimum ${per === 'package' ? 'packages' : per} per order`}><NumInput value={minQty} onChange={setMinQty} /></Field>
            <Field label="Effective from"><input type="date" className="input" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} /></Field>
            <Field label="Selling charges per unit (SEK)" hint="Delivery, commission… kept separate from gross margin."><NumInput value={sellingCharges} onChange={setSellingCharges} placeholder="optional" /></Field>
            <Field label="Notes"><input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
          </div>
          <label className="check" style={{ marginTop: 10 }}><input type="checkbox" checked={showVat} onChange={(e) => setShowVat(e.target.checked)} /> Also show VAT-inclusive at <NumInput value={vatPct} onChange={setVatPct} style={{ width: 70, height: 26 }} /> %</label>
        </Card>

        <Card title="3 · Optional suggested downstream retail price" actions={<label className="check"><input type="checkbox" checked={ds.enabled} onChange={(e) => setDs({ ...ds, enabled: e.target.checked })} /> Calculate</label>}>
          {!ds.enabled ? <span className="muted small">Not part of Kuna's price. Enable to estimate a retail price from explicit downstream assumptions (Kuna's price is not the customer's total cost).</span> : (
            <div className="stack">
              <div className="form-grid">
                <Field label="Downstream acquisition cost / unit" hint="Defaults to Kuna's selling price"><NumInput value={ds.acq} onChange={(v) => setDs({ ...ds, acq: v })} placeholder={price ?? ''} /></Field>
                <Field label="Downstream other costs / unit (required)" hint="Their filling, logistics, marketing… enter 0 explicitly if none"><NumInput value={ds.other} onChange={(v) => setDs({ ...ds, other: v })} /></Field>
                <Field label="Downstream gross margin (%)"><NumInput value={ds.margin} onChange={(v) => setDs({ ...ds, margin: v })} /></Field>
                <Field label="Retail VAT (%)" hint="e.g. food rate where applicable"><NumInput value={ds.vat} onChange={(v) => setDs({ ...ds, vat: v })} placeholder={settings.data?.settings.food_vat_pct} /></Field>
              </div>
              {down && (down.ok ? <Alert tone="info">Suggested retail: <strong>{sek(down.exVat)}</strong> excl. VAT · <strong>{sek(down.incVat)}</strong> incl. {dsVat} % VAT (cost basis {sek(down.costBasis)}). An assumption only; not saved.</Alert> : <Alert tone="warn">{down.error}</Alert>)}
            </div>
          )}
        </Card>
      </div>

      <div className="stack" style={{ position: 'sticky', top: 16 }}>
        <Card title="Result">
          {!result ? <span className="muted">Select a product.</span> : (
            <div className="stack" style={{ gap: 12 }}>
              <div className="levels" style={{ gridTemplateColumns: '1fr 1fr' }}>
                <div className="level"><div className="level-title">Production cost / {per}</div><div className="level-value tag-est">{sek(unitCost)}</div></div>
                <div className="level"><div className="level-title">Selling price / {per} <Badge tone="info">proposal</Badge></div><div className="level-value">{sek(price)}</div>{showVat && price && <div className="small muted">{sek(withVat(price, vatPct))} incl. {vatPct} % VAT</div>}</div>
              </div>
              <div className="summary-list">
                <span className="lbl">Gross margin</span><span className="val"><strong className={target && m?.ok && dec(m.value)!.lt(target) ? 'w-error' : ''}>{m?.ok ? pct(m.value, 2) : '—'}</strong></span>
                <span className="lbl">Markup</span><span className="val">{mk?.ok ? pct(mk.value, 2) : '—'}</span>
                <span className="lbl">Estimated gross profit / {per}</span><span className="val">{sek(gp)}</span>
                <span className="lbl">Estimated gross profit / batch ({num(units, 2)} {formatId ? 'pkg' : p?.outputUnit})</span><span className="val">{gp && units ? sek(dec(gp)!.times(units)) : '—'}</span>
                {contribution && <><span className="lbl">Contribution after selling charges / {per}</span><span className="val">{sek(contribution)}</span></>}
                {target && <><span className="lbl">Target margin</span><span className="val">{pct(target)}</span></>}
              </div>
              {target && m?.ok && dec(m.value)!.lt(target) && <Alert tone="warn">Below the {pct(target)} target margin.</Alert>}
              {can('pricing.write') && (
                <Button kind="primary" disabled={busy || !price || !sel.versionId} onClick={() => run(() => api.post('/api/prices', {
                  recipeVersionId: sel.versionId, batchQty, packagingFormatId: formatId || null, priceUnit: formatId ? 'package' : 'output_unit',
                  method, methodValue: method === 'manual' ? null : methodValue, price: method === 'manual' ? manualPrice : null, customerId: customerId || null, minQty, effectiveFrom, notes: notes || null,
                }), 'Price proposed. Approve it in the price list.')}>Propose this price</Button>
              )}
              <div className="muted small">A proposal stores a costing snapshot. It only becomes the selling price when approved.</div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function PriceList() {
  const { can } = useAuth();
  const confirm = useConfirm();
  const { data, error, reload } = useLoad<any[]>('/api/prices');
  const [status, setStatus] = useState(can('pricing.read') ? 'active' : 'approved');
  const { run, busy } = useAction();
  if (!data) return <Loading error={error} />;
  const rows = data.filter((r) => status === 'all' || (status === 'active' ? ['approved', 'proposed'].includes(r.status) : r.status === status));
  return (
    <Card pad={false} title="Selling prices" actions={can('pricing.read') && <select className="input input-sm" style={{ width: 'auto' }} value={status} onChange={(e) => setStatus(e.target.value)}><option value="active">Approved and proposed</option><option value="proposed">Proposed</option><option value="approved">Approved</option><option value="all">All, including history</option></select>}>
      {rows.length === 0 ? <Empty title="No prices">{can('pricing.write') ? 'Use the price calculator to propose a price.' : 'An administrator has not approved any prices yet.'}</Empty> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Product</th><th>Customer</th><th>Unit</th><th className="num">From qty</th><th className="num">Price excl. VAT</th>{can('pricing.read') && <><th>Method</th><th className="num">Unit cost at proposal</th><th className="num">Margin</th></>}<th>Effective</th><th>Status</th><th></th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id}>
              <td>{r.productName}</td><td>{r.customerName ?? <span className="muted">All customers</span>}</td>
              <td className="small">{r.priceUnit === 'package' ? r.packagingName : 'per L/kg (bulk)'}</td><td className="num">{num(r.minQty)}</td>
              <td className="num"><strong>{sek(r.price)}</strong></td>
              {can('pricing.read') && <><td className="small">{r.method}{r.methodValue ? ` ${r.methodValue} %` : ''}</td><td className="num">{sek(r.unitCostAtApproval)}</td><td className="num">{pct(r.marginAtApproval)}</td></>}
              <td className="small nowrap">{date(r.effectiveFrom)}{r.effectiveTo ? ` → ${date(r.effectiveTo)}` : ''}</td>
              <td><StatusBadge status={r.status} />{r.approvedByName && <div className="muted small">{r.approvedByName}</div>}</td>
              <td className="nowrap">{can('pricing.approve') && r.status === 'proposed' && <>
                <Button size="sm" kind="primary" disabled={busy} onClick={async () => { if (await confirm({ title: `Approve ${sek(r.price)} for ${r.productName}?`, body: 'Any approved price with the same product, customer, packaging and tier will be superseded (kept in history).', confirmText: 'Approve' }) && await run(() => api.post(`/api/prices/${r.id}/approve`), 'Price approved')) reload(); }}>Approve</Button>{' '}
                <Button size="sm" kind="ghost" disabled={busy} onClick={async () => { if (await run(() => api.post(`/api/prices/${r.id}/reject`), 'Rejected')) reload(); }}>Reject</Button></>}
                {can('costs.read') && r.costingId && <a className="small" href={`/calculator?costingId=${r.costingId}`}>costing</a>}</td>
            </tr>))}</tbody>
        </table></div>
      )}
    </Card>
  );
}

type Variant = { label: string; batchQty: string; yieldPctOverride: string; packagingFormatId: number | null; priceOverrides: Record<string, string>; method: 'margin' | 'markup' | 'manual'; methodValue: string };

function Scenarios() {
  const saved = useLoad<any[]>('/api/scenarios');
  const [sp] = useSearchParams();
  const sel = useProductSelection(Number(sp.get('versionId')) || null);
  const mats = useLoad<any[]>('/api/materials');
  const [scenarioId, setScenarioId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [variants, setVariants] = useState<Variant[]>([]);
  const [results, setResults] = useState<(CostingResult | string | null)[]>([]);
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const p = sel.product.data;

  useEffect(() => {
    if (!p || variants.length) return;
    const base: Variant = { label: 'Base', batchQty: '', yieldPctOverride: '', packagingFormatId: null, priceOverrides: {}, method: 'margin', methodValue: p.targetMarginPct ?? '' };
    setVariants([base, { ...base, label: 'Larger batch' }]);
  }, [p]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!sel.versionId || !variants.length) return;
    const t = setTimeout(async () => {
      const out = await Promise.all(variants.map((v) => api.post('/api/costings/calculate', { recipeVersionId: sel.versionId, batchQty: v.batchQty || null, yieldPctOverride: v.yieldPctOverride || null, packagingFormatId: v.packagingFormatId, priceOverrides: v.priceOverrides }).catch((e) => e.message as string)));
      setResults(out);
    }, 300);
    return () => clearTimeout(t);
  }, [sel.versionId, JSON.stringify(variants)]); // eslint-disable-line react-hooks/exhaustive-deps

  const setV = (i: number, patch: Partial<Variant>) => setVariants((vs) => vs.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  const load = (s: any) => { setScenarioId(s.id); setName(s.name); sel.setProductId(s.productId); sel.setVersionId(s.recipeVersionId); setVariants(s.params.variants.map((v: any) => ({ batchQty: '', yieldPctOverride: '', packagingFormatId: null, priceOverrides: {}, method: 'margin', methodValue: '', ...v }))); };
  const save = async () => {
    const body = { name: name || `Scenario ${p?.name}`, recipeVersionId: sel.versionId, params: { variants } };
    const r = await run(() => (scenarioId ? api.put(`/api/scenarios/${scenarioId}`, body) : api.post('/api/scenarios', body)), 'Scenario saved (approved records unchanged)');
    if (r) { if (r.id) setScenarioId(r.id); saved.reload(); }
  };
  const ingredientIds = useMemo(() => new Set<number>(), []);

  return (
    <div className="stack">
      <Alert tone="info">Scenarios are experiments. They never change recipes, material prices or approved selling prices. Use “Propose price” to turn a variant into a proposal (requires current material prices).</Alert>
      <div className="grid-main-side" style={{ gridTemplateColumns: 'minmax(0,1fr) 300px' }}>
        <Card title="Scenario setup">
          <div className="form-grid">
            <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Flavour +20 % and 200 L batches" /></Field>
            <Field label="Product"><select className="input" value={sel.productId ?? ''} onChange={(e) => { sel.setProductId(Number(e.target.value) || null); sel.setVersionId(null); setVariants([]); setScenarioId(null); }}><option value="">Select…</option>{sel.products.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
            <Field label="Recipe version"><select className="input" value={sel.versionId ?? ''} disabled={!p} onChange={(e) => sel.setVersionId(Number(e.target.value))}>{p?.versions.map((v: any) => <option key={v.id} value={v.id}>v{v.versionNo} · {v.status}</option>)}</select></Field>
          </div>
        </Card>
        <Card title="Saved scenarios" pad={false}>
          {!saved.data ? <Loading /> : saved.data.length === 0 ? <Empty title="None saved yet" /> : (
            <table className="table compact"><tbody>{saved.data.map((s) => <tr key={s.id} className="clickable" onClick={() => load(s)}><td><strong>{s.name}</strong><div className="muted small">{s.productName} v{s.versionNo} · {s.params.variants.length} variants</div></td>
              <td><button className="icon-btn" title="Delete" onClick={async (e) => { e.stopPropagation(); if (await confirm({ title: `Delete scenario "${s.name}"?`, danger: true, confirmText: 'Delete' }) && await run(() => api.del(`/api/scenarios/${s.id}`), 'Deleted')) { saved.reload(); if (scenarioId === s.id) setScenarioId(null); } }}>×</button></td></tr>)}</tbody></table>
          )}
        </Card>
      </div>
      {!p || !sel.versionId ? <Card><Empty title="Choose a product to compare alternatives" /></Card> : (
        <Card title="Compare variants" pad={false} actions={<><Button size="sm" disabled={variants.length >= 6} onClick={() => setVariants([...variants, { ...variants[variants.length - 1], label: `Variant ${variants.length + 1}` }])}>Add variant</Button><Button size="sm" kind="primary" disabled={busy} onClick={save}>{scenarioId ? 'Save scenario' : 'Save as new scenario'}</Button></>}>
          <div className="table-wrap"><table className="table compact">
            <thead><tr><th style={{ width: 200 }}></th>{variants.map((v, i) => <th key={i}><div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}><input className="input input-sm" value={v.label} onChange={(e) => setV(i, { label: e.target.value })} />{i > 0 && <button className="icon-btn" onClick={() => setVariants(variants.filter((_, j) => j !== i))}>×</button>}</div></th>)}</tr></thead>
            <tbody>
              <tr><td>Batch size ({p.outputUnit})</td>{variants.map((v, i) => <td key={i}><NumInput className="input-sm" value={v.batchQty} placeholder={typeof results[i] === 'object' ? (results[i] as any)?.batchQty ?? '' : ''} onChange={(x) => setV(i, { batchQty: x })} /></td>)}</tr>
              <tr><td>Yield (%)</td>{variants.map((v, i) => <td key={i}><NumInput className="input-sm" value={v.yieldPctOverride} placeholder="recipe" onChange={(x) => setV(i, { yieldPctOverride: x })} /></td>)}</tr>
              <tr><td>Packaging</td>{variants.map((v, i) => <td key={i}><select className="input input-sm" value={v.packagingFormatId ?? ''} onChange={(e) => setV(i, { packagingFormatId: e.target.value ? Number(e.target.value) : null })}><option value="">Bulk</option>{p.packagingFormats.filter((f: any) => !f.archived).map((f: any) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></td>)}</tr>
              <tr><td>Ingredient price changes<div className="muted small">SEK per base unit</div></td>{variants.map((v, i) => (
                <td key={i} style={{ verticalAlign: 'top' }}>
                  {Object.entries(v.priceOverrides).map(([mid, val]) => { const m = mats.data?.find((x) => x.id === Number(mid)); return (
                    <div key={mid} className="row" style={{ gap: 4, flexWrap: 'nowrap', marginBottom: 3 }}><span className="small" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }} title={m?.name}>{m?.name}</span><NumInput className="input-sm" style={{ width: 90 }} value={val} onChange={(x) => setV(i, { priceOverrides: { ...v.priceOverrides, [mid]: x } })} />
                      <button className="icon-btn" onClick={() => { const n = { ...v.priceOverrides }; delete n[mid]; setV(i, { priceOverrides: n }); }}>×</button></div>); })}
                  {mats.data && <MaterialPicker value={null} placeholder="+ change a price…" options={mats.data} filter={(m) => !ingredientIds.size || ingredientIds.has(m.id)} onChange={(id) => id && setV(i, { priceOverrides: { ...v.priceOverrides, [id]: mats.data!.find((x) => x.id === id)?.currentPrice?.landedUnitPriceSek ?? '' } })} />}
                </td>))}</tr>
              <tr><td>Pricing</td>{variants.map((v, i) => <td key={i}><div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}><select className="input input-sm" style={{ width: 90 }} value={v.method} onChange={(e) => setV(i, { method: e.target.value as any })}><option value="margin">Margin %</option><option value="markup">Markup %</option><option value="manual">Price</option></select><NumInput className="input-sm" value={v.methodValue} onChange={(x) => setV(i, { methodValue: x })} /></div></td>)}</tr>
              {(['sellable', 'total', 'unitCost', 'price', 'margin', 'gp', 'complete'] as const).map((row) => (
                <tr key={row} className={row === 'unitCost' || row === 'price' ? '' : ''}>
                  <td className={row === 'unitCost' || row === 'price' ? '' : 'muted'}>{({ sellable: 'Sellable output', total: 'Total batch cost', unitCost: 'Unit cost', price: 'Selling price (excl. VAT)', margin: 'Gross margin', gp: 'Est. gross profit / batch', complete: 'Costing' } as any)[row]}</td>
                  {variants.map((v, i) => {
                    const r = results[i];
                    if (!r) return <td key={i} className="muted">…</td>;
                    if (typeof r === 'string') return <td key={i} className="w-error small">{r}</td>;
                    const uc = v.packagingFormatId ? r.costPerPackage : r.costPerOutputUnit;
                    const pr = !uc ? null : v.method === 'margin' ? priceForMargin(uc, v.methodValue) : v.method === 'markup' ? priceForMarkup(uc, v.methodValue) : dec(v.methodValue) ? { ok: true as const, value: dec(v.methodValue)!.toFixed(2) } : null;
                    const priceV = pr?.ok ? pr.value : null;
                    const mm = priceV && uc ? marginPct(priceV, uc) : null;
                    const n = v.packagingFormatId ? r.packagedUnits : r.sellableQty;
                    const cell = ({
                      sellable: v.packagingFormatId ? `${num(r.packagedUnits, 0)} packages` : `${num(r.sellableQty)} ${r.outputUnit}`,
                      total: sek(r.totalBatchCost),
                      unitCost: <strong className="tag-est">{sek(uc)}</strong>,
                      price: priceV ? <strong>{sek(priceV)}</strong> : <span className="muted small">{pr && !pr.ok ? pr.error : '—'}</span>,
                      margin: mm?.ok ? pct(mm.value) : '—',
                      gp: priceV && uc && n ? sek(dec(priceV)!.minus(uc).times(n)) : '—',
                      complete: r.complete ? <Badge tone="ok">Complete</Badge> : <Badge tone="warn" title={r.warnings.map((w) => w.message).join('\n')}>Incomplete</Badge>,
                    } as any)[row];
                    return <td key={i} className={row === 'complete' ? '' : 'num'}>{cell}</td>;
                  })}
                </tr>
              ))}
              <tr><td></td>{variants.map((v, i) => {
                const r = results[i];
                const hasOverrides = Object.values(v.priceOverrides).some((x) => x);
                return <td key={i}>{typeof r === 'object' && r && <Button size="sm" disabled={busy || hasOverrides || !r.complete || v.method === 'manual' && !v.methodValue} title={hasOverrides ? 'Scenario ingredient prices cannot back a real price. Update material prices first.' : undefined}
                  onClick={() => run(() => api.post('/api/prices', { recipeVersionId: sel.versionId, batchQty: v.batchQty || null, yieldPctOverride: v.yieldPctOverride || null, packagingFormatId: v.packagingFormatId, priceUnit: v.packagingFormatId ? 'package' : 'output_unit', method: v.method, methodValue: v.method === 'manual' ? null : v.methodValue, price: v.method === 'manual' ? v.methodValue : null, minQty: '1', notes: `From scenario "${name}" / ${v.label}` }), 'Price proposed from scenario')}>Propose price</Button>}</td>;
              })}</tr>
            </tbody>
          </table></div>
        </Card>
      )}
    </div>
  );
}
