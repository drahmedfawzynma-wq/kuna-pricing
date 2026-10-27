import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Alert, Badge, Button, Card, Empty, Field, Loading, Modal, NumInput, PageHeader, StatusBadge, useAction, useConfirm, useLoad } from '../ui';
import { CostBreakdown } from '../components';
import { date, dateTime, num, qty, sek, todayIso } from '../format';
import { dec } from '../../../shared/decimal';

export default function Batches() {
  const { id } = useParams();
  const { can } = useAuth();
  const nav = useNavigate();
  const list = useLoad<any[]>('/api/batches');
  const [creating, setCreating] = useState(false);
  return (
    <div>
      <PageHeader title="Production batches" subtitle="Planned and completed batches with their cost snapshots, actual output and quality decisions. Release requires recorded quality approval."
        actions={can('batches.write') && <Button kind="primary" onClick={() => setCreating(true)}>Plan batch</Button>} />
      {id ? <BatchDetail id={Number(id)} onChanged={list.reload} /> : (
        <Card pad={false}>
          {!list.data ? <Loading error={list.error} /> : list.data.length === 0 ? <Empty title="No batches yet" action={can('batches.write') && <Button kind="primary" onClick={() => setCreating(true)}>Plan batch</Button>}>Plan a batch from a recipe, or from the batch calculator.</Empty> : (
            <table className="table"><thead><tr><th>Batch</th><th>Product</th><th className="num">Planned</th><th className="num">Actual output</th><th>Produced</th><th>Expiry</th>{can('costs.read') && <><th className="num"><span className="tag-est">Est.</span> cost/unit</th><th className="num"><span className="tag-act">Actual</span> cost/unit</th></>}<th>Status</th></tr></thead>
              <tbody>{list.data.map((b) => (
                <tr key={b.id} className="clickable" onClick={() => nav(`/batches/${b.id}`)}>
                  <td><strong>{b.batchNumber}</strong></td><td>{b.productName} <span className="muted small">v{b.versionNo}</span></td>
                  <td className="num">{qty(b.plannedQty, b.outputUnit)}</td><td className="num">{qty(b.actualOutputQty, b.outputUnit)}</td><td>{date(b.productionDate)}</td><td>{date(b.expiryDate)}</td>
                  {can('costs.read') && <><td className="num">{sek(b.estimatedCostPerUnit)}</td><td className="num">{sek(b.actualCostPerUnit)}</td></>}
                  <td><StatusBadge status={b.status} />{b.costsLocked && <Badge>costs locked</Badge>}</td>
                </tr>))}</tbody></table>
          )}
        </Card>
      )}
      {creating && <NewBatch onClose={() => setCreating(false)} onCreated={(bid) => { setCreating(false); list.reload(); nav(`/batches/${bid}`); }} />}
    </div>
  );
}

function NewBatch({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const products = useLoad<any[]>('/api/products');
  const [f, setF] = useState<any>({ productId: '', packagingFormatId: '', plannedQty: '', productionDate: todayIso(), expiryDate: '', batchNumber: '' });
  const { run, busy } = useAction();
  const prod = products.data?.find((p) => p.id === Number(f.productId));
  return (
    <Modal title="Plan production batch" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" disabled={busy || !f.productId || !f.plannedQty} onClick={async () => {
      const r = await run(() => api.post('/api/batches', { productId: Number(f.productId), packagingFormatId: f.packagingFormatId ? Number(f.packagingFormatId) : null, plannedQty: f.plannedQty, productionDate: f.productionDate || null, expiryDate: f.expiryDate || null, batchNumber: f.batchNumber || null }), 'Batch planned; estimate snapshot stored');
      if (r) onCreated(r.id);
    }}>Plan batch</Button></>}>
      <div className="form-grid">
        <Field label="Product"><select className="input" value={f.productId} onChange={(e) => setF({ ...f, productId: e.target.value, packagingFormatId: '' })}><option value="">Select…</option>{products.data?.map((p) => <option key={p.id} value={p.id}>{p.name}{p.currentVersion ? ` (v${p.currentVersion.versionNo} ${p.currentVersion.status})` : ''}</option>)}</select></Field>
        <Field label={`Planned batch size (${prod?.outputUnit ?? 'L'})`}><NumInput value={f.plannedQty} onChange={(v) => setF({ ...f, plannedQty: v })} /></Field>
        <Field label="Packaging"><select className="input" value={f.packagingFormatId} onChange={(e) => setF({ ...f, packagingFormatId: e.target.value })}><option value="">Bulk</option>{prod?.packagingFormats.map((pf: any) => <option key={pf.id} value={pf.id}>{pf.name}</option>)}</select></Field>
        <Field label="Batch number" hint="Blank = generated"><input className="input" value={f.batchNumber} onChange={(e) => setF({ ...f, batchNumber: e.target.value })} /></Field>
        <Field label="Production date"><input type="date" className="input" value={f.productionDate} onChange={(e) => setF({ ...f, productionDate: e.target.value })} /></Field>
        <Field label="Expiry date"><input type="date" className="input" value={f.expiryDate} onChange={(e) => setF({ ...f, expiryDate: e.target.value })} /></Field>
      </div>
      <p className="muted small">Uses the product's current recipe version (approved if one exists). The estimate is saved as a snapshot with today's material prices.</p>
    </Modal>
  );
}

function BatchDetail({ id, onChanged }: { id: number; onChanged: () => void }) {
  const { can } = useAuth();
  const confirm = useConfirm();
  const { data: b, error, setData, reload } = useLoad<any>(`/api/batches/${id}`);
  const [act, setAct] = useState<any>(null);
  const [qc, setQc] = useState<any>({ specId: '', parameter: '', valueText: '', result: '', notes: '', attachmentRef: '' });
  const { run, busy } = useAction();
  useEffect(() => { if (b) setAct({ actualOutputQty: b.actualOutputQty ?? '', actualPackagedUnits: b.actualPackagedUnits ?? '', actualAdjustments: b.actualAdjustments ?? [], productionDate: b.productionDate ?? '', expiryDate: b.expiryDate ?? '' }); }, [b]);
  if (!b || !act) return <Loading error={error} />;
  const done = (r: any) => { if (r) { setData(r); onChanged(); } };
  const est = b.estimate?.result;
  const actual = b.actual?.result;
  const variance = est && actual && est.sellableQty && actual.sellableQty ? (() => {
    const TE = dec(est.totalBatchCost)!, OE = dec(est.sellableQty)!, TA = dec(actual.totalBatchCost)!, OA = dec(actual.sellableQty)!;
    return { diff: TA.div(OA).minus(TE.div(OE)), yieldEffect: TE.div(OA).minus(TE.div(OE)), costEffect: TA.minus(TE).div(OA) };
  })() : null;
  const closed = ['released', 'rejected'].includes(b.status);

  return (
    <div className="stack">
      <Card title={<span className="row" style={{ gap: 8 }}>{b.batchNumber} <StatusBadge status={b.status} />{b.costsLocked && <Badge>costs locked</Badge>}</span>}
        actions={can('batches.write') && !closed && <>
          {b.status === 'planned' && <Button size="sm" onClick={async () => done(await run(() => api.patch(`/api/batches/${id}`, { status: 'in_production' }), 'Status updated'))}>Start production</Button>}
          {b.status !== 'on_hold' && <Button size="sm" onClick={async () => done(await run(() => api.patch(`/api/batches/${id}`, { status: 'on_hold' }), 'Batch on hold'))}>Put on hold</Button>}
          {b.status === 'on_hold' && <Button size="sm" onClick={async () => done(await run(() => api.patch(`/api/batches/${id}`, { status: 'in_production' }), 'Resumed'))}>Resume</Button>}
        </>}>
        <dl className="kv">
          <dt>Product</dt><dd>{b.productName} · recipe v{b.versionNo}</dd><dt>Packaging</dt><dd>{b.packagingName ?? 'Bulk'}</dd>
          <dt>Planned</dt><dd>{qty(b.plannedQty, b.outputUnit)} at {num(b.plannedYieldPct, 2)} % expected yield</dd>
          <dt>Production / expiry</dt><dd>{date(b.productionDate)} / {date(b.expiryDate)}</dd>
          <dt>Quality approval</dt><dd>{b.qcApprovedAt ? `${dateTime(b.qcApprovedAt)} by ${b.qcApprovedByName}` : <span className="muted">not approved</span>}</dd>
          {b.notes && <><dt>Notes</dt><dd style={{ whiteSpace: 'pre-line' }}>{b.notes}</dd></>}
        </dl>
      </Card>

      <div className="grid-2">
        <Card title="Actual production">
          {b.costsLocked ? (
            <dl className="kv"><dt>Accepted output</dt><dd>{qty(b.actualOutputQty, b.outputUnit)}</dd><dt>Packaged units</dt><dd>{num(b.actualPackagedUnits) ?? '—'}</dd>
              <dt>Extra actual costs</dt><dd>{b.actualAdjustments.length ? b.actualAdjustments.map((a: any) => `${a.label}: ${sek(a.amount)}`).join(', ') : 'none'}</dd></dl>
          ) : can('batches.write') ? (
            <div className="stack" style={{ gap: 10 }}>
              <div className="form-grid">
                <Field label={`Actual accepted output (${b.outputUnit})`}><NumInput value={act.actualOutputQty} onChange={(v) => setAct({ ...act, actualOutputQty: v })} /></Field>
                {b.packagingFormatId && <Field label="Packaged units"><NumInput value={act.actualPackagedUnits} onChange={(v) => setAct({ ...act, actualPackagedUnits: v })} /></Field>}
                <Field label="Production date"><input type="date" className="input" value={act.productionDate} onChange={(e) => setAct({ ...act, productionDate: e.target.value })} /></Field>
                <Field label="Expiry date"><input type="date" className="input" value={act.expiryDate} onChange={(e) => setAct({ ...act, expiryDate: e.target.value })} /></Field>
              </div>
              <div><div className="field-label">Additional actual costs (SEK), e.g. overtime, re-filtration</div>
                {act.actualAdjustments.map((a: any, i: number) => <div key={i} className="row" style={{ gap: 6, marginTop: 4, flexWrap: 'nowrap' }}><input className="input input-sm" value={a.label} onChange={(e) => setAct({ ...act, actualAdjustments: act.actualAdjustments.map((x: any, j: number) => j === i ? { ...x, label: e.target.value } : x) })} placeholder="Description" /><NumInput className="input-sm" style={{ width: 120 }} value={a.amount} onChange={(v) => setAct({ ...act, actualAdjustments: act.actualAdjustments.map((x: any, j: number) => j === i ? { ...x, amount: v } : x) })} /><button className="icon-btn" onClick={() => setAct({ ...act, actualAdjustments: act.actualAdjustments.filter((_: any, j: number) => j !== i) })}>×</button></div>)}
                <Button size="sm" style={{ marginTop: 6 }} onClick={() => setAct({ ...act, actualAdjustments: [...act.actualAdjustments, { label: '', amount: '' }] })}>Add cost</Button></div>
              <div className="row">
                <Button disabled={busy} onClick={async () => done(await run(() => api.patch(`/api/batches/${id}`, { actualOutputQty: act.actualOutputQty || null, actualPackagedUnits: act.actualPackagedUnits || null, actualAdjustments: act.actualAdjustments.filter((a: any) => a.label), productionDate: act.productionDate || null, expiryDate: act.expiryDate || null }), 'Actuals saved'))}>Save actuals</Button>
                {can('costs.read') && <Button kind="primary" disabled={busy || !b.actualOutputQty} onClick={async () => { if (await confirm({ title: 'Lock actual costs?', body: 'Calculates the actual cost with this batch\'s snapshot prices, the actual output and the extra costs, and freezes it. Save actuals first.', confirmText: 'Lock costs' })) done(await run(() => api.post(`/api/batches/${id}/complete-costing`), 'Actual costs locked')); }}>Lock actual costs</Button>}
              </div>
            </div>
          ) : <span className="muted">Recorded by production.</span>}
        </Card>

        {can('costs.read') && est && (
          <Card title="Estimated vs. actual">
            <table className="table compact"><thead><tr><th></th><th className="num"><span className="tag-est">Estimated</span></th><th className="num"><span className="tag-act">Actual</span></th></tr></thead>
              <tbody>
                <tr><td>Sellable output</td><td className="num">{qty(est.sellableQty, b.outputUnit)}</td><td className="num">{qty(actual?.sellableQty, b.outputUnit)}</td></tr>
                <tr><td>Total batch cost</td><td className="num">{sek(est.totalBatchCost)}</td><td className="num">{sek(actual?.totalBatchCost)}</td></tr>
                <tr><td>Cost per {b.outputUnit}</td><td className="num">{sek(est.costPerOutputUnit)}</td><td className="num"><strong>{sek(actual?.costPerOutputUnit)}</strong></td></tr>
                {est.costPerPackage && <tr><td>Cost per package</td><td className="num">{sek(est.costPerPackage)}</td><td className="num">{sek(actual?.costPerPackage)}</td></tr>}
              </tbody></table>
            {variance ? (
              <div className="summary-list small" style={{ marginTop: 10 }}>
                <span className="lbl">Variance per {b.outputUnit}</span><span className="val"><strong>{sek(variance.diff)}</strong></span>
                <span className="lbl">· from output/yield difference</span><span className="val">{sek(variance.yieldEffect)}</span>
                <span className="lbl">· from cost difference</span><span className="val">{sek(variance.costEffect)}</span>
              </div>
            ) : <div className="muted small" style={{ marginTop: 8 }}>Lock actual costs to see the variance. Estimate saved {dateTime(b.estimate?.createdAt)} with prices at that time.</div>}
          </Card>
        )}
      </div>

      {can('costs.read') && (actual || est) && <Card title={actual ? 'Actual cost breakdown (locked)' : 'Estimated cost breakdown (snapshot)'} pad={false}><CostBreakdown result={actual ?? est} /></Card>}

      <Card title="Quality results">
        {b.specs.length === 0 && <Alert tone="info">No quality specifications configured for this product (Recipes → Quality specs). Results can still be recorded.</Alert>}
        <table className="table compact" style={{ marginTop: 8 }}><thead><tr><th>Parameter</th><th>Specification</th><th>Result value</th><th>Outcome</th><th>Tested</th><th>Document ref.</th></tr></thead>
          <tbody>
            {b.specs.map((s: any) => { const r = [...b.qcResults].reverse().find((x: any) => x.spec_id === s.id); return <tr key={`s${s.id}`}><td>{s.parameter}</td><td className="small">{[s.min_value && `≥ ${s.min_value}`, s.max_value && `≤ ${s.max_value}`, s.target_text].filter(Boolean).join(', ') || '—'} {s.unit}</td><td>{r?.value_text ?? <span className="muted">not tested</span>}</td><td>{r ? <Badge tone={r.result === 'pass' ? 'ok' : r.result === 'fail' ? 'error' : 'neutral'}>{r.result}</Badge> : '—'}</td><td className="small">{r ? `${date(r.tested_at)} ${r.tested_by_name ?? ''}` : ''}</td><td className="small">{r?.attachment_ref ?? ''}</td></tr>; })}
            {b.qcResults.filter((r: any) => !r.spec_id).map((r: any) => <tr key={`r${r.id}`}><td>{r.parameter}</td><td className="muted small">no spec</td><td>{r.value_text}</td><td><Badge tone={r.result === 'pass' ? 'ok' : r.result === 'fail' ? 'error' : 'neutral'}>{r.result}</Badge></td><td className="small">{date(r.tested_at)} {r.tested_by_name}</td><td className="small">{r.attachment_ref}</td></tr>)}
          </tbody></table>
        {can('quality.write') && !closed && (
          <div className="form-grid" style={{ marginTop: 12, alignItems: 'end' }}>
            <Field label="Parameter"><select className="input" value={qc.specId} onChange={(e) => setQc({ ...qc, specId: e.target.value })}><option value="">Other (free text)</option>{b.specs.map((s: any) => <option key={s.id} value={s.id}>{s.parameter}</option>)}</select></Field>
            {!qc.specId && <Field label="Name"><input className="input" value={qc.parameter} onChange={(e) => setQc({ ...qc, parameter: e.target.value })} /></Field>}
            <Field label="Value"><input className="input" value={qc.valueText} onChange={(e) => setQc({ ...qc, valueText: e.target.value })} /></Field>
            <Field label="Outcome" hint="Automatic when numeric limits exist"><select className="input" value={qc.result} onChange={(e) => setQc({ ...qc, result: e.target.value })}><option value="">Auto / choose</option><option value="pass">Pass</option><option value="fail">Fail</option><option value="info">Info only</option></select></Field>
            <Field label="Document reference" hint="e.g. Eurofins report no."><input className="input" value={qc.attachmentRef} onChange={(e) => setQc({ ...qc, attachmentRef: e.target.value })} /></Field>
            <Button kind="primary" disabled={busy || !qc.valueText} onClick={async () => { if (await run(() => api.post(`/api/batches/${id}/qc-results`, { specId: qc.specId ? Number(qc.specId) : null, parameter: qc.parameter || undefined, valueText: qc.valueText, result: qc.result || undefined, attachmentRef: qc.attachmentRef || null }), 'Result recorded')) { setQc({ specId: '', parameter: '', valueText: '', result: '', notes: '', attachmentRef: '' }); reload(); } }}>Record result</Button>
          </div>
        )}
        {can('quality.release') && !closed && (
          <div className="row" style={{ marginTop: 14 }}>
            <Button kind="primary" disabled={busy} onClick={async () => { if (await confirm({ title: `Release ${b.batchNumber} for dispatch?`, body: 'Records your quality approval. Requires actual output and a passing result for every active specification.', confirmText: 'Release' })) done(await run(() => api.post(`/api/batches/${id}/decision`, { decision: 'release' }), 'Batch released')); }}>Release batch</Button>
            <Button disabled={busy} onClick={async () => done(await run(() => api.post(`/api/batches/${id}/decision`, { decision: 'hold' }), 'Batch on hold'))}>Hold</Button>
            <Button kind="danger" disabled={busy} onClick={async () => { if (await confirm({ title: `Reject ${b.batchNumber}?`, danger: true, confirmText: 'Reject batch' })) done(await run(() => api.post(`/api/batches/${id}/decision`, { decision: 'reject' }), 'Batch rejected')); }}>Reject</Button>
          </div>
        )}
        <p className="muted small" style={{ marginTop: 10 }}>The system records quality decisions; it does not by itself establish food-safety compliance. File attachments are not stored yet: record the document reference.</p>
      </Card>

      <Card title="Ingredient traceability" pad={false}>
        <table className="table compact"><thead><tr><th>Material</th><th className="num">Planned quantity</th><th>Supplier lot</th></tr></thead>
          <tbody>{b.inputs.map((i: any) => <tr key={i.id}><td>{i.material_name}</td><td className="num">{qty(i.planned_qty, i.unit)}</td><td>{i.supplier_lot ?? <span className="muted">not assigned</span>}</td></tr>)}</tbody></table>
        <div className="card-body muted small">Planned inputs are recorded per batch. Assigning supplier lots, actual consumption and stock movements is prepared in the database but not yet available in the interface (phase 3).</div>
      </Card>
    </div>
  );
}
