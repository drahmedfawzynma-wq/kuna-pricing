import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { Button, Card, Empty, Loading, PageHeader, SearchInput, StatusBadge, useLoad } from '../ui';
import { date, sek } from '../format';

export default function Quotations() {
  const { can } = useAuth();
  const nav = useNavigate();
  const { data, error } = useLoad<any[]>('/api/quotations');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  if (!data) return <Loading error={error} />;
  const rows = data.filter((q) => (!status || q.status === status) && (!search || `${q.number} ${q.customerName} ${q.products}`.toLowerCase().includes(search.toLowerCase())));
  return (
    <div>
      <PageHeader title="Quotations" subtitle="Draft quotations use approved selling prices. Approval locks the quotation and stores the costing behind each line." actions={can('quotations.write') && <Button kind="primary" onClick={() => nav('/quotations/new')}>New quotation</Button>} />
      <Card pad={false}>
        <div className="card-body" style={{ paddingBottom: 0 }}><div className="filters"><SearchInput value={search} onChange={setSearch} placeholder="Number, customer, product…" />
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option><option value="draft">Draft</option><option value="approved">Approved</option><option value="cancelled">Cancelled</option></select></div></div>
        {data.length === 0 ? <Empty title="No quotations yet" action={can('quotations.write') && <Button kind="primary" onClick={() => nav('/quotations/new')}>New quotation</Button>}>Approved selling prices are needed before a product can be quoted.</Empty> : (
          <table className="table"><thead><tr><th>Number</th><th>Customer</th><th>Products</th><th>Date</th><th>Valid until</th><th className="num">Total excl. VAT</th><th>Status</th></tr></thead>
            <tbody>{rows.map((q) => (
              <tr key={q.id} className="clickable" onClick={() => nav(`/quotations/${q.id}`)}>
                <td><strong>{q.number}</strong></td><td>{q.customerName}</td><td className="small">{q.products}</td><td>{date(q.quoteDate)}</td><td>{date(q.validUntil)}</td>
                <td className="num">{sek(q.totals.totalExVat)}</td><td><StatusBadge status={q.status} /></td>
              </tr>))}
              {rows.length === 0 && <tr><td colSpan={7}><Empty title="No quotations match" /></td></tr>}
            </tbody></table>
        )}
      </Card>
    </div>
  );
}
