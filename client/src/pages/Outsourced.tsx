import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Alert, Badge, Button, Card, Empty, Field, Loading, Modal, NumInput, PageHeader, StatusBadge, useAction, useConfirm, useLoad } from '../ui';
import { BatchCostsEditor, CostBreakdown, validBatchCosts, type BatchCostRow } from '../components';
import { date, num, qty, sek, todayIso } from '../format';
import { Decimal, dec } from '../../../shared/decimal';

const FEE_BASIS: Record<string, string> = { per_output_qty: 'Per L/kg received', per_batch: 'Per batch' };

/** Where a partner batch is in its four steps. */
export function partnerStep(b: { status: string; sentDate?: string | null; sent_date?: string | null; partnerProducedDate?: string | null; partner_produced_date?: string | null; receivedDate?: string | null; received_date?: string | null; costsLocked?: boolean; costs_locked?: number }) {
  const sent = b.sentDate ?? b.sent_date;
  const produced = b.partnerProducedDate ?? b.partner_produced_date;
  const received = b.receivedDate ?? b.received_date;
  const locked = b.costsLocked ?? !!b.costs_locked;
  if (b.status === 'released') return { n: 5, label: 'Released' };
  if (b.status === 'rejected') return { n: 5, label: 'Rejected' };
  if (!sent) return { n: 1, label: 'Ready to send ingredients' };
  if (!received) return { n: produced ? 3 : 2, label: produced ? 'Waiting for finished goods' : 'At partner' };
  if (!locked) return { n: 3, label: 'Received, cost not locked' };
  return { n: 4, label: 'Waiting for quality release' };
}

export default function Outsourced() {
  const { id } = useParams();
  const { can } = useAuth();
  const nav = useNavigate();
  const partners = useLoad<any[]>('/api/partners');
  const batches = useLoad<any[]>('/api/batches?partner=1');
  const [editing, setEditing] = useState<any | null>(null);
  const [creating, setCreating] = useState(false);
  const manage = can('batches.write') && can('costs.read');
  const costs = can('costs.read');

  return (
    <div>
      <PageHeader title="Outsourced production" subtitle="Co-manufacturers that make Kuna products from ingredients Kuna sends. Each partner batch goes through four steps: ingredients sent, produced, finished goods received, quality release."
        actions={manage && <>
          <Button onClick={() => setEditing({ name: '', contactName: '', email: '', phone: '', address: '', notes: '', feeBasis: 'per_output_qty', feeRate: '', archived: false })}>Add partner</Button>
          <Button kind="primary" disabled={!partners.data?.some((p) => !p.archived)} onClick={() => setCreating(true)}>New partner batch</Button>
        </>} />

      {id ? <PartnerBatch id={Number(id)} onChanged={() => { batches.reload(); partners.reload(); }} /> : (
        <>
          {!partners.data ? <Loading error={partners.error} /> : partners.data.length === 0 ? (
            <Card><Empty title="No partners yet" action={manage && <Button kind="primary" onClick={() => setEditing({ name: '', feeBasis: 'per_output_qty', feeRate: '', archived: false })}>Add partner</Button>}>
              Add a co-manufacturer with its fee terms. Then plan a partner batch: Kuna's ingredients, the partner fee and freight become the batch cost.</Empty></Card>
          ) : (
            <div className="partner-cards">
              {partners.data.map((p) => (
                <button key={p.id} className="card partner-card" onClick={() => manage && setEditing({ ...p, feeRate: p.feeRate ?? '' })} disabled={!manage} style={{ opacity: p.archived ? 0.6 : 1 }}>
                  <div className="row-between"><strong>{p.name}</strong>{p.archived ? <Badge>Archived</Badge> : p.openBatches ? <Badge tone="info">{p.openBatches} open</Badge> : <Badge>No open batches</Badge>}</div>
                  <div className="muted small" style={{ marginTop: 6 }}>
                    Fee: {FEE_BASIS[p.feeBasis]}{costs ? ` · ${p.feeRate ? sek(p.feeRate) : 'not set'}` : ''}<br />
                    {[p.contactName, p.email, p.phone].filter(Boolean).join(' · ') || 'No contact details'}
                  </div>
                </button>
              ))}
            </div>
          )}
          <Card title="Partner batches" pad={false}>
            {!batches.data ? <Loading error={batches.error} /> : batches.data.length === 0 ? <Empty title="No partner batches yet" /> : (
              <div className="table-wrap"><table className="table">
                <thead><tr><th>Batch</th><th>Product</th><th>Partner</th><th className="num">Planned</th><th className="num">Received</th><th>Sent</th><th>Step</th>{costs && <><th className="num"><span className="tag-est">Est.</span> cost/unit</th><th className="num"><span className="tag-act">Actual</span> cost/unit</th></>}<th>Status</th></tr></thead>
                <tbody>{batches.data.map((b) => (
                  <tr key={b.id} className="clickable" onClick={() => nav(`/outsourced/${b.id}`)}>
                    <td><strong>{b.batchNumber}</strong></td><td>{b.productName}</td><td>{b.partnerName}</td>
                    <td className="num">{qty(b.plannedQty, b.outputUnit)}</td><td className="num">{qty(b.actualOutputQty, b.outputUnit)}</td><td>{date(b.sentDate)}</td>
                    <td className="small">{partnerStep(b).label}</td>
                    {costs && <><td className="num">{sek(b.estimatedCostPerUnit)}</td><td className="num">{sek(b.actualCostPerUnit)}</td></>}
                    <td><StatusBadge status={b.status} /></td>
                  </tr>))}</tbody>
              </table></div>
            )}
          </Card>
        </>
      )}
      {editing && <PartnerModal partner={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); partners.reload(); }} />}
      {creating && <NewPartnerBatch partners={(partners.data ?? []).filter((p) => !p.archived)} onClose={() => setCreating(false)} onCreated={(bid) => { setCreating(false); batches.reload(); partners.reload(); nav(`/outsourced/${bid}`); }} />}
    </div>
  );
}

function PartnerModal({ partner, onClose, onSaved }: { partner: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<any>(partner);
  const { run, busy } = useAction();
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title={f.id ? `Edit ${partner.name}` : 'Add partner'} onClose={onClose} width={560} footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" disabled={busy || !f.name} onClick={async () => {
      const body = { name: f.name, contactName: f.contactName || null, email: f.email || null, phone: f.phone || null, address: f.address || null, notes: f.notes || null, feeBasis: f.feeBasis, feeRate: f.feeRate || null, archived: !!f.archived };
      if (await run(() => (f.id ? api.patch(`/api/partners/${f.id}`, body) : api.post('/api/partners', body)), 'Partner saved')) onSaved();
    }}>Save</Button></>}>
      <div className="form-grid">
        <Field label="Name" wide><input className="input" value={f.name} onChange={set('name')} /></Field>
        <Field label="Fee basis"><select className="input" value={f.feeBasis} onChange={set('feeBasis')}><option value="per_output_qty">Per L/kg received</option><option value="per_batch">Per batch</option></select></Field>
        <Field label={f.feeBasis === 'per_batch' ? 'Fee per batch (SEK)' : 'Fee per L/kg received (SEK)'}><NumInput value={f.feeRate} onChange={(v) => setF({ ...f, feeRate: v })} /></Field>
        <Field label="Contact person"><input className="input" value={f.contactName ?? ''} onChange={set('contactName')} /></Field>
        <Field label="Email"><input className="input" value={f.email ?? ''} onChange={set('email')} /></Field>
        <Field label="Phone"><input className="input" value={f.phone ?? ''} onChange={set('phone')} /></Field>
        <Field label="Address" wide><textarea className="input" value={f.address ?? ''} onChange={set('address')} /></Field>
        <Field label="Notes (agreement, lead times)" wide><textarea className="input" value={f.notes ?? ''} onChange={set('notes')} /></Field>
      </div>
      {f.id && <label className="check" style={{ marginTop: 10 }}><input type="checkbox" checked={!!f.archived} onChange={(e) => setF({ ...f, archived: e.target.checked })} /> Archived (no new batches)</label>}
      <p className="muted small">Changing the fee does not change existing batches: each batch keeps the terms it was created with until its goods are received.</p>
    </Modal>
  );
}

function NewPartnerBatch({ partners, onClose, onCreated }: { partners: any[]; onClose: () => void; onCreated: (id: number) => void }) {
  const products = useLoad<any[]>('/api/products');
  const [f, setF] = useState<any>({ partnerId: partners[0]?.id ?? '', productId: '', packagingFormatId: '', plannedQty: '', plannedYieldPct: '', feeBasis: partners[0]?.feeBasis ?? 'per_output_qty', feeRate: partners[0]?.feeRate ?? '', freightOut: '', freightBack: '', batchNumber: '', notes: '' });
  const [inhouse, setInhouse] = useState<BatchCostRow[]>([{ category: 'labour', description: 'Kuna labour if made in-house', amount: '' }]);
  const { run, busy } = useAction();
  const prod = products.data?.find((p) => p.id === Number(f.productId));
  const partner = partners.find((p) => p.id === Number(f.partnerId));
  return (
    <Modal title="New partner batch" width={720} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" disabled={busy || !f.partnerId || !f.productId || !f.plannedQty} onClick={async () => {
      const r = await run(() => api.post('/api/partner-batches', {
        partnerId: Number(f.partnerId), productId: Number(f.productId), packagingFormatId: f.packagingFormatId ? Number(f.packagingFormatId) : null,
        plannedQty: f.plannedQty, plannedYieldPct: f.plannedYieldPct || null, feeBasis: f.feeBasis, feeRate: f.feeRate || null,
        freightOut: f.freightOut || null, freightBack: f.freightBack || null, batchNumber: f.batchNumber || null, notes: f.notes || null, inhouseExtraCosts: validBatchCosts(inhouse),
      }), 'Partner batch planned');
      if (r) onCreated(r.id);
    }}>Plan partner batch</Button></>}>
      <div className="form-grid">
        <Field label="Partner"><select className="input" value={f.partnerId} onChange={(e) => { const p = partners.find((x) => x.id === Number(e.target.value)); setF({ ...f, partnerId: e.target.value, feeBasis: p?.feeBasis ?? f.feeBasis, feeRate: p?.feeRate ?? '' }); }}>{partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        <Field label="Product"><select className="input" value={f.productId} onChange={(e) => setF({ ...f, productId: e.target.value, packagingFormatId: '' })}><option value="">Select…</option>{products.data?.map((p) => <option key={p.id} value={p.id}>{p.name}{p.currentVersion ? ` (v${p.currentVersion.versionNo} ${p.currentVersion.status})` : ''}</option>)}</select></Field>
        <Field label={`Batch size (${prod?.outputUnit ?? 'L'})`}><NumInput value={f.plannedQty} onChange={(v) => setF({ ...f, plannedQty: v })} /></Field>
        <Field label="Expected yield at partner (%)" hint="Blank = recipe yield"><NumInput value={f.plannedYieldPct} onChange={(v) => setF({ ...f, plannedYieldPct: v })} /></Field>
        <Field label="Packaging"><select className="input" value={f.packagingFormatId} onChange={(e) => setF({ ...f, packagingFormatId: e.target.value })}><option value="">Bulk</option>{prod?.packagingFormats.map((pf: any) => <option key={pf.id} value={pf.id}>{pf.name}</option>)}</select></Field>
        <Field label="Batch number" hint="Blank = generated (P-…)"><input className="input" value={f.batchNumber} onChange={(e) => setF({ ...f, batchNumber: e.target.value })} /></Field>
        <Field label="Fee basis"><select className="input" value={f.feeBasis} onChange={(e) => setF({ ...f, feeBasis: e.target.value })}><option value="per_output_qty">Per {prod?.outputUnit ?? 'L/kg'} received</option><option value="per_batch">Per batch</option></select></Field>
        <Field label="Partner fee (SEK)" hint={partner?.feeRate ? `${partner.name}: ${sek(partner.feeRate)}` : 'Not set for this partner'}><NumInput value={f.feeRate} onChange={(v) => setF({ ...f, feeRate: v })} /></Field>
        <Field label="Freight to partner (SEK, estimate)"><NumInput value={f.freightOut} onChange={(v) => setF({ ...f, freightOut: v })} /></Field>
        <Field label="Freight back to Kuna (SEK, estimate)"><NumInput value={f.freightBack} onChange={(v) => setF({ ...f, freightBack: v })} /></Field>
        <Field label="Notes" wide><textarea className="input" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      </div>
      <div style={{ marginTop: 14 }}>
        <div className="field-label" style={{ marginBottom: 6 }}>For the make-or-buy comparison: what would the same batch cost at Kuna on top of the recipe? (SEK, optional)</div>
        <BatchCostsEditor rows={inhouse} onChange={setInhouse} />
      </div>
      <p className="muted small">Uses the approved recipe. Kuna's own labour, setup, equipment, overhead and consumable lines from the recipe are left out of the partner cost; quality testing stays. Ingredient prices are frozen when you mark the ingredients as sent.</p>
    </Modal>
  );
}

function PartnerBatch({ id, onChanged }: { id: number; onChanged: () => void }) {
  const { can } = useAuth();
  const confirm = useConfirm();
  const { data: b, error, setData } = useLoad<any>(`/api/batches/${id}`);
  const { run, busy } = useAction();
  const [lots, setLots] = useState<Record<number, string>>({});
  const [send, setSend] = useState<any>({ sentDate: todayIso(), freightOut: '' });
  const [prod, setProd] = useState<any>({ producedDate: todayIso(), partnerRef: '' });
  const [rec, setRec] = useState<any>(null);
  useEffect(() => {
    if (!b) return;
    setLots(Object.fromEntries(b.inputs.map((i: any) => [i.id, i.supplier_lot ?? ''])));
    setSend((s: any) => ({ ...s, freightOut: b.freightOut ?? '' }));
    setProd({ producedDate: b.partnerProducedDate ?? todayIso(), partnerRef: b.partnerRef ?? '' });
    setRec({ receivedDate: b.receivedDate ?? todayIso(), receivedQty: b.actualOutputQty ?? '', packagedUnits: b.actualPackagedUnits ?? '', partnerLot: b.partnerLot ?? '', coaRef: b.coaRef ?? '', expiryDate: b.expiryDate ?? '', feeRate: b.partnerFeeRate ?? '', freightOut: b.freightOut ?? '', freightBack: b.freightBack ?? '' });
  }, [b]);
  if (!b || !rec) return <Loading error={error} />;
  if (!b.partnerId) return <Alert tone="info">This is an in-house batch. <Link to={`/batches/${id}`}>Open it under Production batches.</Link></Alert>;
  const done = (r: any) => { if (r) { setData(r); onChanged(); } };
  const step = partnerStep(b);
  const closed = ['released', 'rejected'].includes(b.status);
  const write = can('batches.write');
  const manage = write && can('costs.read');
  const lotPayload = () => b.inputs.map((i: any) => ({ inputId: i.id, lot: lots[i.id]?.trim() || null }));
  const cls = (n: number) => (step.n > n ? 'step step-done' : step.n === n ? 'step step-now' : 'step');
  const partnerCost = b.actual?.result ?? b.estimate?.result;
  const ih = b.inhouse?.result;
  const lineMap = new Map<string, any>((b.estimate?.result?.lines ?? []).filter((l: any) => l.section === 'ingredients').map((l: any) => [String(l.materialId), l]));

  return (
    <div className="stack">
      <Card title={<span className="row" style={{ gap: 8 }}>{b.batchNumber} · {b.productName} · {qty(b.plannedQty, b.outputUnit)} at {b.partnerName} <StatusBadge status={b.status} />{b.costsLocked && <Badge>cost locked</Badge>}</span>}
        actions={<Link to="/outsourced">All partner batches</Link>}>
        <div className="steps">
          <div className={cls(1)}><div className="step-n">Step 1{b.sentDate ? ` · ${date(b.sentDate)}` : ''}</div><div className="step-t">Ingredients sent</div><div className="small muted">Kuna ingredients with supplier lot numbers</div></div>
          <div className={cls(2)}><div className="step-n">Step 2{b.partnerProducedDate ? ` · ${date(b.partnerProducedDate)}` : ' · optional'}</div><div className="step-t">Produced by partner</div><div className="small muted">{b.partnerRef ? `Partner ref. ${b.partnerRef}` : 'Partner confirms production'}</div></div>
          <div className={cls(3)}><div className="step-n">Step 3{b.receivedDate ? ` · ${date(b.receivedDate)}` : ''}</div><div className="step-t">Finished goods received</div><div className="small muted">{b.receivedDate ? `${qty(b.actualOutputQty, b.outputUnit)}${b.partnerLot ? ` · lot ${b.partnerLot}` : ''}` : 'Quantity, partner lot, CoA, final costs'}</div></div>
          <div className={cls(4)}><div className="step-n">Step 4{b.qcApprovedAt ? ` · ${date(b.qcApprovedAt)}` : ''}</div><div className="step-t">Quality release</div><div className="small muted">{b.status === 'released' ? `Released by ${b.qcApprovedByName}` : b.status === 'rejected' ? 'Rejected' : 'Kuna quality approves before use'}</div></div>
        </div>
        {b.notes && <p className="small" style={{ whiteSpace: 'pre-line', marginBottom: 0 }}>{b.notes}</p>}
      </Card>

      {step.n === 1 && manage && b.status !== 'on_hold' && (
        <Card title="Step 1: send the ingredients">
          <div className="form-grid">
            <Field label="Date sent"><input type="date" className="input" value={send.sentDate} onChange={(e) => setSend({ ...send, sentDate: e.target.value })} /></Field>
            <Field label="Freight to partner (SEK)"><NumInput value={send.freightOut} onChange={(v) => setSend({ ...send, freightOut: v })} /></Field>
          </div>
          <p className="muted small">Enter the supplier lot numbers in the table below. Marking as sent values the ingredients at today's reference prices and freezes them for this batch.</p>
          <Button kind="primary" disabled={busy || !send.sentDate} onClick={async () => { if (await confirm({ title: 'Mark ingredients as sent?', body: `Freezes the ingredient values for ${b.batchNumber} and moves it to the partner.`, confirmText: 'Mark as sent' })) done(await run(() => api.post(`/api/partner-batches/${id}/send`, { sentDate: send.sentDate, freightOut: send.freightOut || null, lots: lotPayload() }), 'Ingredients sent')); }}>Mark as sent</Button>
        </Card>
      )}

      {step.n === 2 && write && (
        <Card title="Step 2: partner production (optional)">
          <div className="form-grid">
            <Field label="Production date at partner"><input type="date" className="input" value={prod.producedDate} onChange={(e) => setProd({ ...prod, producedDate: e.target.value })} /></Field>
            <Field label="Partner's batch reference"><input className="input" value={prod.partnerRef} onChange={(e) => setProd({ ...prod, partnerRef: e.target.value })} /></Field>
          </div>
          <Button style={{ marginTop: 10 }} disabled={busy || !prod.producedDate} onClick={async () => done(await run(() => api.post(`/api/partner-batches/${id}/produced`, prod), 'Production confirmed'))}>Confirm production</Button>
          <span className="muted small" style={{ marginLeft: 10 }}>You can also go straight to receiving the goods.</span>
        </Card>
      )}

      {step.n >= 2 && step.n <= 3 && !b.costsLocked && !closed && manage && (
        <Card title="Step 3: receive the finished goods">
          <div className="form-grid">
            <Field label="Date received"><input type="date" className="input" value={rec.receivedDate} onChange={(e) => setRec({ ...rec, receivedDate: e.target.value })} /></Field>
            <Field label={`Accepted sellable quantity (${b.outputUnit})`}><NumInput value={rec.receivedQty} onChange={(v) => setRec({ ...rec, receivedQty: v })} /></Field>
            {b.packagingFormatId && <Field label="Packaged units"><NumInput value={rec.packagedUnits} onChange={(v) => setRec({ ...rec, packagedUnits: v })} /></Field>}
            <Field label="Partner lot number"><input className="input" value={rec.partnerLot} onChange={(e) => setRec({ ...rec, partnerLot: e.target.value })} /></Field>
            <Field label="CoA reference"><input className="input" value={rec.coaRef} onChange={(e) => setRec({ ...rec, coaRef: e.target.value })} /></Field>
            <Field label="Expiry date"><input type="date" className="input" value={rec.expiryDate} onChange={(e) => setRec({ ...rec, expiryDate: e.target.value })} /></Field>
            <Field label={b.partnerFeeBasis === 'per_batch' ? 'Partner fee per batch (SEK)' : `Partner fee per ${b.outputUnit} (SEK)`}><NumInput value={rec.feeRate} onChange={(v) => setRec({ ...rec, feeRate: v })} /></Field>
            <Field label="Freight to partner (SEK)"><NumInput value={rec.freightOut} onChange={(v) => setRec({ ...rec, freightOut: v })} /></Field>
            <Field label="Freight back (SEK)"><NumInput value={rec.freightBack} onChange={(v) => setRec({ ...rec, freightBack: v })} /></Field>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            {(['save', 'lock'] as const).map((mode) => (
              <Button key={mode} kind={mode === 'lock' ? 'primary' : 'default'} disabled={busy || !rec.receivedQty || !rec.receivedDate} onClick={async () => {
                if (mode === 'lock' && !(await confirm({ title: 'Lock the actual cost?', body: 'Uses the ingredient values frozen when sent, the partner fee for the accepted quantity and the freight above. It cannot be changed afterwards.', confirmText: 'Lock cost' }))) return;
                done(await run(() => api.post(`/api/partner-batches/${id}/receive`, { receivedDate: rec.receivedDate, receivedQty: rec.receivedQty, packagedUnits: rec.packagedUnits || null, partnerLot: rec.partnerLot || null, coaRef: rec.coaRef || null, expiryDate: rec.expiryDate || null, feeRate: rec.feeRate || null, freightOut: rec.freightOut || null, freightBack: rec.freightBack || null, lock: mode === 'lock' }), mode === 'lock' ? 'Received; actual cost locked' : 'Receipt saved'));
              }}>{mode === 'lock' ? 'Save and lock actual cost' : 'Save receipt'}</Button>
            ))}
          </div>
        </Card>
      )}

      {step.n === 4 && (
        <Alert tone="info">Goods received and cost locked. Quality results and the release decision are recorded on the batch: <Link to={`/batches/${id}`}>open quality record</Link>.</Alert>
      )}

      <div className="grid-main-side">
        <Card title="Kuna ingredients sent" pad={false} actions={write && !closed && step.n > 1 && <Button size="sm" disabled={busy} onClick={async () => done(await run(() => api.put(`/api/batches/${id}/input-lots`, lotPayload()), 'Lot numbers saved'))}>Save lot numbers</Button>}>
          <div className="table-wrap"><table className="table compact">
            <thead><tr><th>Material</th><th className="num">Quantity</th><th>Supplier lot</th>{can('costs.read') && <><th className="num">Price</th><th className="num">Value</th></>}</tr></thead>
            <tbody>{b.inputs.map((i: any) => { const l = lineMap.get(String(i.material_id)); return (
              <tr key={i.id}>
                <td>{i.material_name}</td><td className="num">{qty(i.planned_qty, i.unit)}</td>
                <td>{write && !closed ? <input className="input input-sm" style={{ maxWidth: 160 }} value={lots[i.id] ?? ''} placeholder="Supplier lot" onChange={(e) => setLots({ ...lots, [i.id]: e.target.value })} /> : (i.supplier_lot ?? <span className="muted">not recorded</span>)}</td>
                {can('costs.read') && <><td className="num small">{l?.rate ? `${num(l.rate, 2)} ${l.rateUnit ?? ''}` : '—'}</td><td className="num">{sek(l?.amount)}</td></>}
              </tr>); })}</tbody>
            {can('costs.read') && <tfoot><tr><td colSpan={4}>Total ingredients</td><td className="num">{sek(b.estimate?.result?.sections?.ingredients)}</td></tr></tfoot>}
          </table></div>
          <div className="card-body muted small">{b.sentDate ? `Valued at the reference prices on ${date(b.sentDate)}, when the ingredients were sent.` : 'Valued at today\'s reference prices until marked as sent.'} Stock levels are not tracked.</div>
        </Card>

        {can('costs.read') && partnerCost && <MakeOrBuy b={b} partner={partnerCost} inhouse={ih} />}
      </div>

      {can('costs.read') && partnerCost && <Card title={b.actual ? 'Actual cost breakdown (locked)' : 'Estimated cost breakdown'} pad={false}><CostBreakdown result={partnerCost} /></Card>}
    </div>
  );
}

function MakeOrBuy({ b, partner, inhouse }: { b: any; partner: any; inhouse: any }) {
  const s = (r: any, k: string) => dec(r?.sections?.[k]) ?? new Decimal(0);
  const kunaCosts = (r: any) => ['consumable', 'labour', 'setup_cleaning', 'testing', 'utilities_equipment', 'overhead', 'other'].reduce((a, k) => a.plus(s(r, k)), new Decimal(0));
  const unit = b.packagingFormatId ? 'package' : b.outputUnit;
  const per = (r: any) => (b.packagingFormatId ? r?.costPerPackage : r?.costPerOutputUnit);
  const diff = inhouse && per(partner) && per(inhouse) ? dec(per(partner))!.minus(per(inhouse)) : null;
  return (
    <Card title={`Cost and make-or-buy (per ${unit})`}>
      <table className="table compact">
        <thead><tr><th></th><th className="num">{b.actual ? <span className="tag-act">Partner, actual</span> : <span className="tag-est">Partner, est.</span>}</th><th className="num"><span className="tag-est">In-house, est.</span></th></tr></thead>
        <tbody>
          <tr><td>Ingredients</td><td className="num">{sek(s(partner, 'ingredients'))}</td><td className="num">{inhouse ? sek(s(inhouse, 'ingredients')) : '—'}</td></tr>
          {(s(partner, 'packaging').gt(0) || s(inhouse, 'packaging').gt(0)) && <tr><td>Packaging</td><td className="num">{sek(s(partner, 'packaging'))}</td><td className="num">{sek(s(inhouse, 'packaging'))}</td></tr>}
          <tr><td>Partner fee and freight</td><td className="num">{sek(s(partner, 'outsourcing'))}</td><td className="num">—</td></tr>
          <tr><td>Kuna labour, testing and other</td><td className="num">{sek(kunaCosts(partner))}</td><td className="num">{inhouse ? sek(kunaCosts(inhouse)) : '—'}</td></tr>
          <tr><td>Sellable output</td><td className="num">{qty(partner.sellableQty, b.outputUnit)}</td><td className="num">{inhouse ? qty(inhouse.sellableQty, b.outputUnit) : '—'}</td></tr>
          <tr><td><strong>Total batch cost</strong></td><td className="num"><strong>{sek(partner.totalBatchCost)}</strong></td><td className="num">{inhouse ? sek(inhouse.totalBatchCost) : '—'}</td></tr>
          <tr><td><strong>Cost per {unit}</strong></td><td className="num"><strong>{sek(per(partner))}</strong></td><td className="num"><strong>{inhouse ? sek(per(inhouse)) : '—'}</strong></td></tr>
        </tbody>
      </table>
      {diff && <p className="small" style={{ marginBottom: 0 }}>{diff.gt(0) ? <>Making it at the partner costs <strong>{sek(diff)}</strong> more per {unit} than the in-house estimate.</> : diff.lt(0) ? <>Making it at the partner saves <strong>{sek(diff.neg())}</strong> per {unit} compared with the in-house estimate.</> : 'Same cost per unit as the in-house estimate.'}</p>}
      {!partner.complete && <Alert tone="warn">The partner costing is incomplete (for example a missing price or fee). See the breakdown.</Alert>}
      <p className="muted small" style={{ marginBottom: 0 }}>In-house estimate saved when the batch was planned{inhouse ? '' : ' (not available)'}, with the recipe and any extra Kuna costs entered then.</p>
    </Card>
  );
}
