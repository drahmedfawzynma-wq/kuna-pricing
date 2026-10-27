import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Alert, Badge, Button, Card, Empty, Field, Loading, NumInput, PageHeader, StatusBadge, useAction, useConfirm, useLoad } from '../ui';
import { addDays, dateTime, num, pct, sek, todayIso } from '../format';
import { lineTotal } from '../../../shared/pricing';
import { Decimal, dec } from '../../../shared/decimal';

type Line = { productId: number | null; packagingFormatId: number | null; quantity: string; priceUnit: 'package' | 'output_unit'; useApprovedPrice: boolean; unitPrice: string; description: string };

export default function QuotationEditor() {
  const { id } = useParams();
  const isNew = !id;
  const { can } = useAuth();
  const nav = useNavigate();
  const confirm = useConfirm();
  const quote = useLoad<any>(isNew ? null : `/api/quotations/${id}`);
  const customers = useLoad<any[]>('/api/customers');
  const products = useLoad<any[]>('/api/products');
  const settings = useLoad<any>('/api/settings');
  const [f, setF] = useState<any>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [lookups, setLookups] = useState<Record<number, any>>({});
  const [dirty, setDirty] = useState(false);
  const { run, busy } = useAction();

  useEffect(() => {
    if (isNew && settings.data && customers.data && !f) {
      const bw = customers.data.find((c) => c.name === 'Bluewater Sweden') ?? customers.data[0];
      setF({ customerId: bw?.id ?? null, quoteDate: todayIso(), validUntil: addDays(todayIso(), Number(settings.data.settings.quotation_validity_days || 30)), vatPct: bw?.defaultVatPct ?? settings.data.settings.default_vat_pct, deliveryCharge: '0', deliveryNote: '', notes: '' });
      setLines([{ productId: null, packagingFormatId: null, quantity: '1', priceUnit: 'package', useApprovedPrice: true, unitPrice: '', description: '' }]);
    }
  }, [isNew, settings.data, customers.data, f]);
  useEffect(() => {
    if (quote.data) {
      const q = quote.data;
      setF({ customerId: q.customerId, quoteDate: q.quoteDate, validUntil: q.validUntil ?? '', vatPct: q.vatPct, deliveryCharge: q.deliveryCharge, deliveryNote: q.deliveryNote ?? '', notes: q.notes ?? '' });
      setLines(q.lines.map((l: any) => ({ productId: l.productId, packagingFormatId: l.packagingFormatId, quantity: l.quantity, priceUnit: l.priceUnit, useApprovedPrice: !!l.sellingPriceId, unitPrice: l.unitPrice, description: l.description ?? '' })));
      setDirty(false);
    }
  }, [quote.data]);

  const readOnly = !isNew && quote.data?.status !== 'draft' || !can('quotations.write');
  // Look up approved prices for each line.
  useEffect(() => {
    if (!f || readOnly) return;
    const t = setTimeout(() => {
      lines.forEach((l, i) => {
        if (!l.productId || !l.useApprovedPrice) return;
        const pf = l.priceUnit === 'package' ? l.packagingFormatId : null;
        if (l.priceUnit === 'package' && !pf) return;
        api.get(`/api/prices/lookup?productId=${l.productId}&customerId=${f.customerId ?? ''}&qty=${encodeURIComponent(l.quantity || '1')}${pf ? `&packagingFormatId=${pf}` : ''}`)
          .then((r) => setLookups((x) => ({ ...x, [i]: r && r.priceUnit === l.priceUnit ? r : null })));
      });
    }, 250);
    return () => clearTimeout(t);
  }, [JSON.stringify(lines), f?.customerId, readOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!f || !customers.data || !products.data || (!isNew && !quote.data)) return <Loading error={quote.error || customers.error || products.error} />;
  const q = quote.data;
  const setL = (i: number, patch: Partial<Line>) => { setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l))); setDirty(true); };
  const setField = (k: string, v: any) => { setF((x: any) => ({ ...x, [k]: v })); setDirty(true); };
  const priceOf = (l: Line, i: number) => (readOnly ? l.unitPrice : l.useApprovedPrice ? lookups[i]?.price ?? null : l.unitPrice);
  const subtotal = lines.reduce((s, l, i) => s.plus(lineTotal(priceOf(l, i), l.quantity) ?? 0), new Decimal(0));
  const exVat = subtotal.plus(dec(f.deliveryCharge) ?? 0);
  const vat = exVat.times(dec(f.vatPct) ?? 0).div(100).toDecimalPlaces(2);

  const save = async () => {
    const body = { ...f, validUntil: f.validUntil || null, deliveryCharge: f.deliveryCharge || '0', deliveryNote: f.deliveryNote || null, notes: f.notes || null,
      lines: lines.filter((l) => l.productId).map((l) => ({ ...l, packagingFormatId: l.priceUnit === 'package' ? l.packagingFormatId : null, unitPrice: l.useApprovedPrice ? null : l.unitPrice, description: l.description || null })) };
    const r = await run(() => (isNew ? api.post('/api/quotations', body) : api.put(`/api/quotations/${id}`, body)), 'Quotation saved');
    if (r) { setDirty(false); if (isNew) nav(`/quotations/${r.id}`, { replace: true }); else quote.setData(r); }
  };

  return (
    <div>
      <PageHeader title={isNew ? 'New quotation' : <span className="row" style={{ gap: 8 }}>{q.number} <StatusBadge status={q.status} /></span>}
        subtitle={q ? `Created ${dateTime(q.createdAt)} by ${q.createdByName ?? '—'}${q.approvedAt ? ` · approved ${dateTime(q.approvedAt)} by ${q.approvedByName}` : ''}` : 'Lines use approved selling prices for the customer and quantity tier.'}
        actions={<>
          {q && <Button onClick={() => window.open(`/quotations/${q.id}/print`, '_blank')}>Printable quotation</Button>}
          {q && can('quotations.write') && <Button onClick={async () => { const r = await run(() => api.post(`/api/quotations/${q.id}/duplicate`), 'Duplicated as new draft'); if (r) nav(`/quotations/${r.id}`); }}>Duplicate</Button>}
          {q && q.status !== 'cancelled' && can('quotations.write') && (q.status === 'draft' || can('quotations.approve')) && <Button kind="danger" onClick={async () => { if (await confirm({ title: `Cancel ${q.number}?`, body: 'The quotation is kept for history but marked cancelled.', danger: true, confirmText: 'Cancel quotation' }) && await run(() => api.post(`/api/quotations/${q.id}/cancel`), 'Quotation cancelled')) quote.reload(); }}>Cancel quotation</Button>}
          {!readOnly && <Button kind={dirty || isNew ? 'primary' : 'default'} disabled={busy} onClick={save}>{isNew ? 'Save draft' : dirty ? 'Save changes' : 'Saved'}</Button>}
          {q?.status === 'draft' && can('quotations.approve') && <Button kind="primary" disabled={busy || dirty} title={dirty ? 'Save first' : undefined} onClick={async () => {
            if (await confirm({ title: `Approve ${q.number}?`, body: 'The quotation will be locked. The current costing behind every line is stored as a snapshot so later price changes do not alter it.', confirmText: 'Approve' })) {
              const r = await run(() => api.post(`/api/quotations/${q.id}/approve`), 'Quotation approved'); if (r) quote.setData(r);
            }
          }}>Approve</Button>}
        </>} />
      {readOnly && q && q.status !== 'draft' && <Alert tone="info">This quotation is {q.status} and locked.{q.status === 'approved' && ' Its prices and costing snapshots are preserved even if material prices change.'}</Alert>}
      <div className="stack" style={{ marginTop: 12 }}>
        <Card title="Details">
          <div className="form-grid">
            <Field label="Customer"><select className="input" disabled={readOnly} value={f.customerId ?? ''} onChange={(e) => { const c = customers.data!.find((x) => x.id === Number(e.target.value)); setF((x: any) => ({ ...x, customerId: Number(e.target.value), vatPct: c?.defaultVatPct ?? x.vatPct })); setDirty(true); }}>{customers.data.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
            <Field label="Quotation date"><input type="date" className="input" disabled={readOnly} value={f.quoteDate} onChange={(e) => setField('quoteDate', e.target.value)} /></Field>
            <Field label="Valid until"><input type="date" className="input" disabled={readOnly} value={f.validUntil} onChange={(e) => setField('validUntil', e.target.value)} /></Field>
            <Field label="VAT (%)"><NumInput disabled={readOnly} value={f.vatPct} onChange={(v) => setField('vatPct', v)} /></Field>
            <Field label="Delivery charge (SEK, excl. VAT)"><NumInput disabled={readOnly} value={f.deliveryCharge} onChange={(v) => setField('deliveryCharge', v)} /></Field>
            <Field label="Delivery terms"><input className="input" disabled={readOnly} value={f.deliveryNote} onChange={(e) => setField('deliveryNote', e.target.value)} placeholder="e.g. Ex works Kuna" /></Field>
            <Field label="Notes shown on quotation" wide><textarea className="input" disabled={readOnly} value={f.notes} onChange={(e) => setField('notes', e.target.value)} /></Field>
          </div>
        </Card>
        <Card title="Lines" pad={false}>
          <div className="table-wrap"><table className="table compact sheet">
            <thead><tr><th style={{ minWidth: 200 }}>Product</th><th>Sold as</th><th className="num" style={{ width: 100 }}>Quantity</th><th>Price source</th><th className="num" style={{ width: 130 }}>Unit price</th><th className="num">Line total</th>{q?.status === 'approved' && can('pricing.read') && <><th className="num">Unit cost (snapshot)</th><th className="num">Margin</th></>}<th></th></tr></thead>
            <tbody>{lines.map((l, i) => {
              const prod = products.data!.find((p) => p.id === l.productId);
              const price = priceOf(l, i);
              const snap = q?.lines?.[i]?.costing;
              return (
                <tr key={i}>
                  <td><select className="input input-sm" disabled={readOnly} value={l.productId ?? ''} onChange={(e) => setL(i, { productId: Number(e.target.value) || null, packagingFormatId: null })}><option value="">Select…</option>{products.data!.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
                    {readOnly && q?.lines?.[i]?.recipeVersionNo && <div className="muted small">recipe v{q.lines[i].recipeVersionNo}</div>}</td>
                  <td><select className="input input-sm" disabled={readOnly || !prod} value={l.priceUnit === 'package' ? String(l.packagingFormatId ?? '') : 'bulk'} onChange={(e) => e.target.value === 'bulk' ? setL(i, { priceUnit: 'output_unit', packagingFormatId: null }) : setL(i, { priceUnit: 'package', packagingFormatId: Number(e.target.value) || null })}>
                    <option value="">Choose packaging…</option>{prod?.packagingFormats.map((pf: any) => <option key={pf.id} value={pf.id}>{pf.name}</option>)}<option value="bulk">Bulk, per {prod?.outputUnit ?? 'L'}</option></select></td>
                  <td><NumInput className="input-sm" disabled={readOnly} value={l.quantity} onChange={(v) => setL(i, { quantity: v })} /></td>
                  <td>{readOnly ? <span className="small">{l.useApprovedPrice ? 'Approved price' : 'Manual'}</span> : (
                    <select className="input input-sm" value={l.useApprovedPrice ? 'approved' : 'manual'} onChange={(e) => setL(i, { useApprovedPrice: e.target.value === 'approved' })}><option value="approved">Approved price</option>{can('pricing.write') && <option value="manual">Manual price</option>}</select>)}
                    {!readOnly && l.useApprovedPrice && l.productId && (lookups[i] ? <div className="muted small">{lookups[i].customerName ?? 'General'} price{lookups[i].minQty !== '1' ? `, tier ≥ ${num(lookups[i].minQty)}` : ''}</div> : <div className="small w-error">No approved price</div>)}</td>
                  <td>{!readOnly && !l.useApprovedPrice ? <NumInput className="input-sm" value={l.unitPrice} onChange={(v) => setL(i, { unitPrice: v })} /> : <div className="num">{sek(price)}</div>}</td>
                  <td className="num">{sek(lineTotal(price, l.quantity))}</td>
                  {q?.status === 'approved' && can('pricing.read') && <><td className="num">{sek(snap?.unitCost)}</td><td className="num">{pct(snap?.marginPct)}</td></>}
                  <td>{!readOnly && <button className="icon-btn" onClick={() => { setLines(lines.filter((_, j) => j !== i)); setDirty(true); }}>×</button>}</td>
                </tr>);
            })}
              {lines.length === 0 && <tr><td colSpan={8}><Empty title="No lines" /></td></tr>}
            </tbody>
          </table></div>
          {!readOnly && <div className="card-body" style={{ paddingTop: 8 }}><Button size="sm" onClick={() => { setLines([...lines, { productId: null, packagingFormatId: null, quantity: '1', priceUnit: 'package', useApprovedPrice: true, unitPrice: '', description: '' }]); setDirty(true); }}>Add line</Button></div>}
          <div className="card-body" style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <div className="summary-list" style={{ minWidth: 320 }}>
              <span className="lbl">Subtotal</span><span className="val">{sek(subtotal)}</span>
              <span className="lbl">Delivery charge</span><span className="val">{sek(f.deliveryCharge || '0')}</span>
              <span className="lbl total">Total excl. VAT</span><span className="val total">{sek(exVat)}</span>
              <span className="lbl">VAT {pct(f.vatPct, 0)}</span><span className="val">{sek(vat)}</span>
              <span className="lbl total">Total incl. VAT</span><span className="val total">{sek(exVat.plus(vat))}</span>
            </div>
          </div>
        </Card>
        {q?.status === 'draft' && can('quotations.approve') && <div className="muted small">Approval requires each line's recipe to be reviewed and its costing complete.</div>}
        {lines.some((l, i) => !readOnly && l.useApprovedPrice && l.productId && !lookups[i]) && <Badge tone="warn">Some lines have no approved price yet; they cannot be saved.</Badge>}
      </div>
    </div>
  );
}
