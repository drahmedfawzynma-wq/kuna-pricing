import type { FastifyInstance } from 'fastify';
import { requirePerm, userCan } from '../auth';
import { currentPriceRows, currentVersion, runCosting } from '../services';
import { marginPct } from '../../shared/pricing';
import { dec } from '../../shared/decimal';

export function registerDashboardRoutes(app: FastifyInstance) {
  const db = app.db;

  app.get('/api/dashboard', async (req) => {
    requirePerm(req);
    const out: any = { generatedAt: new Date().toISOString() };
    const costs = userCan(req, 'costs.read');
    const pricing = userCan(req, 'pricing.read');

    if (userCan(req, 'recipes.read') || userCan(req, 'prices.read')) {
      out.counts = {
        products: db.get<any>('SELECT COUNT(*) n FROM products WHERE archived = 0').n,
        recipeVersions: db.get<any>("SELECT COUNT(*) n FROM recipe_versions rv JOIN products p ON p.id = rv.product_id WHERE rv.status != 'archived' AND p.archived = 0").n,
        approvedRecipes: db.get<any>("SELECT COUNT(*) n FROM recipe_versions WHERE status = 'approved'").n,
        materials: db.get<any>('SELECT COUNT(*) n FROM materials WHERE archived = 0').n,
      };
    }

    if (costs) {
      const products = db.all<any>('SELECT * FROM products WHERE archived = 0 ORDER BY name');
      out.products = products.map((p) => {
        const v = currentVersion(db, p.id);
        if (!v) return { id: p.id, name: p.name, code: p.code, outputUnit: p.output_unit, version: null };
        const bulk = runCosting(db, { recipeVersionId: v.id });
        const approved = db.all<any>(`SELECT sp.*, pf.name AS packaging_name FROM selling_prices sp LEFT JOIN packaging_formats pf ON pf.id = sp.packaging_format_id
          WHERE sp.product_id = ? AND sp.status IN ('approved','proposed') ORDER BY sp.status, sp.id DESC`, p.id);
        // Latest completed (cost-locked) batch, in-house or at a partner: the "actual" reference.
        const la = db.get<any>(`SELECT b.id, b.batch_number, b.packaging_format_id, COALESCE(b.received_date, b.production_date) AS made_on, pa.name AS partner_name,
            a.cost_per_output_unit, a.cost_per_package, a.created_at, e.cost_per_output_unit AS est_cpu
          FROM production_batches b JOIN costings a ON a.id = b.actual_costing_id LEFT JOIN costings e ON e.id = b.estimate_costing_id
          LEFT JOIN partners pa ON pa.id = b.partner_id WHERE b.product_id = ? AND b.status != 'rejected' ORDER BY a.id DESC LIMIT 1`, p.id);
        const below = (m: { ok: boolean; value?: string } | null) => !!(pricing && m?.ok && p.target_margin_pct && dec(m.value!)!.toDecimalPlaces(2).lt(p.target_margin_pct));
        const priceRows = approved.map((sp) => {
          const c = sp.packaging_format_id ? runCosting(db, { recipeVersionId: v.id, packagingFormatId: sp.packaging_format_id }).result : bulk.result;
          const unitCost = sp.price_unit === 'package' ? c.costPerPackage : c.costPerOutputUnit;
          const m = unitCost ? marginPct(sp.price, unitCost) : null;
          // Actual cost is comparable when the price is per L/kg, or per package of the same format the batch was filled in.
          const actualUnitCost = !la ? null : sp.price_unit === 'package' ? (la.packaging_format_id && la.packaging_format_id === sp.packaging_format_id ? la.cost_per_package : null) : la.cost_per_output_unit;
          const ma = actualUnitCost ? marginPct(sp.price, actualUnitCost) : null;
          return {
            id: sp.id, status: sp.status, customerId: sp.customer_id, price: sp.price, priceUnit: sp.price_unit, minQty: sp.min_qty, packagingFormatId: sp.packaging_format_id,
            packagingName: sp.packaging_name, currentUnitCost: unitCost, currentMarginPct: pricing && m?.ok ? m.value : null, complete: c.complete,
            belowTarget: below(m),
            actualUnitCost, actualMarginPct: pricing && ma?.ok ? ma.value : null, belowTargetActual: below(ma),
          };
        });
        return {
          id: p.id, name: p.name, code: p.code, outputUnit: p.output_unit, targetMarginPct: pricing ? p.target_margin_pct : undefined,
          version: { id: v.id, versionNo: v.version_no, status: v.status, reviewStatus: v.review_status },
          estimate: {
            batchQty: bulk.result.batchQty, totalBatchCost: bulk.result.totalBatchCost, costPerOutputUnit: bulk.result.costPerOutputUnit,
            complete: bulk.result.complete, sections: bulk.result.sections, warningCount: bulk.result.warnings.filter((w) => w.level !== 'info').length,
          },
          prices: pricing ? priceRows : priceRows.filter((r) => r.status === 'approved').map((r) => ({ ...r, currentMarginPct: undefined, belowTarget: undefined, actualMarginPct: undefined, belowTargetActual: undefined })),
          latestActual: la ? { batchId: la.id, batchNumber: la.batch_number, costPerOutputUnit: la.cost_per_output_unit, estimateAtBatch: la.est_cpu, madeOn: la.made_on, partnerName: la.partner_name, lockedAt: la.created_at } : null,
        };
      });

      out.recentPriceChanges = db.all<any>(`SELECT p.id, p.material_id, m.name, m.code, m.base_unit, p.effective_date, p.landed_unit_price_sek, p.currency, p.source, p.created_at,
          (SELECT p2.landed_unit_price_sek FROM material_prices p2 WHERE p2.material_id = p.material_id AND p2.id != p.id AND (p2.undated = 1 OR p2.effective_date <= p.effective_date) ORDER BY p2.undated, p2.effective_date DESC, p2.id DESC LIMIT 1) AS previous
        FROM material_prices p JOIN materials m ON m.id = p.material_id WHERE p.undated = 0 ORDER BY p.created_at DESC, p.id DESC LIMIT 12`);

      const prices = currentPriceRows(db);
      const used = db.all<any>(`SELECT DISTINCT m.id, m.name, m.code, p.name AS product_name, p.id AS product_id FROM materials m
        JOIN (SELECT ri.material_id, rv.product_id FROM recipe_ingredients ri JOIN recipe_versions rv ON rv.id = ri.recipe_version_id WHERE rv.status != 'archived'
              UNION SELECT pc.material_id, pf.product_id FROM packaging_components pc JOIN packaging_formats pf ON pf.id = pc.format_id WHERE pf.archived = 0) u ON u.material_id = m.id
        JOIN products p ON p.id = u.product_id AND p.archived = 0`);
      const missing = new Map<number, { id: number; name: string; code: string; products: string[] }>();
      for (const r of used) {
        if (prices.has(r.id)) continue;
        const e = missing.get(r.id) ?? { id: r.id, name: r.name, code: r.code, products: [] as string[] };
        e.products.push(r.product_name);
        missing.set(r.id, e);
      }
      out.missingPrices = [...missing.values()];
      out.priceChanges90 = db.all<any>(`SELECT m.id, m.name, MAX(p.effective_date) AS effective_date FROM material_prices p JOIN materials m ON m.id = p.material_id
        WHERE p.undated = 0 AND p.effective_date >= date('now', '-90 day') AND m.archived = 0 GROUP BY m.id ORDER BY MAX(p.effective_date) DESC`);
      out.recentCostings = db.all<any>(`SELECT c.id, c.kind, c.name, c.complete, c.cost_per_output_unit, c.cost_per_package, c.total_batch_cost, c.created_at, p.name AS product_name, p.output_unit, rv.version_no
        FROM costings c LEFT JOIN products p ON p.id = c.product_id LEFT JOIN recipe_versions rv ON rv.id = c.recipe_version_id ORDER BY c.id DESC LIMIT 10`);
    }

    if (userCan(req, 'materials.write') || userCan(req, 'recipes.write')) {
      out.review = {
        materials: db.all("SELECT id, code, name, review_notes FROM materials WHERE review_status = 'needs_review' AND archived = 0 ORDER BY name"),
        recipes: db.all("SELECT rv.id, rv.version_no, rv.review_notes, p.name AS product_name, p.id AS product_id FROM recipe_versions rv JOIN products p ON p.id = rv.product_id WHERE rv.review_status = 'needs_review' AND rv.status = 'draft' AND p.archived = 0 ORDER BY p.name"),
        packaging: db.all('SELECT pf.id, pf.name, p.name AS product_name, p.id AS product_id FROM packaging_formats pf JOIN products p ON p.id = pf.product_id WHERE pf.needs_review = 1 AND pf.archived = 0'),
      };
    }

    if (userCan(req, 'quotations.read')) {
      out.recentQuotations = db.all<any>(`SELECT q.id, q.number, q.status, q.quote_date, q.valid_until, c.name AS customer_name,
        (SELECT COALESCE(SUM(CAST(line_total AS REAL)),0) FROM quotation_lines WHERE quotation_id = q.id) AS subtotal_approx
        FROM quotations q JOIN customers c ON c.id = q.customer_id ORDER BY q.id DESC LIMIT 8`).map((q) => ({ ...q, subtotal_approx: undefined }));
    }
    if (userCan(req, 'prices.read') && !costs) {
      out.approvedPrices = db.all(`SELECT sp.id, p.name AS product_name, c.name AS customer_name, pf.name AS packaging_name, sp.min_qty, sp.price, sp.price_unit, sp.effective_from
        FROM selling_prices sp JOIN products p ON p.id = sp.product_id LEFT JOIN customers c ON c.id = sp.customer_id LEFT JOIN packaging_formats pf ON pf.id = sp.packaging_format_id
        WHERE sp.status = 'approved' ORDER BY p.name`);
    }
    if (userCan(req, 'batches.read')) {
      out.batches = db.all<any>(`SELECT b.id, b.batch_number, b.status, b.planned_qty, b.actual_output_qty, b.production_date, b.received_date, b.sent_date, b.costs_locked,
          p.name AS product_name, p.output_unit, pa.name AS partner_name, e.cost_per_output_unit AS est_cpu, a.cost_per_output_unit AS act_cpu
        FROM production_batches b JOIN products p ON p.id = b.product_id LEFT JOIN partners pa ON pa.id = b.partner_id
        LEFT JOIN costings e ON e.id = b.estimate_costing_id LEFT JOIN costings a ON a.id = b.actual_costing_id ORDER BY b.id DESC LIMIT 10`)
        .map((b) => (costs ? b : { ...b, est_cpu: undefined, act_cpu: undefined }));
      out.partnerBatches = db.all(`SELECT b.id, b.batch_number, b.status, b.sent_date, b.partner_produced_date, b.received_date, b.costs_locked, p.name AS product_name, pa.name AS partner_name
        FROM production_batches b JOIN products p ON p.id = b.product_id JOIN partners pa ON pa.id = b.partner_id
        WHERE b.status NOT IN ('released','rejected') ORDER BY b.id DESC`);
      if (costs) {
        // Last five cost-locked batches: actual cost per unit vs. the estimate stored for the same batch.
        out.lockedBatches = db.all(`SELECT b.id, b.batch_number, p.name AS product_name, e.cost_per_output_unit AS est_cpu, a.cost_per_output_unit AS act_cpu
          FROM production_batches b JOIN products p ON p.id = b.product_id JOIN costings a ON a.id = b.actual_costing_id JOIN costings e ON e.id = b.estimate_costing_id
          ORDER BY a.id DESC LIMIT 5`);
      }
    }
    return out;
  });
}
