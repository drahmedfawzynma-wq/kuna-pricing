import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Badge, Button, Card, Field, Loading, Modal, NumInput, PageHeader, Tabs, useAction, useLoad } from '../ui';
import { dateTime } from '../format';
import { ROLE_LABELS, ROLES } from '../../../shared/permissions';

const LABELS: Record<string, string> = {
  company_name: 'Company name', company_address: 'Company address (on quotations)', base_currency: 'Reporting currency', default_vat_pct: 'Default VAT (%)',
  food_vat_pct: 'Food VAT for retail suggestions (%)', show_vat_inclusive: 'Show VAT-inclusive prices by default', quotation_prefix: 'Quotation number prefix',
  quotation_validity_days: 'Default quotation validity (days)', quotation_terms: 'Quotation terms text',
};

export default function Settings() {
  const { can, user } = useAuth();
  const [tab, setTab] = useState('general');
  return (
    <div>
      <PageHeader title="Settings" />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'general', label: 'General' }, ...(can('users.manage') ? [{ id: 'users', label: 'Users & roles' }] : []), ...(can('audit.read') ? [{ id: 'audit', label: 'Audit log' }] : []), { id: 'account', label: 'My account' }, { id: 'data', label: 'Data & backups' }]} />
      {tab === 'general' && <General />}
      {tab === 'users' && <Users />}
      {tab === 'audit' && <Audit />}
      {tab === 'account' && <Account email={user.email} />}
      {tab === 'data' && <DataInfo />}
    </div>
  );
}

function General() {
  const { can } = useAuth();
  const { data, error, reload } = useLoad<any>('/api/settings');
  const [f, setF] = useState<any>(null);
  const { run, busy } = useAction();
  useEffect(() => { if (data) setF(data.settings); }, [data]);
  if (!data || !f) return <Loading error={error} />;
  const edit = can('settings.write');
  return (
    <div className="grid-2">
      <Card title="Company, VAT and quotations">
        <div className="form-grid">
          {Object.keys(LABELS).map((k) => (
            <Field key={k} label={LABELS[k]} wide={k === 'quotation_terms' || k === 'company_address'}>
              {k === 'show_vat_inclusive' ? <select className="input" disabled={!edit} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })}><option value="0">No (exclude VAT)</option><option value="1">Yes</option></select>
                : k.endsWith('_pct') || k.endsWith('_days') ? <NumInput disabled={!edit} value={f[k]} onChange={(v) => setF({ ...f, [k]: v })} />
                  : k === 'quotation_terms' || k === 'company_address' ? <textarea className="input" disabled={!edit} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
                    : <input className="input" disabled={!edit || k === 'base_currency'} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />}
            </Field>
          ))}
        </div>
        {edit && <Button kind="primary" style={{ marginTop: 12 }} disabled={busy} onClick={async () => { if (await run(() => api.put('/api/settings', f), 'Settings saved')) reload(); }}>Save settings</Button>}
      </Card>
      <div className="stack">
        <Card title="Rounding rules"><ul style={{ margin: 0, paddingLeft: 18 }} className="small">{data.roundingRules.map((r: string) => <li key={r} style={{ marginBottom: 4 }}>{r}</li>)}</ul></Card>
        <Card title="Formulas">
          <ul style={{ margin: 0, paddingLeft: 18 }} className="small">
            <li>Unit cost = total applicable batch cost ÷ sellable units</li>
            <li>Price for target gross margin = unit cost ÷ (1 − margin)</li>
            <li>Price for target markup = unit cost × (1 + markup)</li>
            <li>Gross margin = (price − unit cost) ÷ price</li>
            <li>Markup = (price − unit cost) ÷ unit cost</li>
            <li>Landed material cost = (price × exchange rate + allocated charges) ÷ pack quantity in base units</li>
          </ul>
        </Card>
      </div>
    </div>
  );
}

function Users() {
  const { data, error, reload } = useLoad<any[]>('/api/users');
  const settings = useLoad<any>('/api/settings');
  const [editing, setEditing] = useState<any | null>(null);
  const { run, busy } = useAction();
  if (!data || !settings.data) return <Loading error={error} />;
  const perms: Record<string, string[]> = settings.data.rolePermissions;
  const allPerms = [...new Set(Object.values(perms).flat())];
  return (
    <div className="stack">
      <Card title="Users" pad={false} actions={<Button size="sm" kind="primary" onClick={() => setEditing({ email: '', name: '', role: 'sales', password: '', active: true })}>Add user</Button>}>
        <table className="table"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Created</th></tr></thead>
          <tbody>{data.map((u) => <tr key={u.id} className="clickable" onClick={() => setEditing({ ...u, password: '', active: !!u.active })}><td>{u.name}</td><td>{u.email}</td><td>{ROLE_LABELS[u.role as keyof typeof ROLE_LABELS]}</td><td>{u.active ? <Badge tone="ok">Active</Badge> : <Badge>Disabled</Badge>}</td><td className="small">{dateTime(u.created_at)}</td></tr>)}</tbody></table>
      </Card>
      <Card title="What each role can do (enforced by the server)" pad={false}>
        <div className="table-wrap"><table className="table compact"><thead><tr><th>Permission</th>{ROLES.map((r) => <th key={r} style={{ textAlign: 'center' }}>{ROLE_LABELS[r]}</th>)}</tr></thead>
          <tbody>{allPerms.map((p) => <tr key={p}><td className="mono">{p}</td>{ROLES.map((r) => <td key={r} style={{ textAlign: 'center' }}>{perms[r].includes(p) ? '✓' : ''}</td>)}</tr>)}</tbody></table></div>
      </Card>
      {editing && (
        <Modal title={editing.id ? `Edit ${editing.name}` : 'Add user'} onClose={() => setEditing(null)} width={480} footer={<><Button onClick={() => setEditing(null)}>Cancel</Button><Button kind="primary" disabled={busy} onClick={async () => {
          const body: any = { email: editing.email, name: editing.name, role: editing.role, active: editing.active };
          if (editing.password) body.password = editing.password;
          if (await run(() => (editing.id ? api.patch(`/api/users/${editing.id}`, body) : api.post('/api/users', body)), 'User saved')) { setEditing(null); reload(); }
        }}>Save</Button></>}>
          <div className="stack">
            <Field label="Name"><input className="input" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
            <Field label="Email"><input className="input" value={editing.email} onChange={(e) => setEditing({ ...editing, email: e.target.value })} /></Field>
            <Field label="Role"><select className="input" value={editing.role} onChange={(e) => setEditing({ ...editing, role: e.target.value })}>{ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</select></Field>
            <Field label={editing.id ? 'New password (leave blank to keep)' : 'Password'} hint="At least 10 characters. Changing it signs the user out."><input className="input" type="password" autoComplete="new-password" value={editing.password} onChange={(e) => setEditing({ ...editing, password: e.target.value })} /></Field>
            {editing.id && <label className="check"><input type="checkbox" checked={editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} /> Active</label>}
          </div>
        </Modal>
      )}
    </div>
  );
}

function Audit() {
  const { data, error } = useLoad<any[]>('/api/audit?limit=500');
  const [q, setQ] = useState('');
  if (!data) return <Loading error={error} />;
  const rows = data.filter((r) => !q || `${r.user_name} ${r.entity} ${r.action} ${r.summary}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <Card title="Audit log (latest 500 changes)" pad={false} actions={<input type="search" className="input search" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />}>
      <div className="table-wrap"><table className="table compact"><thead><tr><th>When (UTC)</th><th>User</th><th>Record</th><th>Action</th><th>Summary</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id}><td className="nowrap small">{dateTime(r.at)}</td><td>{r.user_name}</td><td className="small">{r.entity} #{r.entity_id ?? ''}</td><td><Badge>{r.action}</Badge></td><td className="small">{r.summary}</td></tr>)}</tbody></table></div>
    </Card>
  );
}

function Account({ email }: { email: string }) {
  const [f, setF] = useState({ current: '', next: '' });
  const { run, busy } = useAction();
  return (
    <Card title={`Signed in as ${email}`}>
      <div className="form-grid" style={{ maxWidth: 520 }}>
        <Field label="Current password"><input type="password" className="input" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} /></Field>
        <Field label="New password" hint="At least 10 characters"><input type="password" className="input" autoComplete="new-password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} /></Field>
      </div>
      <Button kind="primary" style={{ marginTop: 12 }} disabled={busy || !f.current || !f.next} onClick={async () => { if (await run(() => api.post('/api/auth/password', f), 'Password changed')) setF({ current: '', next: '' }); }}>Change password</Button>
    </Card>
  );
}

function DataInfo() {
  const { can } = useAuth();
  return (
    <div className="grid-2">
      <Card title="Backups">
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
          <li>All data is in one SQLite database file: <code>~/KunaData/kuna.db</code> (or <code>KUNA_DB_FILE</code>).</li>
          <li>The Mac installer schedules a daily backup to iCloud Drive/Kuna Backups and backs up before every update. <code>npm run backup</code> makes an extra copy at any time.</li>
          
          <li>To restore: run scripts/uninstall-mac.sh, copy the backup to ~/KunaData/kuna.db, run scripts/install-mac.sh.</li>
        </ul>
      </Card>
      <Card title="Exports">
        <div className="stack" style={{ gap: 8 }}>
          {can('materials.prices') && <a className="btn" href="/api/materials/export.csv">Export materials and current prices (CSV)</a>}
          <span className="muted small">Quotations can be printed or saved as PDF from each quotation.</span>
        </div>
      </Card>
    </div>
  );
}
