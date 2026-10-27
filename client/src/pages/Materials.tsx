import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams, Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Alert, Badge, Button, Card, Empty, Field, Loading, Modal, NumInput, PageHeader, SearchInput, StatusBadge, Tabs, useAction, useConfirm, useLoad } from '../ui';
import { CATEGORY_LABELS, date, dateTime, num, pct, sek, todayIso } from '../format';
import { landedUnitPrice } from '../../../shared/materialPrice';

const emptyMaterial = { code: '', name: '', category: 'raw', supplier: '', supplierCode: '', baseUnit: 'kg', densityKgPerL: '', purityPct: '', allergenInfo: '', notes: '' };

export default function Materials() {
  const { can } = useAuth();
  const nav = useNavigate();
  const { id } = useParams();
  const [sp, setSp] = useSearchParams();
  const [showArchived, setShowArchived] = useState(false);
  const list = useLoad<any[]>(`/api/materials${showArchived ? '?archived=1' : ''}`);
  const [search, setSearch] = useState('');
  const [cat, setCat] = useState('');
  const filter = sp.get('filter') ?? '';
  const [creating, setCreating] = useState(sp.get('new') === '1');

  const rows = useMemo(() => (list.data ?? []).filter((m) =>
    (!search || `${m.name} ${m.code} ${m.supplier ?? ''}`.toLowerCase().includes(search.toLowerCase()))
    && (!cat || m.category === cat)
    && (filter !== 'missing' || (can('materials.prices') && !m.currentPrice))
    && (filter !== 'review' || m.reviewStatus === 'needs_review')), [list.data, search, cat, filter, can]);

  return (
    <div>
      <PageHeader title="Materials & packaging" subtitle="Ingredients, water, processing aids, consumables and packaging. Prices are stored as dated history; the current price is the latest one effective today."
        actions={<>
          {can('materials.prices') && <a className="btn" href="/api/materials/export.csv">Export CSV</a>}
          {can('imports.run') && <Button onClick={() => nav('/imports')}>Import CSV</Button>}
          {can('materials.write') && <Button kind="primary" onClick={() => setCreating(true)}>Add material</Button>}
        </>} />
      <div className={id ? 'grid-main-side' : ''} style={id ? { gridTemplateColumns: 'minmax(0,1fr) minmax(420px, 520px)' } : undefined}>
        <Card pad={false}>
          <div className="card-body" style={{ paddingBottom: 0 }}>
            <div className="filters">
              <SearchInput value={search} onChange={setSearch} placeholder="Search name, code or supplier…" />
              <select className="input" value={cat} onChange={(e) => setCat(e.target.value)}><option value="">All categories</option>{Object.entries(CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              <select className="input" value={filter} onChange={(e) => { const n = new URLSearchParams(sp); e.target.value ? n.set('filter', e.target.value) : n.delete('filter'); setSp(n); }}>
                <option value="">Any status</option>{can('materials.prices') && <option value="missing">Missing price</option>}<option value="review">Needs review</option>
              </select>
              <label className="check"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived</label>
              <span className="spacer" /><span className="muted small">{rows.length} items</span>
            </div>
          </div>
          {!list.data ? <Loading error={list.error} /> : list.data.length === 0 ? (
            <Empty title="No materials yet" action={<div className="row" style={{ justifyContent: 'center' }}>{can('imports.run') && <Button onClick={() => nav('/imports')}>Import Batchworks materials</Button>}{can('materials.write') && <Button kind="primary" onClick={() => setCreating(true)}>Add material</Button>}</div>}>Add materials manually or import the Batchworks materials export.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Material</th><th>Category</th><th>Supplier</th>{can('materials.prices') && <><th className="num">Landed price</th><th>Effective</th></>}<th className="num">Used in</th><th></th></tr></thead>
                <tbody>
                  {rows.map((m) => (
                    <tr key={m.id} className={`clickable ${can('materials.prices') && !m.currentPrice ? 'row-missing' : ''}`} onClick={() => nav(`/materials/${m.id}`)} style={String(m.id) === id ? { outline: '2px solid var(--accent-soft)' } : undefined}>
                      <td><strong>{m.name}</strong><div className="muted small">{m.code}</div></td>
                      <td>{CATEGORY_LABELS[m.category]}</td>
                      <td className="small">{m.supplier ?? <span className="muted">—</span>}</td>
                      {can('materials.prices') && <>
                        <td className="num nowrap">{m.currentPrice ? <>{num(m.currentPrice.landedUnitPriceSek, 4)} <span className="muted small">SEK/{m.baseUnit}</span></> : <Badge tone="warn">No price</Badge>}</td>
                        <td className="small nowrap">{date(m.currentPrice?.effectiveDate)}</td>
                      </>}
                      <td className="num">{m.usageCount || <span className="muted">0</span>}</td>
                      <td className="nowrap">{m.reviewStatus === 'needs_review' && <StatusBadge status="needs_review" />} {m.archived && <Badge>Archived</Badge>}</td>
                    </tr>
                  ))}
                  {rows.length === 0 && <tr><td colSpan={7}><Empty title="No materials match the filters" /></td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        {id && <MaterialDetail id={Number(id)} onChanged={list.reload} onClose={() => nav('/materials')} />}
      </div>
      {creating && <MaterialForm initial={emptyMaterial} onClose={() => { setCreating(false); sp.delete('new'); setSp(sp); }} onSaved={(newId) => { setCreating(false); list.reload(); nav(`/materials/${newId}`); }} />}
    </div>
  );
}

function MaterialForm({ initial, id, hasPrices, onClose, onSaved }: { initial: any; id?: number; hasPrices?: boolean; onClose: () => void; onSaved: (id: number) => void }) {
  const [f, setF] = useState<any>(initial);
  const { run, busy } = useAction();
  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  const save = async () => {
    const body = { ...f, supplier: f.supplier || null, supplierCode: f.supplierCode || null, densityKgPerL: f.densityKgPerL || '', purityPct: f.purityPct || '', allergenInfo: f.allergenInfo || null, notes: f.notes || null };
    const r = await run(() => (id ? api.patch(`/api/materials/${id}`, body).then(() => ({ id })) : api.post('/api/materials', body)), id ? 'Material saved' : 'Material created');
    if (r) onSaved(r.id);
  };
  return (
    <Modal title={id ? 'Edit material' : 'Add material'} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" disabled={busy || !f.code || !f.name} onClick={save}>Save</Button></>}>
      <div className="form-grid">
        <Field label="Code (unique)"><input className="input" value={f.code} onChange={(e) => set('code', e.target.value)} /></Field>
        <Field label="Name"><input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="Category"><select className="input" value={f.category} onChange={(e) => set('category', e.target.value)}>{Object.entries(CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Base (costing) unit" hint={hasPrices ? 'Locked: prices exist in this unit.' : 'Prices are calculated per this unit.'}>
          <select className="input" value={f.baseUnit} disabled={hasPrices} onChange={(e) => set('baseUnit', e.target.value)}><option value="kg">kg</option><option value="L">L</option><option value="pc">piece</option></select>
        </Field>
        <Field label="Supplier"><input className="input" value={f.supplier ?? ''} onChange={(e) => set('supplier', e.target.value)} /></Field>
        <Field label="Supplier product code"><input className="input" value={f.supplierCode ?? ''} onChange={(e) => set('supplierCode', e.target.value)} /></Field>
        <Field label="Density (kg/L)" hint="Required to convert between mass and volume. Never assumed."><NumInput value={f.densityKgPerL} onChange={(v) => set('densityKgPerL', v)} /></Field>
        <Field label="Purity (%)" hint="Stored for reference; not applied to cost."><NumInput value={f.purityPct} onChange={(v) => set('purityPct', v)} /></Field>
        <Field label="Allergen information" wide><input className="input" value={f.allergenInfo ?? ''} onChange={(e) => set('allergenInfo', e.target.value)} /></Field>
        <Field label="Notes" wide><textarea className="input" value={f.notes ?? ''} onChange={(e) => set('notes', e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

function MaterialDetail({ id, onChanged, onClose }: { id: number; onChanged: () => void; onClose: () => void }) {
  const { can } = useAuth();
  const nav = useNavigate();
  const confirm = useConfirm();
  const { data: m, error, reload } = useLoad<any>(`/api/materials/${id}`);
  const [tab, setTab] = useState('prices');
  const [editing, setEditing] = useState(false);
  const [addingPrice, setAddingPrice] = useState(false);
  const { run } = useAction();
  useEffect(() => { setTab(can('materials.prices') ? 'prices' : 'details'); setAddingPrice(false); }, [id, can]);
  if (!m) return <Card><Loading error={error} /></Card>;
  const refresh = () => { reload(); onChanged(); };
  return (
    <Card title={<span className="row" style={{ gap: 6 }}>{m.name} {m.reviewStatus === 'needs_review' && <StatusBadge status="needs_review" />}{m.archived && <Badge>Archived</Badge>}</span>}
      actions={<button className="icon-btn" onClick={onClose} aria-label="Close">×</button>}>
      <div className="row" style={{ marginBottom: 12, gap: 6 }}>
        {can('materials.write') && <>
          <Button size="sm" onClick={() => setEditing(true)}>Edit</Button>
          <Button size="sm" onClick={async () => { const r = await run(() => api.post(`/api/materials/${id}/duplicate`), 'Duplicated (prices are not copied)'); if (r) { onChanged(); nav(`/materials/${r.id}`); } }}>Duplicate</Button>
          <Button size="sm" kind={m.archived ? 'default' : 'danger'} onClick={async () => {
            if (!m.archived && !(await confirm({ title: `Archive ${m.name}?`, danger: true, confirmText: 'Archive', body: <>Archived materials are hidden from pickers. {m.usedBy.length ? <Alert tone="warn">Still used by: {m.usedBy.map((u: any) => u.product_name).join(', ')}. Existing recipes keep working.</Alert> : 'It is not used in any active recipe.'}</> }))) return;
            if (await run(() => api.post(`/api/materials/${id}/archive`, { archived: !m.archived }), m.archived ? 'Restored' : 'Archived')) refresh();
          }}>{m.archived ? 'Restore' : 'Archive'}</Button>
          {m.reviewStatus === 'needs_review' && <Button size="sm" kind="primary" onClick={async () => {
            if (await confirm({ title: 'Mark as reviewed?', body: <>Confirm you have checked these items:<pre className="raw">{m.reviewNotes}</pre></>, confirmText: 'Mark reviewed' }) && await run(() => api.post(`/api/materials/${id}/review`, { status: 'ok' }), 'Marked as reviewed')) refresh();
          }}>Mark reviewed</Button>}
        </>}
      </div>
      {m.reviewStatus === 'needs_review' && m.reviewNotes && <Alert tone="warn"><strong>Needs review</strong><ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{m.reviewNotes.split('\n').map((n: string, i: number) => <li key={i}>{n}</li>)}</ul></Alert>}
      <Tabs value={tab} onChange={setTab} tabs={[...(can('materials.prices') ? [{ id: 'prices', label: 'Prices' }] : []), { id: 'details', label: 'Details' }, { id: 'usage', label: `Used in (${m.usedBy.length})` }, ...(m.importOriginal ? [{ id: 'import', label: 'Imported data' }] : [])]} />
      {tab === 'prices' && (
        <div className="stack" style={{ gap: 12 }}>
          {m.currentPrice ? (
            <div className="row-between">
              <div><div className="muted small">Current landed price (effective {date(m.currentPrice.effectiveDate)})</div><div className="big-number">{num(m.currentPrice.landedUnitPriceSek, 4)} <span className="small muted">SEK/{m.baseUnit}</span></div></div>
              {can('materials.write') && !addingPrice && <Button kind="primary" onClick={() => setAddingPrice(true)}>New price</Button>}
            </div>
          ) : (
            <Alert tone="warn">No current price. Recipes using this material show as incomplete; it is never treated as zero. {can('materials.write') && !addingPrice && <Button size="sm" kind="primary" onClick={() => setAddingPrice(true)}>Enter price</Button>}</Alert>
          )}
          {addingPrice && <PriceForm material={m} onDone={() => { setAddingPrice(false); refresh(); }} onCancel={() => setAddingPrice(false)} />}
          <h4>Price history</h4>
          {m.priceHistory.length === 0 ? <span className="muted small">No prices recorded.</span> : (
            <div className="table-wrap"><table className="table compact">
              <thead><tr><th>Effective</th><th>Entered as</th><th className="num">Landed SEK/{m.baseUnit}</th><th>Source</th></tr></thead>
              <tbody>{m.priceHistory.map((p: any) => (
                <tr key={p.id} style={m.currentPrice?.id === p.id ? { fontWeight: 600 } : undefined}>
                  <td className="nowrap">{p.undated ? <Badge>undated</Badge> : date(p.effective_date)}{p.effective_date > todayIso() && <Badge tone="info">future</Badge>}</td>
                  <td className="small">{p.entry_mode === 'per_pack' ? `${num(p.price)} ${p.currency} per ${num(p.pack_qty)} ${p.pack_unit} pack` : `${num(p.price)} ${p.currency}/${m.baseUnit}`}{p.currency !== 'SEK' && <div className="muted">rate {num(p.exchange_rate, 6)}{p.rate_date ? ` (${p.rate_date})` : ' (rate date unknown)'}</div>}{p.charges_sek !== '0' && <div className="muted">+ {num(p.charges_sek)} SEK charges</div>}</td>
                  <td className="num">{num(p.landed_unit_price_sek, 4)}</td>
                  <td className="small">{p.source}{p.created_by_name ? ` · ${p.created_by_name}` : ''}<div className="muted">{dateTime(p.created_at)}</div></td>
                </tr>))}</tbody>
            </table></div>
          )}
        </div>
      )}
      {tab === 'details' && (
        <dl className="kv">
          <dt>Code</dt><dd>{m.code}</dd><dt>Category</dt><dd>{CATEGORY_LABELS[m.category]}</dd><dt>Base unit</dt><dd>{m.baseUnit}</dd>
          <dt>Supplier</dt><dd>{m.supplier ?? '—'} {m.supplierCode && <span className="muted">({m.supplierCode})</span>}</dd>
          <dt>Density</dt><dd>{m.densityKgPerL ? `${m.densityKgPerL} kg/L` : <span className="muted">not set (mass↔volume conversions blocked)</span>}</dd>
          <dt>Purity</dt><dd>{m.purityPct ? pct(m.purityPct, 2) : '—'}</dd><dt>Allergens</dt><dd>{m.allergenInfo ?? '—'}</dd>
          <dt>Notes</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{m.notes ?? '—'}</dd><dt>Updated</dt><dd>{dateTime(m.updatedAt)}</dd>
        </dl>
      )}
      {tab === 'usage' && (m.usedBy.length === 0 ? <Empty title="Not used in any active recipe or packaging" /> : (
        <table className="table compact"><tbody>{m.usedBy.map((u: any, i: number) => <tr key={i}><td><Link to={`/recipes/${u.product_id}${u.recipe_version_id ? `?v=${u.recipe_version_id}` : ''}`}>{u.product_name}</Link></td><td className="small">{u.usage}{u.version_no ? ` · v${u.version_no}` : ''}</td><td>{u.status && <StatusBadge status={u.status} />}</td></tr>)}</tbody></table>
      ))}
      {tab === 'import' && <><p className="muted small">Original values from the source file, kept unchanged.</p><table className="table compact"><tbody>{Object.entries(m.importOriginal).map(([k, v]) => <tr key={k}><td className="muted">{k}</td><td>{String(v) || <span className="muted">(empty)</span>}</td></tr>)}</tbody></table></>}
      {editing && <MaterialForm id={id} hasPrices={m.priceHistory?.length > 0} initial={{ ...emptyMaterial, ...m, supplier: m.supplier ?? '', supplierCode: m.supplierCode ?? '', densityKgPerL: m.densityKgPerL ?? '', purityPct: m.purityPct ?? '' }} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); refresh(); }} />}
    </Card>
  );
}

function PriceForm({ material, onDone, onCancel }: { material: any; onDone: () => void; onCancel: () => void }) {
  const [f, setF] = useState<any>({ effectiveDate: todayIso(), entryMode: 'per_unit', packQty: '', packUnit: material.baseUnit === 'pc' ? 'pc' : material.baseUnit, price: '', currency: 'SEK', exchangeRate: '', rateDate: todayIso(), rateSource: '', chargesSek: '', notes: '' });
  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  const { run, busy } = useAction();
  const [impact, setImpact] = useState<any[] | null>(null);
  const live = landedUnitPrice({ ...f, chargesSek: f.chargesSek || '0' }, material.baseUnit, material.densityKgPerL);
  useEffect(() => {
    setImpact(null);
    if (!live.ok) return;
    const t = setTimeout(() => api.post(`/api/materials/${material.id}/prices/preview`, body()).then((r) => setImpact(r.impact)).catch(() => {}), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(f)]);
  const body = () => ({ ...f, packQty: f.entryMode === 'per_pack' ? f.packQty : '', packUnit: f.entryMode === 'per_pack' ? f.packUnit : null, exchangeRate: f.currency === 'SEK' ? '1' : f.exchangeRate, rateDate: f.currency === 'SEK' ? null : f.rateDate || null, chargesSek: f.chargesSek || '0', notes: f.notes || null, rateSource: f.rateSource || null });
  return (
    <div className="card" style={{ background: 'var(--surface-2)' }}>
      <div className="card-body stack" style={{ gap: 12 }}>
        <div className="row"><strong>New price</strong><span className="muted small">Adds to history; earlier records keep their own prices.</span></div>
        <div className="row">
          <label className="check"><input type="radio" checked={f.entryMode === 'per_unit'} onChange={() => set('entryMode', 'per_unit')} /> Price per {material.baseUnit}</label>
          <label className="check"><input type="radio" checked={f.entryMode === 'per_pack'} onChange={() => set('entryMode', 'per_pack')} /> Price per purchase pack</label>
        </div>
        <div className="form-grid">
          {f.entryMode === 'per_pack' && <>
            <Field label="Pack quantity"><NumInput value={f.packQty} onChange={(v) => set('packQty', v)} /></Field>
            <Field label="Pack unit"><select className="input" value={f.packUnit} onChange={(e) => set('packUnit', e.target.value)}>{['g', 'kg', 'mL', 'L', 'pc'].map((u) => <option key={u}>{u}</option>)}</select></Field>
          </>}
          <Field label={f.entryMode === 'per_pack' ? 'Pack price' : `Price per ${material.baseUnit}`}><NumInput value={f.price} onChange={(v) => set('price', v)} /></Field>
          <Field label="Currency"><input className="input" value={f.currency} maxLength={3} onChange={(e) => set('currency', e.target.value.toUpperCase())} /></Field>
          {f.currency !== 'SEK' && <>
            <Field label={`Rate (SEK per 1 ${f.currency})`}><NumInput value={f.exchangeRate} onChange={(v) => set('exchangeRate', v)} /></Field>
            <Field label="Rate date"><input type="date" className="input" value={f.rateDate} onChange={(e) => set('rateDate', e.target.value)} /></Field>
          </>}
          <Field label={`Freight & other charges (SEK per ${f.entryMode === 'per_pack' ? 'pack' : material.baseUnit})`}><NumInput value={f.chargesSek} onChange={(v) => set('chargesSek', v)} placeholder="0" /></Field>
          <Field label="Effective date"><input type="date" className="input" value={f.effectiveDate} onChange={(e) => set('effectiveDate', e.target.value)} /></Field>
          <Field label="Notes" wide><input className="input" value={f.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Invoice no., quote reference…" /></Field>
        </div>
        {live.ok ? <Alert tone="ok">Landed cost: <strong>{num(live.landed, 4)} SEK/{material.baseUnit}</strong><div className="formula">{live.formula}</div></Alert> : f.price && <Alert tone="warn">{live.error}</Alert>}
        {impact && impact.length > 0 && (
          <div><h4>Effect on current estimates</h4>
            <table className="table compact"><thead><tr><th>Product</th><th className="num">Unit cost now → new</th><th className="num">Margin at set price</th></tr></thead>
              <tbody>{impact.flatMap((p: any) => (p.rows ?? []).map((r: any, i: number) => (
                <tr key={`${p.productId}-${i}`}><td>{p.productName}<span className="muted small"> per {r.unit}</span></td>
                  <td className="num nowrap">{sek(r.unitCostBefore)} → <strong>{sek(r.unitCostAfter)}</strong></td>
                  <td className="num nowrap">{r.approvedPrice ? <>{pct(r.marginBefore)} → <strong>{pct(r.marginAfter)}</strong></> : <span className="muted">no approved price</span>}</td></tr>)))}</tbody></table>
            <div className="muted small">Approved quotations, completed batches and earlier recipe versions keep their saved snapshots.</div>
          </div>
        )}
        <div className="row"><Button kind="primary" disabled={busy || !live.ok} onClick={async () => { if (await run(() => api.post(`/api/materials/${material.id}/prices`, body()), 'Price saved')) onDone(); }}>Save price</Button><Button onClick={onCancel}>Cancel</Button></div>
      </div>
    </div>
  );
}
