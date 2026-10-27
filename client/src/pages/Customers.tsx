import React, { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Badge, Button, Card, Empty, Field, Loading, Modal, NumInput, PageHeader, useAction, useConfirm, useLoad } from '../ui';
import { pct } from '../format';

const empty = { name: '', orgNumber: '', contactName: '', email: '', phone: '', address: '', currency: 'SEK', defaultVatPct: '25', notes: '' };

export default function Customers() {
  const { can } = useAuth();
  const [archived, setArchived] = useState(false);
  const { data, error, reload } = useLoad<any[]>(`/api/customers${archived ? '?archived=1' : ''}`);
  const [editing, setEditing] = useState<any | null>(null);
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const save = async () => {
    const body = Object.fromEntries(Object.entries(editing).filter(([k]) => k in empty).map(([k, v]) => [k, v === '' && k !== 'name' ? null : v]));
    body.currency = editing.currency || 'SEK';
    body.defaultVatPct = editing.defaultVatPct || '25';
    if (await run(() => (editing.id ? api.patch(`/api/customers/${editing.id}`, body) : api.post('/api/customers', body)), 'Customer saved')) { setEditing(null); reload(); }
  };
  return (
    <div>
      <PageHeader title="Customers" subtitle="Customer records used on quotations and customer-specific prices." actions={can('customers.write') && <Button kind="primary" onClick={() => setEditing({ ...empty })}>Add customer</Button>} />
      <Card pad={false} actions={<label className="check"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Show archived</label>} title="All customers">
        {!data ? <Loading error={error} /> : data.length === 0 ? <Empty title="No customers" /> : (
          <table className="table"><thead><tr><th>Name</th><th>Contact</th><th>Org. number</th><th>Currency</th><th className="num">Default VAT</th><th></th></tr></thead>
            <tbody>{data.map((c) => (
              <tr key={c.id} className={can('customers.write') ? 'clickable' : ''} onClick={() => can('customers.write') && setEditing({ ...empty, ...Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v ?? ''])) })}>
                <td><strong>{c.name}</strong>{c.archived && <Badge>Archived</Badge>}<div className="muted small">{c.notes}</div></td>
                <td className="small">{c.contactName}{c.email && <div className="muted">{c.email}</div>}</td><td>{c.orgNumber ?? '—'}</td><td>{c.currency}</td><td className="num">{pct(c.defaultVatPct, 0)}</td>
                <td onClick={(e) => e.stopPropagation()}>{can('customers.write') && <Button size="sm" kind="ghost" onClick={async () => { if ((c.archived || await confirm({ title: `Archive ${c.name}?`, body: 'Existing quotations keep their data.', danger: true, confirmText: 'Archive' })) && await run(() => api.post(`/api/customers/${c.id}/archive`, { archived: !c.archived }), 'Saved')) reload(); }}>{c.archived ? 'Restore' : 'Archive'}</Button>}</td>
              </tr>))}</tbody></table>
        )}
      </Card>
      {editing && (
        <Modal title={editing.id ? `Edit ${editing.name}` : 'Add customer'} onClose={() => setEditing(null)} footer={<><Button onClick={() => setEditing(null)}>Cancel</Button><Button kind="primary" disabled={busy || !editing.name} onClick={save}>Save</Button></>}>
          <div className="form-grid">
            <Field label="Name"><input className="input" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
            <Field label="Org. number"><input className="input" value={editing.orgNumber} onChange={(e) => setEditing({ ...editing, orgNumber: e.target.value })} /></Field>
            <Field label="Contact person"><input className="input" value={editing.contactName} onChange={(e) => setEditing({ ...editing, contactName: e.target.value })} /></Field>
            <Field label="Email"><input className="input" value={editing.email} onChange={(e) => setEditing({ ...editing, email: e.target.value })} /></Field>
            <Field label="Phone"><input className="input" value={editing.phone} onChange={(e) => setEditing({ ...editing, phone: e.target.value })} /></Field>
            <Field label="Currency"><input className="input" maxLength={3} value={editing.currency} onChange={(e) => setEditing({ ...editing, currency: e.target.value.toUpperCase() })} /></Field>
            <Field label="Default VAT (%)"><NumInput value={editing.defaultVatPct} onChange={(v) => setEditing({ ...editing, defaultVatPct: v })} /></Field>
            <Field label="Address" wide><textarea className="input" value={editing.address} onChange={(e) => setEditing({ ...editing, address: e.target.value })} /></Field>
            <Field label="Notes" wide><input className="input" value={editing.notes} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
    </div>
  );
}
