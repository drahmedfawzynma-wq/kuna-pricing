import React from 'react';
import { useParams } from 'react-router-dom';
import { Loading, useLoad } from '../ui';
import { date, num, pct, sek } from '../format';

/** Customer-facing quotation. Uses the /print endpoint, which contains no recipes, costs or margins. */
export default function QuotationPrint() {
  const { id } = useParams();
  const { data: q, error } = useLoad<any>(`/api/quotations/${id}/print`);
  if (!q) return <Loading error={error} />;
  return (
    <div style={{ background: '#eef0ec', minHeight: '100vh', paddingBottom: 40 }}>
      <div className="print-toolbar"><button className="btn btn-primary" onClick={() => window.print()}>Print / save as PDF</button>{q.status !== 'approved' && <span className="badge badge-warn">{q.status === 'draft' ? 'Draft: not yet approved' : q.status}</span>}</div>
      <div className="print-page">
        <div className="row-between" style={{ alignItems: 'flex-start' }}>
          <div><h1>Quotation</h1><div style={{ marginTop: 6 }}>{q.number}{q.status === 'draft' ? ' (draft)' : ''}</div></div>
          <div style={{ textAlign: 'right' }}><strong>{q.company.name}</strong><div style={{ whiteSpace: 'pre-line' }}>{q.company.address}</div></div>
        </div>
        <div className="row-between" style={{ marginTop: 28, alignItems: 'flex-start' }}>
          <div><div className="muted small">To</div><strong>{q.customer?.name}</strong>{q.customer?.contact_name && <div>{q.customer.contact_name}</div>}<div style={{ whiteSpace: 'pre-line' }}>{q.customer?.address}</div>{q.customer?.org_number && <div className="small">Org. no. {q.customer.org_number}</div>}</div>
          <table style={{ width: 'auto', marginTop: 0 }}><tbody>
            <tr><td className="muted">Date</td><td>{date(q.quoteDate)}</td></tr>
            <tr><td className="muted">Valid until</td><td>{date(q.validUntil)}</td></tr>
            <tr><td className="muted">Currency</td><td>{q.currency}</td></tr>
          </tbody></table>
        </div>
        <table>
          <thead><tr><th>Product</th><th>Packaging</th><th className="num">Quantity</th><th className="num">Unit price</th><th className="num">Amount</th></tr></thead>
          <tbody>{q.lines.map((l: any, i: number) => (
            <tr key={i}><td>{l.productName}{l.description && <div className="small">{l.description}</div>}</td><td>{l.priceUnit === 'package' ? l.packagingName : `Bulk (per ${l.outputUnit})`}</td>
              <td className="num">{num(l.quantity)} {l.priceUnit === 'package' ? 'pcs' : l.outputUnit}</td><td className="num">{sek(l.unitPrice, 2, '')}</td><td className="num">{sek(l.lineTotal, 2, '')}</td></tr>))}</tbody>
          <tfoot>
            <tr><td colSpan={4} className="num">Subtotal</td><td className="num">{sek(q.totals.subtotal, 2, '')}</td></tr>
            {q.totals.delivery !== '0.00' && <tr><td colSpan={4} className="num">Delivery{q.deliveryNote ? ` (${q.deliveryNote})` : ''}</td><td className="num">{sek(q.totals.delivery, 2, '')}</td></tr>}
            <tr><td colSpan={4} className="num"><strong>Total excl. VAT</strong></td><td className="num"><strong>{sek(q.totals.totalExVat, 2, '')}</strong></td></tr>
            <tr><td colSpan={4} className="num">VAT {pct(q.vatPct, 0)}</td><td className="num">{sek(q.totals.vat, 2, '')}</td></tr>
            <tr><td colSpan={4} className="num"><strong>Total incl. VAT ({q.currency})</strong></td><td className="num"><strong>{sek(q.totals.totalIncVat, 2, '')}</strong></td></tr>
          </tfoot>
        </table>
        {q.deliveryNote && q.totals.delivery === '0.00' && <p>Delivery: {q.deliveryNote}</p>}
        {q.notes && <p style={{ whiteSpace: 'pre-line', marginTop: 20 }}>{q.notes}</p>}
        <p className="small" style={{ marginTop: 28, color: '#555' }}>{q.company.terms}</p>
      </div>
    </div>
  );
}
