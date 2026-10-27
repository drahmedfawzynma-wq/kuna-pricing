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

  const belowNow = products.filter((p) => p.prices?.some((r: any) => r.status === 'approved' && (r.actualMarginPct != null ? r.belowTargetActual : r.belowTarget)));
  const locked: any[] = data.lockedBatches ?? [];
  const lockedUp = locked.filter((b) => b.est_cpu && b.act_cpu && dec(b.act_cpu)!.gt(b.est_cpu));
  const partnerOpen: any[] = data.partnerBatches ?? [];
  const changes90: any[] = data.priceChanges90 ?? [];
  const toProducts = () => document.getElementById('products')?.scrollIntoView({ behavior: 'smooth' });

  return (
    <div>
      <PageHeader title="Dashboard" subtitle={`Signed in as ${user.name}. Estimates are calculated live from current prices and approved recipes; actual figures come from cost-locked batches. Nothing here is invented sales data.`}
        actions={<>
          {can('materials.write') && <Button onClick={() => nav('/materials?new=1')}>Add material</Button>}
          {can('recipes.write') && <Button onClick={() => nav('/recipes?new=1')}>Create recipe</Button>}
          {can('costs.read') && <Button kind="primary" onClick={() => nav('/calculator')}>Calculate a batch</Button>}
        </>} />

      <div className="kpis">
        {can('pricing.read') && data.products && <button className={`kpi ${belowNow.length ? 'kpi-err' : ''}`} onClick={() => { setFilter('below'); toProducts(); }}><div className="kpi-label">Below target margin</div><div className="kpi-value">{belowNow.length}{products.length ? <span className="muted small"> of {products.length}</span> : null}</div><div className="kpi-note">approved prices at latest actual cost (estimate if no batch yet)</div></button>}
        {data.products && <button className={`kpi ${incomplete.length ? 'kpi-warn' : ''}`} onClick={() => { setFilter('incomplete'); toProducts(); }}><div className="kpi-label">Incomplete costings</div><div className="kpi-value">{incomplete.length}</div><div className="kpi-note">{incomplete.length ? incomplete.slice(0, 2).map((p) => p.name).join(', ') : 'all products fully costed'}</div></button>}
        {data.lockedBatches && <button className={`kpi ${lockedUp.length ? 'kpi-warn' : ''}`} onClick={() => document.getElementById('recent-batches')?.scrollIntoView({ behavior: 'smooth' })}><div className="kpi-label">Actual cost above estimate</div><div className="kpi-value">{lockedUp.length}{locked.length ? <span className="muted small"> of {locked.length}</span> : null}</div><div className="kpi-note">{locked.length ? `last ${locked.length} cost-locked batches` : 'no cost-locked batches yet'}</div></button>}
        {data.priceChanges90 && <button className="kpi" onClick={() => document.getElementById('price-changes')?.scrollIntoView({ behavior: 'smooth' })}><div className="kpi-label">Material prices changed, 90 days</div><div className="kpi-value">{changes90.length}</div><div className="kpi-note">{changes90.length ? changes90.slice(0, 2).map((m) => m.name).join(', ') : 'no dated price changes'}</div></button>}
        {data.partnerBatches && <button className={`kpi ${partnerOpen.length ? 'kpi-info' : ''}`} onClick={() => nav('/outsourced')}><div className="kpi-label">Batches at partners</div><div className="kpi-value">{partnerOpen.length}</div><div className="kpi-note">{partnerOpen.length ? partnerOpen.slice(0, 2).map((b) => `${b.batch_number} ${b.partner_name}`).join(', ') : 'none open'}</div></button>}
        {data.missingPrices && <button className={`kpi ${data.missingPrices.length ? 'kpi-err' : ''}`} onClick={() => nav('/materials?filter=missing')}><div className="kpi-label">Materials in use without price</div><div className="kpi-value">{data.missingPrices.length}</div><div className="kpi-note">never costed as zero</div></button>}
        {data.review && <button className={`kpi ${reviewCount ? 'kpi-warn' : ''}`} onClick={() => document.getElementById('review')?.scrollIntoView({ behavior: 'smooth' })}><div className="kpi-label">Records needing review</div><div className="kpi-value">{reviewCount}</div><div className="kpi-note">imports and flagged items</div></button>}
        {!data.products && data.counts && <button className="kpi" onClick={() => nav('/recipes')}><div className="kpi-label">Active products</div><div className="kpi-value">{data.counts.products}</div><div className="kpi-note">{data.counts.approvedRecipes} approved recipe versions</div></button>}
        {!data.products && data.recentQuotations && <button className="kpi" onClick={() => nav('/quotations')}><div className="kpi-label">Quotations</div><div className="kpi-value">{data.recentQuotations.length}</div><div className="kpi-note">most recent shown below</div></button>}
      </div>

      {data.products && products.some((p) => p.estimate?.costPerOutputUnit) && <StandardVsActual products={products} pricing={can('pricing.read')} />}

      {(data.products || data.batches) && (
        <div className="grid-main-side" style={{ marginBottom: 16 }}>
          {data.batches && <div id="recent-batches"><RecentBatches batches={data.batches} costs={can('costs.read')} /></div>}
          <Attention data={data} below={belowNow} incomplete={incomplete} reviewCount={reviewCount} pricing={can('pricing.read')} />
        </div>
      )}

      {data.products && (
        <div className="stack" id="products">
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
          <div id="price-changes"><Card title="Recent material price changes" pad={false} actions={<Link to="/materials">All materials</Link>}>
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
          </Card></div>
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

/** Standard estimate vs latest actual batch, per product, with a detail panel for the selected product. */
function StandardVsActual({ products, pricing }: { products: any[]; pricing: boolean }) {
  const nav = useNavigate();
  const rows = products.filter((p) => p.estimate?.costPerOutputUnit);
  const [sel, setSel] = useState<number | null>(() => (rows.find((p) => p.latestActual) ?? rows[0])?.id ?? null);
  const max = rows.reduce((m, p) => Decimal.max(m, dec(p.estimate.costPerOutputUnit) ?? 0, dec(p.latestActual?.costPerOutputUnit) ?? 0), new Decimal(0));
  const w = (v: unknown) => (dec(v as any) && max.gt(0) ? dec(v as any)!.div(max).times(100).toFixed(1) : '0');
  const p = rows.find((x) => x.id === sel) ?? rows[0];
  const bulk = p?.prices?.find((r: any) => r.status === 'approved' && r.priceUnit !== 'package');
  return (
    <div className="dash-grid" style={{ marginBottom: 16 }}>
      <Card title={<span>Cost per L/kg: standard estimate vs latest actual batch</span>} actions={<span className="legend"><span><i className="bar-est" />Standard estimate</span><span><i className="bar-act" />Latest actual</span></span>}>
        <div className="muted small" style={{ marginBottom: 6 }}>Click a product to see its margin and what each figure is based on. * incomplete costing</div>
        <div className="dual">
          {rows.map((r) => {
            const est = dec(r.estimate.costPerOutputUnit)!;
            const act = dec(r.latestActual?.costPerOutputUnit);
            const d = act ? act.minus(est).div(est).times(100) : null;
            return (
              <button key={r.id} className={`dual-row ${r.id === p?.id ? 'on' : ''}`} onClick={() => setSel(r.id)}>
                <span className="dual-name" title={r.name}>{r.name.replace(/ Concentrate$/, '')}{r.estimate.complete ? '' : ' *'}</span>
                <span className="dual-bars"><span className="bar-est" style={{ width: `${w(est)}%` }} />{act ? <span className="bar-act" style={{ width: `${w(act)}%` }} /> : <span style={{ height: 8 }} />}</span>
                <span className="dual-val">{num(est, 2)} → {act ? <strong>{num(act, 2)}</strong> : <span className="muted">no batch</span>}{d && <span className={d.gt(0) ? 'up' : 'down'}> {d.gt(0) ? '+' : ''}{d.toFixed(1)}%</span>}</span>
              </button>
            );
          })}
        </div>
      </Card>
      {p && (
        <Card title={p.name}>
          <div className="bigs">
            <div><div className="muted small">Standard / {p.outputUnit}</div><div className="level-value tag-est">{sek(p.estimate.costPerOutputUnit)}</div><Badge tone="accent">Estimate{p.estimate.complete ? '' : ', incomplete'}</Badge></div>
            <div><div className="muted small">Latest actual / {p.outputUnit}</div><div className="level-value tag-act">{p.latestActual ? sek(p.latestActual.costPerOutputUnit) : '—'}</div>{p.latestActual ? <Badge tone="info">{p.latestActual.batchNumber}</Badge> : <Badge>No locked batch</Badge>}</div>
          </div>
          <table className="table compact"><tbody>
            {p.latestActual && <tr><td>Made at</td><td className="num">{p.latestActual.partnerName ?? 'Kuna factory'}{p.latestActual.madeOn ? `, ${date(p.latestActual.madeOn)}` : ''}</td></tr>}
            {p.latestActual?.estimateAtBatch && <tr><td>Estimate stored with that batch</td><td className="num">{sek(p.latestActual.estimateAtBatch)}</td></tr>}
            {bulk ? <>
              <tr><td>Approved price (bulk / {p.outputUnit})</td><td className="num">{sek(bulk.price)}</td></tr>
              {pricing && <tr><td>Margin at standard cost</td><td className="num">{pct(bulk.currentMarginPct)}</td></tr>}
              {pricing && <tr><td>Margin at latest actual cost</td><td className={`num ${bulk.belowTargetActual ? 'w-error' : ''}`}><strong>{bulk.actualMarginPct != null ? pct(bulk.actualMarginPct) : '—'}</strong></td></tr>}
              {pricing && <tr><td>Target margin</td><td className="num">{p.targetMarginPct ? pct(p.targetMarginPct) : 'not set'}</td></tr>}
            </> : <tr><td colSpan={2} className="muted">No approved bulk price.</td></tr>}
          </tbody></table>
          <div className="row" style={{ marginTop: 10 }}>
            <Button size="sm" onClick={() => nav(`/recipes/${p.id}`)}>Open recipe</Button>
            {p.version && <Button size="sm" onClick={() => nav(`/calculator?versionId=${p.version.id}`)}>Cost breakdown</Button>}
            {p.latestActual && <Button size="sm" onClick={() => nav(p.latestActual.partnerName ? `/outsourced/${p.latestActual.batchId}` : `/batches/${p.latestActual.batchId}`)}>Open batch</Button>}
          </div>
        </Card>
      )}
    </div>
  );
}

function RecentBatches({ batches, costs }: { batches: any[]; costs: boolean }) {
  const nav = useNavigate();
  return (
    <Card title="Recent batches" pad={false} actions={<Link to="/batches">All batches</Link>}>
      {batches.length === 0 ? <Empty title="No production batches recorded" /> : (
        <div className="table-wrap"><table className="table compact">
          <thead><tr><th>Batch</th><th>Product</th><th>Made at</th><th>Date</th>{costs && <><th className="num"><span className="tag-est">Est.</span> / unit</th><th className="num"><span className="tag-act">Actual</span> / unit</th><th className="num">Diff.</th></>}<th>Status</th></tr></thead>
          <tbody>{batches.map((b) => {
            const d = b.est_cpu && b.act_cpu ? dec(b.act_cpu)!.minus(b.est_cpu).div(b.est_cpu).times(100) : null;
            return (
              <tr key={b.id} className="clickable" onClick={() => nav(b.partner_name ? `/outsourced/${b.id}` : `/batches/${b.id}`)}>
                <td className="nowrap">{b.batch_number}</td><td>{b.product_name}</td><td className="small">{b.partner_name ?? 'Kuna factory'}</td>
                <td className="nowrap small">{date(b.received_date ?? b.production_date ?? b.sent_date)}</td>
                {costs && <><td className="num">{num(b.est_cpu, 2)}</td><td className="num">{num(b.act_cpu, 2)}</td><td className={`num ${d ? (d.gt(0) ? 'up' : 'down') : ''}`}>{d ? `${d.gt(0) ? '+' : ''}${d.toFixed(1)} %` : '—'}</td></>}
                <td><StatusBadge status={b.status} /></td>
              </tr>
            );
          })}</tbody>
        </table></div>
      )}
    </Card>
  );
}

function Attention({ data, below, incomplete, reviewCount, pricing }: { data: any; below: any[]; incomplete: any[]; reviewCount: number; pricing: boolean }) {
  const items: { tone: 'error' | 'warning' | 'info'; node: React.ReactNode }[] = [];
  for (const m of (data.missingPrices ?? []).slice(0, 4)) items.push({ tone: 'error', node: <><Link to={`/materials/${m.id}`}><strong>{m.name}</strong></Link> has no price, so the costing of {m.products.join(', ')} is incomplete.</> });
  if (pricing && below.length) items.push({ tone: 'warning', node: <><strong>{below.length} product{below.length > 1 ? 's' : ''}</strong> below target margin: {below.map((p) => p.name.replace(/ Concentrate$/, '')).join(', ')}.</> });
  const otherIncomplete = incomplete.filter((p) => !(data.missingPrices ?? []).some((m: any) => m.products.includes(p.name)));
  if (otherIncomplete.length) items.push({ tone: 'warning', node: <>Incomplete costing (missing rate or value): {otherIncomplete.map((p) => p.name).join(', ')}.</> });
  for (const b of data.partnerBatches ?? []) {
    const label = !b.sent_date ? 'ingredients not sent yet' : !b.received_date ? `at ${b.partner_name}, waiting for finished goods` : !b.costs_locked ? 'received, actual cost not locked' : 'waiting for quality release';
    items.push({ tone: 'info', node: <><Link to={`/outsourced/${b.id}`}><strong>{b.batch_number}</strong></Link> {b.product_name}: {label}.</> });
  }
  if (reviewCount) items.push({ tone: 'warning', node: <><a href="#review"><strong>{reviewCount} record{reviewCount > 1 ? 's' : ''}</strong></a> waiting for review.</> });
  return (
    <Card title="Needs attention">
      {items.length === 0 ? <span className="muted">Nothing needs attention.</span> : (
        <ul className="attention">{items.map((it, i) => <li key={i} className={`w-${it.tone}`} style={{ color: 'inherit' }}><span className="w-dot" /><span>{it.node}</span></li>)}</ul>
      )}
    </Card>
  );
}
