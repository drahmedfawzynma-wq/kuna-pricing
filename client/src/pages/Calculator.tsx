import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Alert, Badge, Button, Card, Empty, Field, Loading, Modal, NumInput, PageHeader, useAction, useLoad } from '../ui';
import { CostBreakdown, CostSummary, SectionChart } from '../components';
import { dateTime, num, sek } from '../format';
import type { CostingResult } from '../../../shared/engine';

export default function Calculator() {
  const [sp] = useSearchParams();
  const costingId = sp.get('costingId');
  if (costingId) return <SavedCosting id={Number(costingId)} />;
  return <LiveCalculator />;
}

function LiveCalculator() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const products = useLoad<any[]>('/api/products');
  const [productId, setProductId] = useState<number | null>(null);
  const product = useLoad<any>(productId ? `/api/products/${productId}` : null);
  const [versionId, setVersionId] = useState<number | null>(Number(sp.get('versionId')) || null);
  const [batchQty, setBatchQty] = useState('');
  const [yieldOverride, setYieldOverride] = useState('');
  const [formatId, setFormatId] = useState<number | ''>('');
  const [actualOutput, setActualOutput] = useState('');
  const [result, setResult] = useState<CostingResult | null>(null);
  const [actual, setActual] = useState<CostingResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { run, busy } = useAction();

  // Resolve product from a version link.
  useEffect(() => {
    if (!versionId || productId) return;
    api.get(`/api/recipe-versions/${versionId}`).then((v) => setProductId(v.productId)).catch(() => {});
  }, [versionId, productId]);
  useEffect(() => {
    if (product.data && !product.data.versions.some((v: any) => v.id === versionId)) setVersionId(product.data.currentVersionId);
  }, [product.data, versionId]);
  const version = product.data?.versions.find((v: any) => v.id === versionId);
  const versionDetail = useLoad<any>(versionId ? `/api/recipe-versions/${versionId}` : null);
  useEffect(() => { if (versionDetail.data) { setBatchQty(versionDetail.data.defaultBatchQty ?? versionDetail.data.referenceBatchQty ?? ''); setYieldOverride(''); } }, [versionDetail.data]);

  const req = useMemo(() => versionId ? { recipeVersionId: versionId, batchQty: batchQty || null, yieldPctOverride: yieldOverride || null, packagingFormatId: formatId || null } : null, [versionId, batchQty, yieldOverride, formatId]);
  useEffect(() => {
    if (!req) return;
    const t = setTimeout(async () => {
      try {
        setResult(await api.post('/api/costings/calculate', req));
        setActual(actualOutput ? await api.post('/api/costings/calculate', { ...req, actualOutputQty: actualOutput, actualPackagedUnits: null }) : null);
        setErr(null);
      } catch (e: any) { setErr(e.message); }
    }, 250);
    return () => clearTimeout(t);
  }, [req, actualOutput]);

  if (!products.data) return <Loading error={products.error} />;
  const p = product.data;
  const u = p?.outputUnit ?? 'L';

  return (
    <div>
      <PageHeader title="Batch calculator" subtitle="Select a recipe, production scale, yield and packaging. Figures recalculate as you type and are estimates from current material prices until saved as a snapshot."
        actions={result && <>
          <Button onClick={() => setSaving(true)} disabled={!result}>Save costing</Button>
          {can('batches.write') && <Button onClick={async () => { const r = await run(() => api.post('/api/batches', { productId, recipeVersionId: versionId, packagingFormatId: formatId || null, plannedQty: batchQty, plannedYieldPct: yieldOverride || null }), 'Production batch planned'); if (r) nav(`/batches/${r.id}`); }} disabled={busy}>Plan production batch</Button>}
          {can('pricing.write') && <Button kind="primary" onClick={() => nav(`/pricing?versionId=${versionId}&batchQty=${batchQty}${formatId ? `&formatId=${formatId}` : ''}`)}>Price this</Button>}
        </>} />
      <Card>
        <div className="form-grid">
          <Field label="Product"><select className="input" value={productId ?? ''} onChange={(e) => { setProductId(Number(e.target.value) || null); setVersionId(null); setFormatId(''); setSp({}); }}>
            <option value="">Select…</option>{products.data.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
          <Field label="Recipe version"><select className="input" value={versionId ?? ''} disabled={!p} onChange={(e) => setVersionId(Number(e.target.value))}>
            {p?.versions.map((v: any) => <option key={v.id} value={v.id}>v{v.versionNo} · {v.status}{v.reviewStatus === 'needs_review' ? ' · needs review' : ''}</option>)}</select></Field>
          <Field label={`Production scale (${u})`} hint={versionDetail.data ? `Recipe reference batch: ${num(versionDetail.data.referenceBatchQty)} ${u}` : undefined}><NumInput value={batchQty} onChange={setBatchQty} disabled={!versionId} /></Field>
          <Field label="Yield (%)" hint={versionDetail.data ? `Recipe: ${versionDetail.data.yieldMode === 'stages' ? 'loss stages' : `${num(versionDetail.data.yieldPct)} %`}. Leave blank to use it.` : undefined}><NumInput value={yieldOverride} onChange={setYieldOverride} placeholder="recipe" disabled={!versionId} /></Field>
          <Field label="Packaging format"><select className="input" value={formatId} disabled={!p} onChange={(e) => setFormatId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">Bulk (per {u}, no packaging)</option>{p?.packagingFormats.filter((f: any) => !f.archived).map((f: any) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></Field>
          <Field label={`Actual accepted output (${u})`} hint="Optional: compare with the estimate."><NumInput value={actualOutput} onChange={setActualOutput} placeholder="—" disabled={!versionId} /></Field>
        </div>
      </Card>
      {err && <Alert tone="error">{err}</Alert>}
      {!versionId ? <Card className="" ><Empty title="Choose a product to start">Or open a recipe and click “Open in calculator”.</Empty></Card> : !result ? <Loading /> : (
        <div className="stack" style={{ marginTop: 16 }}>
          {version?.status === 'draft' && <Alert tone="info">Calculating a draft version. Approve the recipe before quoting it.</Alert>}
          <div className="grid-main-side">
            <Card title="Itemised batch cost" pad={false}><CostBreakdown result={result} /></Card>
            <div className="stack">
              <Card><CostSummary result={result} /></Card>
              {actual && (
                <Card title="Estimated vs. actual">
                  <table className="table compact"><thead><tr><th></th><th className="num"><span className="tag-est">Estimated</span></th><th className="num"><span className="tag-act">Actual</span></th></tr></thead>
                    <tbody>
                      <tr><td>Sellable output</td><td className="num">{num(result.sellableQty)} {u}</td><td className="num">{num(actual.sellableQty)} {u}</td></tr>
                      <tr><td>Yield</td><td className="num">{num(result.yieldPct, 2)} %</td><td className="num">{num(actual.yieldPct, 2)} %</td></tr>
                      <tr><td>Total batch cost</td><td className="num">{sek(result.totalBatchCost)}</td><td className="num">{sek(actual.totalBatchCost)}</td></tr>
                      <tr><td>Cost per {u}</td><td className="num">{sek(result.costPerOutputUnit)}</td><td className="num"><strong>{sek(actual.costPerOutputUnit)}</strong></td></tr>
                      {result.costPerPackage && <tr><td>Cost per package</td><td className="num">{sek(result.costPerPackage)}</td><td className="num">{sek(actual.costPerPackage)}</td></tr>}
                    </tbody></table>
                  <div className="muted small" style={{ marginTop: 6 }}>Actual uses the same prices with the actual accepted output as denominator. Record real batches under Production batches to lock actual costs.</div>
                </Card>
              )}
              <Card title="Cost structure"><SectionChart result={result} /></Card>
            </div>
          </div>
        </div>
      )}
      {saving && result && req && <SaveCostingModal req={req} onClose={() => setSaving(false)} onSaved={(id) => { setSaving(false); nav(`/calculator?costingId=${id}`); }} />}
    </div>
  );
}

function SaveCostingModal({ req, onClose, onSaved }: { req: any; onClose: () => void; onSaved: (id: number) => void }) {
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const { run, busy } = useAction();
  return (
    <Modal title="Save costing snapshot" onClose={onClose} width={480} footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" disabled={busy} onClick={async () => { const r = await run(() => api.post('/api/costings', { ...req, name: name || null, notes: notes || null }), 'Costing saved'); if (r) onSaved(r.id); }}>Save</Button></>}>
      <div className="stack">
        <p className="muted small" style={{ margin: 0 }}>Stores the recipe version, quantities, material prices, exchange rates and allocation assumptions as they are now. Later price changes will not alter it.</p>
        <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. 50 L batch, Oct 2026 prices" autoFocus /></Field>
        <Field label="Notes"><textarea className="input" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

function SavedCosting({ id }: { id: number }) {
  const nav = useNavigate();
  const { data, error } = useLoad<any>(`/api/costings/${id}`);
  if (!data) return <Loading error={error} />;
  const r: CostingResult = data.result;
  return (
    <div>
      <PageHeader title={<>{data.name ?? 'Saved costing'} <Badge tone="accent">Snapshot</Badge></>}
        subtitle={<>{data.productName} v{data.versionNo} · {data.kind.replace('_', ' ')} · saved {dateTime(data.createdAt)}{data.createdByName ? ` by ${data.createdByName}` : ''}. These figures are frozen and do not change when prices change.</>}
        actions={<><Button onClick={() => nav('/calculator')}>New calculation</Button><Button onClick={() => nav(`/calculator?versionId=${data.recipeVersionId}`)}>Recalculate with current prices</Button></>} />
      {data.notes && <Alert tone="info">{data.notes}</Alert>}
      <div className="grid-main-side" style={{ marginTop: 12 }}>
        <Card title="Itemised batch cost (as saved)" pad={false}><CostBreakdown result={r} /></Card>
        <div className="stack">
          <Card><CostSummary result={r} title="Saved estimate" /></Card>
          <Card title="Material prices used">
            <table className="table compact"><tbody>{Object.values(data.inputs.materials as Record<string, any>).map((m: any) => <tr key={m.id}><td>{m.name}</td><td className="num">{m.unitPriceSek ? `${num(m.unitPriceSek, 4)} SEK/${m.baseUnit}` : <Badge tone="warn">none</Badge>}</td><td className="small muted">{m.priceDate ?? ''}</td></tr>)}</tbody></table>
          </Card>
          <Card><Link to={`/recipes/${data.productId}?v=${data.recipeVersionId}`}>Open recipe version v{data.versionNo}</Link></Card>
        </div>
      </div>
    </div>
  );
}
