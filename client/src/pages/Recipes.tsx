import React, { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Badge, Button, Card, Empty, Field, Loading, Modal, NumInput, PageHeader, SearchInput, StatusBadge, useAction, useLoad } from '../ui';
import { num, pct, sek } from '../format';

export default function Recipes() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const [archived, setArchived] = useState(false);
  const { data, error } = useLoad<any[]>(`/api/products${archived ? '?archived=1' : ''}`);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const creating = sp.get('new') === '1';
  const rows = useMemo(() => (data ?? []).filter((p) => (!search || `${p.name} ${p.code}`.toLowerCase().includes(search.toLowerCase()))
    && (!status || (status === 'needs_review' ? p.currentVersion?.reviewStatus === 'needs_review' : status === 'incomplete' ? p.estimate && !p.estimate.complete : p.currentVersion?.status === status))), [data, search, status]);
  return (
    <div>
      <PageHeader title="Recipes" subtitle="Each product has versioned recipes. Approved versions are locked; editing creates a new draft version, so saved costings, batches and quotations keep the version they used."
        actions={can('recipes.write') && <Button kind="primary" onClick={() => setSp({ new: '1' })}>New recipe</Button>} />
      <Card pad={false}>
        <div className="card-body" style={{ paddingBottom: 0 }}>
          <div className="filters">
            <SearchInput value={search} onChange={setSearch} placeholder="Search products…" />
            <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Any status</option><option value="draft">Draft</option><option value="approved">Approved</option><option value="needs_review">Needs review</option>{can('costs.read') && <option value="incomplete">Incomplete costing</option>}
            </select>
            <label className="check"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Show archived</label>
          </div>
        </div>
        {!data ? <Loading error={error} /> : data.length === 0 ? <Empty title="No recipes yet" action={can('recipes.write') && <div className="row" style={{ justifyContent: 'center' }}><Button onClick={() => nav('/imports')}>Import Batchworks files</Button><Button kind="primary" onClick={() => setSp({ new: '1' })}>New recipe</Button></div>}>Create a recipe or import Batchworks costing exports.</Empty> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Product</th><th>Current version</th><th className="num">Versions</th>{can('costs.read') && <><th className="num">Est. cost / unit</th><th className="num">Default batch</th><th className="num">Target margin</th></>}<th>Packaging formats</th></tr></thead>
            <tbody>{rows.map((p) => (
              <tr key={p.id} className="clickable" onClick={() => nav(`/recipes/${p.id}`)}>
                <td><strong>{p.name}</strong><div className="muted small">{p.code}{p.description ? ` · ${p.description}` : ''}</div></td>
                <td>{p.currentVersion ? <span className="row" style={{ gap: 4 }}>v{p.currentVersion.versionNo} <StatusBadge status={p.currentVersion.status} />{p.currentVersion.reviewStatus === 'needs_review' && <StatusBadge status="needs_review" />}</span> : '—'}{p.archived && <Badge>Archived</Badge>}</td>
                <td className="num">{p.versionCount}</td>
                {can('costs.read') && <>
                  <td className="num"><span className="tag-est">{sek(p.estimate?.costPerOutputUnit)}</span>/{p.outputUnit}{p.estimate && !p.estimate.complete && <div><Badge tone="warn">Incomplete</Badge></div>}</td>
                  <td className="num">{num(p.estimate?.batchQty)} {p.outputUnit}</td>
                  <td className="num">{p.targetMarginPct ? pct(p.targetMarginPct) : <span className="muted">—</span>}</td>
                </>}
                <td className="small">{p.packagingFormats.length ? p.packagingFormats.map((f: any) => f.name).join(', ') : <span className="muted">Bulk only</span>}</td>
              </tr>))}
              {rows.length === 0 && <tr><td colSpan={7}><Empty title="No recipes match the filters" /></td></tr>}
            </tbody>
          </table></div>
        )}
      </Card>
      {creating && <ProductForm onClose={() => setSp({})} onSaved={(id) => nav(`/recipes/${id}`)} />}
    </div>
  );
}

export function ProductForm({ product, onClose, onSaved }: { product?: any; onClose: () => void; onSaved: (id: number) => void }) {
  const { can } = useAuth();
  const [f, setF] = useState<any>(product ? { code: product.code, name: product.name, description: product.description ?? '', outputUnit: product.outputUnit, targetMarginPct: product.targetMarginPct ?? '' } : { code: '', name: '', description: '', outputUnit: 'L', targetMarginPct: '' });
  const { run, busy } = useAction();
  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  const save = async () => {
    const body = { ...f, description: f.description || null, targetMarginPct: f.targetMarginPct || '' };
    const r = await run(() => (product ? api.patch(`/api/products/${product.id}`, body).then(() => ({ id: product.id })) : api.post('/api/products', body)), product ? 'Product saved' : 'Recipe created as draft v1');
    if (r) onSaved(r.id);
  };
  return (
    <Modal title={product ? 'Edit product' : 'New recipe'} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" disabled={busy || !f.code || !f.name} onClick={save}>Save</Button></>}>
      <div className="form-grid">
        <Field label="Product name"><input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} autoFocus /></Field>
        <Field label="Product code"><input className="input" value={f.code} onChange={(e) => set('code', e.target.value)} /></Field>
        <Field label="Sold per" hint={product ? 'Changing affects how batch size and output are read.' : 'Batch size and output use this unit.'}><select className="input" value={f.outputUnit} onChange={(e) => set('outputUnit', e.target.value)}><option value="L">Litre (L)</option><option value="kg">Kilogram (kg)</option></select></Field>
        {(can('pricing.read') || !product) && <Field label="Target gross margin (%)"><NumInput value={f.targetMarginPct} onChange={(v) => set('targetMarginPct', v)} /></Field>}
        <Field label="Description" wide><input className="input" value={f.description} onChange={(e) => set('description', e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
