import React, { useMemo, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../auth';
import { Badge, Button, Card, Empty, Loading, NumInput, PageHeader, SearchInput, StatusBadge, useLoad } from '../ui';
import { ProductCostChart } from '../components';
import { date, dateTime, num, pct, sek } from '../format';
import { Decimal, dec } from '../../../shared/decimal';
import { marginPct, priceForMargin } from '../../../shared/pricing';

export default function Overview() {
  const { can, user } = useAuth();
  const nav = useNavigate();
  const { data, error } = useLoad<any>('/api/dashboard');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'incomplete' | 'below' | 'review'>('all');
  if (!data) return <Loading error={error} />;

  const products: any[] = data.products ?? [];
  const below = products.filter((p) => p.prices?.some((r: any) => r.belowTarget));
  const incomplete = products.filter((p) => p.estimate && !p.estimate.complete);
  const reviewCount = (data.review?.materials.length ?? 0) + (data.review?.recipes.length ?? 0) + (data.review?.packaging.length ?? 0);
  const filtered = products.filter((p) => (!search || p.name.toLowerCase().includes(search.toLowerCase()))
    && (filter === 'all' || (filter === 'incomplete' && p.estimate && !p.estimate.complete) || (filter === 'below' && below.includes(p)) || (filter === 'review' && p.version?.reviewStatus === 'needs_review')));

  return (
    <div>
      <PageHeader title="Overview" subtitle={`Signed in as ${user.name}. Figures are calculated live from current material prices and recipes; nothing here is invented sales or revenue data.`}
        actions={<>
          {can('materials.write') && <Button onClick={() => nav('/materials?new=1')}>Add material</Button>}
          {can('recipes.write') && <Button onClick={() => nav('/recipes?new=1')}>Create recipe</Button>}
          {can('costs.read') && <Button kind="primary" onClick={() => nav('/calculator')}>Calculate a batch</Button>}
        </>} />

      <div className="kpis">
        {data.counts && <button className="kpi" onClick={() => nav('/recipes')}><div className="kpi-label">Active products</div><div className="kpi-value">{data.counts.products}</div><div className="kpi-note">{data.counts.recipeVersions} recipe versions · {data.counts.approvedRecipes} approved</div></button>}
        {data.counts && can('materials.read') && <button className="kpi" onClick={() => nav('/materials')}><div className="kpi-label">Materials &amp; packaging</div><div className="kpi-value">{data.counts.materials}</div><div className="kpi-note">active items</div></button>}
        {data.missingPrices && <button className={`kpi ${data.missingPrices.length ? 'kpi-err' : ''}`} onClick={() => nav('/materials?filter=missing')}><div className="kpi-label">Materials in use without price</div><div className="kpi-value">{data.missingPrices.length}</div><div className="kpi-note">never costed as zero</div></button>}
        {data.products && <button className={`kpi ${incomplete.length ? 'kpi-warn' : ''}`} onClick={() => setFilter('incomplete')}><div className="kpi-label">Incomplete costings</div><div className="kpi-value">{incomplete.length}</div><div className="kpi-note">products with missing values</div></button>}
        {data.review && <button className={`kpi ${reviewCount ? 'kpi-warn' : ''}`} onClick={() => document.getElementById('review')?.scrollIntoView({ behavior: 'smooth' })}><div className="kpi-label">Records needing review</div><div className="kpi-value">{reviewCount}</div><div className="kpi-note">imports and flagged items</div></button>}
        {can('pricing.read') && <button className={`kpi ${below.length ? 'kpi-err' : ''}`} onClick={() => setFilter('below')}><div className="kpi-label">Below target margin</div><div className="kpi-value">{below.length}</div><div className="kpi-note">at current costs vs. set prices</div></button>}
        {data.recentQuotations && <button className="kpi" onClick={() => nav('/quotations')}><div className="kpi-label">Quotations</div><div className="kpi-value">{data.recentQuotations.length}</div><div className="kpi-note">most recent shown below</div></button>}
      </div>

      {data.products && (
        <div className="stack">
          <Card title="Products" actions={<>
            <SearchInput value={search} onChange={setSearch} placeholder="Search products…" />
            <select className="input" style={{ width: 'auto' }} value={filter} onChange={(e) => setFilter(e.target.value as any)}>
              <option value="all">All products</option><option value="incomplete">Incomplete costing</option>
              {can('pricing.read') && <option value="below">Below target margin</option>}<option value="review">Recipe needs review</option>
            </select></>} pad={false}>
            {products.length === 0 ? <Empty title="No products yet" action={can('imports.run') ? <Button kind="primary" onClick={() => nav('/imports')}>Import Batchworks files</Button> : undefined}>Create a recipe or import your Batchworks exports to see production costs here.</Empty> : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Product</th><th>Recipe</th><th className="num">Est. cost / unit</th><th className="num">Default batch</th>{can('pricing.read') && <th className="num">Target margin</th>}<th>Selling prices (excl. VAT)</th><th></th></tr></thead>
                  <tbody>
                    {filtered.map((p) => (
                      <tr key={p.id} className="clickable" onClick={() => nav(`/recipes/${p.id}`)}>
                        <td><strong>{p.name}</strong><div className="muted small">{p.code}</div></td>
                        <td>{p.version ? <span className="row" style={{ gap: 4 }}>v{p.version.versionNo} <StatusBadge status={p.version.status} />{p.version.reviewStatus === 'needs_review' && <StatusBadge status="needs_review" />}</span> : '—'}</td>
                        <td className="num"><span className="tag-est">{sek(p.estimate?.costPerOutputUnit)}</span><span className="muted small"> /{p.outputUnit}</span>{p.estimate && !p.estimate.complete && <div><Badge tone="warn">Incomplete</Badge></div>}</td>
                        <td className="num">{num(p.estimate?.batchQty)} {p.outputUnit}</td>
                        {can('pricing.read') && <td className="num">{p.targetMarginPct ? pct(p.targetMarginPct) : <span className="muted">not set</span>}</td>}
                        <td>
                          {!p.prices?.length && <span className="muted small">No proposed or approved price</span>}
                          {p.prices?.slice(0, 3).map((r: any) => (
                            <div key={r.id} className="small nowrap">
                              <Badge tone={r.status === 'approved' ? 'ok' : 'info'}>{r.status === 'approved' ? 'Approved' : 'Proposed'}</Badge>{' '}
                              {sek(r.price)}/{r.priceUnit === 'package' ? r.packagingName ?? 'package' : p.outputUnit}{r.minQty !== '1' ? ` (≥${num(r.minQty)})` : ''}
                              {r.currentMarginPct != null && <span className={r.belowTarget ? 'w-error' : 'muted'}> · margin {pct(r.currentMarginPct)}</span>}
                            </div>
                          ))}
                        </td>
                        <td className="nowrap" onClick={(e) => e.stopPropagation()}>{p.version && can('costs.read') && <Link to={`/calculator?versionId=${p.version.id}`}>Calculate</Link>}</td>
                      </tr>
                    ))}
                    {filtered.length === 0 && <tr><td colSpan={7}><Empty title="No products match this filter" /></td></tr>}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {products.some((p) => p.estimate) && (
            <div className="grid-main-side">
              <Card title="Estimated production cost per sellable unit, by cost type" actions={<span className="muted small">Click a bar to open the recipe. * incomplete</span>}>
                <ProductCostChart unitLabel="SEK per L/kg"
                  onSelect={(id) => nav(`/recipes/${id}`)}
                  rows={filtered.filter((p) => p.estimate?.costPerOutputUnit && p.estimate.totalBatchCost !== '0').map((p) => {
                    const f = new Decimal(p.estimate.costPerOutputUnit).div(p.estimate.totalBatchCost);
                    return { id: p.id, name: p.name, complete: p.estimate.complete, sections: Object.fromEntries(Object.entries(p.estimate.sections as Record<string, string>).map(([k, v]) => [k, f.times(v).toFixed(4)])) };
                  })} />
              </Card>
              {can('pricing.read') ? <ScenarioPanel products={products} /> : <Card title="Scenarios"><span className="muted">Pricing scenarios are available to administrators.</span></Card>}
            </div>
          )}
        </div>
      )}

      <div className="grid-2" style={{ marginTop: 16 }}>
        {data.recentPriceChanges && (
          <Card title="Recent material price changes" pad={false} actions={<Link to="/materials">All materials</Link>}>
            {data.recentPriceChanges.length === 0 ? <Empty title="No prices recorded yet" /> : (
              <table className="table compact"><thead><tr><th>Material</th><th>Effective</th><th className="num">Previous</th><th className="num">New</th><th className="num">Change</th></tr></thead>
                <tbody>{data.recentPriceChanges.map((r: any) => {
                  const ch = r.previous ? dec(r.landed_unit_price_sek)!.minus(r.previous).div(r.previous).times(100) : null;
                  return (<tr key={r.id} className="clickable" onClick={() => nav(`/materials/${r.material_id}`)}>
                    <td>{r.name}</td><td className="nowrap">{date(r.effective_date)}</td><td className="num muted">{r.previous ? num(r.previous, 2) : '—'}</td>
                    <td className="num">{num(r.landed_unit_price_sek, 2)} <span className="muted small">SEK/{r.base_unit}</span></td>
                    <td className="num">{ch ? <span className={ch.gt(0) ? 'w-error' : 'tag-act'}>{ch.gt(0) ? '+' : ''}{ch.toFixed(1)} %</span> : '—'}</td></tr>);
                })}</tbody></table>
            )}
          </Card>
        )}
        {data.missingPrices && (
          <Card title="Missing prices (materials used in active products)" pad={false}>
            {data.missingPrices.length === 0 ? <Empty title="Every material in use has a price" /> : (
              <table className="table compact"><thead><tr><th>Material</th><th>Used in</th></tr></thead>
                <tbody>{data.missingPrices.map((m: any) => <tr key={m.id} className="clickable row-missing" onClick={() => nav(`/materials/${m.id}`)}><td>{m.name}</td><td className="small">{m.products.join(', ')}</td></tr>)}</tbody></table>
            )}
          </Card>
        )}
        {data.review && (
          <div id="review"><Card title="Records requiring review" pad={false}>
            {reviewCount === 0 ? <Empty title="Nothing waiting for review" /> : (
              <table className="table compact"><tbody>
                {data.review.recipes.map((r: any) => <tr key={`r${r.id}`} className="clickable" onClick={() => nav(`/recipes/${r.product_id}?v=${r.id}`)}><td><Badge tone="warn">Recipe</Badge></td><td>{r.product_name} v{r.version_no}</td><td className="small muted">{(r.review_notes ?? '').split('\n')[0]}</td></tr>)}
                {data.review.packaging.map((r: any) => <tr key={`p${r.id}`} className="clickable" onClick={() => nav(`/recipes/${r.product_id}?tab=packaging`)}><td><Badge tone="warn">Packaging</Badge></td><td>{r.product_name}: {r.name}</td><td className="small muted">Fill or quantity per package unconfirmed</td></tr>)}
                {data.review.materials.map((m: any) => <tr key={`m${m.id}`} className="clickable" onClick={() => nav(`/materials/${m.id}`)}><td><Badge tone="warn">Material</Badge></td><td>{m.name}</td><td className="small muted">{(m.review_notes ?? '').split('\n')[0]}</td></tr>)}
              </tbody></table>
            )}
          </Card></div>
        )}
        {data.recentCostings && (
          <Card title="Recent saved costings" pad={false}>
            {data.recentCostings.length === 0 ? <Empty title="No saved costings yet">Save one from the batch calculator.</Empty> : (
              <table className="table compact"><thead><tr><th>Saved</th><th>Product</th><th>Type</th><th className="num">Cost / unit</th></tr></thead>
                <tbody>{data.recentCostings.map((c: any) => <tr key={c.id} className="clickable" onClick={() => nav(`/calculator?costingId=${c.id}`)}><td className="nowrap small">{dateTime(c.created_at)}</td><td>{c.product_name} v{c.version_no}</td><td className="small">{c.kind.replace('_', ' ')}</td><td className="num">{sek(c.cost_per_package ?? c.cost_per_output_unit)}{!c.complete && <Badge tone="warn">Incomplete</Badge>}</td></tr>)}</tbody></table>
            )}
          </Card>
        )}
        {data.recentQuotations && (
          <Card title="Recent quotations" pad={false} actions={can('quotations.write') && <Button size="sm" onClick={() => nav('/quotations/new')}>New quotation</Button>}>
            {data.recentQuotations.length === 0 ? <Empty title="No quotations yet" /> : (
              <table className="table compact"><thead><tr><th>Number</th><th>Customer</th><th>Date</th><th>Status</th></tr></thead>
                <tbody>{data.recentQuotations.map((q: any) => <tr key={q.id} className="clickable" onClick={() => nav(`/quotations/${q.id}`)}><td>{q.number}</td><td>{q.customer_name}</td><td>{date(q.quote_date)}</td><td><StatusBadge status={q.status} /></td></tr>)}</tbody></table>
            )}
          </Card>
        )}
        {data.approvedPrices && (
          <Card title="Approved selling prices" pad={false}>
            {data.approvedPrices.length === 0 ? <Empty title="No approved prices yet" /> : (
              <table className="table compact"><thead><tr><th>Product</th><th>Customer</th><th className="num">Price excl. VAT</th></tr></thead>
                <tbody>{data.approvedPrices.map((p: any) => <tr key={p.id}><td>{p.product_name}<div className="muted small">{p.packaging_name ?? 'bulk'}{p.min_qty !== '1' ? ` · from ${p.min_qty}` : ''}</div></td><td>{p.customer_name ?? 'All customers'}</td><td className="num">{sek(p.price)}</td></tr>)}</tbody></table>
            )}
          </Card>
        )}
        {data.batches && (
          <Card title="Recent production batches" pad={false} actions={<Link to="/batches">All batches</Link>}>
            {data.batches.length === 0 ? <Empty title="No production batches recorded" /> : (
              <table className="table compact"><tbody>{data.batches.map((b: any) => <tr key={b.id} className="clickable" onClick={() => nav(`/batches/${b.id}`)}><td>{b.batch_number}</td><td>{b.product_name}</td><td className="num">{num(b.actual_output_qty ?? b.planned_qty)} {b.output_unit}</td><td><StatusBadge status={b.status} /></td></tr>)}</tbody></table>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}

/** Quick what-if: how ingredient cost, yield and margin changes move unit cost and price. */
function ScenarioPanel({ products }: { products: any[] }) {
  const usable = products.filter((p) => p.estimate?.costPerOutputUnit);
  const [pid, setPid] = useState<number | null>(usable[0]?.id ?? null);
  const [ingChange, setIngChange] = useState('10');
  const [yieldPct, setYieldPct] = useState('95');
  const [margin, setMargin] = useState('');
  const p = usable.find((x) => x.id === pid);
  const calc = useMemo(() => {
    if (!p) return null;
    const total = dec(p.estimate.totalBatchCost)!;
    const ing = dec(p.estimate.sections.ingredients) ?? new Decimal(0);
    const baseCpu = dec(p.estimate.costPerOutputUnit)!;
    const sellable = total.div(baseCpu);
    const ic = dec(ingChange) ?? new Decimal(0);
    const y = dec(yieldPct);
    const newTotal = total.plus(ing.times(ic).div(100));
    // Yield scenario assumes the current estimate is at its recipe yield; output scales with the yield ratio vs. 100%.
    const baseYield = sellable.div(dec(p.estimate.batchQty)!).times(100);
    const newSellable = y && y.gt(0) && y.lte(100) ? sellable.times(y).div(baseYield) : sellable;
    const cpu = newTotal.div(newSellable);
    const m = margin || p.targetMarginPct || '';
    const price = m ? priceForMargin(cpu, m) : null;
    return { baseCpu, cpu, baseYield, price, m, current: p.prices?.find((r: any) => r.status === 'approved' && r.priceUnit !== 'package') };
  }, [p, ingChange, yieldPct, margin]);
  return (
    <Card title="Scenario panel" actions={<Link to="/pricing?tab=scenarios">Full scenarios</Link>}>
      {!p ? <span className="muted">No costed products yet.</span> : (
        <div className="stack" style={{ gap: 10 }}>
          <select className="input" value={pid ?? ''} onChange={(e) => setPid(Number(e.target.value))}>{usable.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
          <div className="grid-3" style={{ gap: 8 }}>
            <label className="field"><span className="field-label">Ingredient prices %</span><NumInput value={ingChange} onChange={setIngChange} /></label>
            <label className="field"><span className="field-label">Yield %</span><NumInput value={yieldPct} onChange={setYieldPct} /></label>
            <label className="field"><span className="field-label">Margin %</span><NumInput value={margin} onChange={setMargin} placeholder={p.targetMarginPct ?? ''} /></label>
          </div>
          {calc && (
            <div className="summary-list small">
              <span className="lbl">Current est. cost / {p.outputUnit} (yield {num(calc.baseYield, 1)} %)</span><span className="val">{sek(calc.baseCpu)}</span>
              <span className="lbl">Scenario cost / {p.outputUnit}</span><span className="val"><strong>{sek(calc.cpu)}</strong></span>
              <span className="lbl">Price for {calc.m ? `${calc.m} %` : '—'} gross margin</span><span className="val">{calc.price?.ok ? sek(calc.price.value) : <span className="muted">{calc.price && !calc.price.ok ? calc.price.error : 'enter a margin'}</span>}</span>
              {calc.current && <><span className="lbl">Margin at approved {sek(calc.current.price)}</span><span className="val">{(() => { const r = marginPct(calc.current.price, calc.cpu); return r.ok ? pct(r.value) : '—'; })()}</span></>}
            </div>
          )}
          <span className="muted small">Bulk (unpackaged) estimate. Experimental only: nothing is saved or applied.</span>
        </div>
      )}
    </Card>
  );
}
