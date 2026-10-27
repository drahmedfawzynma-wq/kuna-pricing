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
        const priceRows = approved.map((sp) => {
          const c = sp.packaging_format_id ? runCosting(db, { recipeVersionId: v.id, packagingFormatId: sp.packaging_format_id }).result : bulk.result;
          const unitCost = sp.price_unit === 'package' ? c.costPerPackage : c.costPerOutputUnit;
          const m = unitCost ? marginPct(sp.price, unitCost) : null;
          return {
            id: sp.id, status: sp.status, customerId: sp.customer_id, price: sp.price, priceUnit: sp.price_unit, minQty: sp.min_qty,
            packagingName: sp.packaging_name, currentUnitCost: unitCost, currentMarginPct: pricing && m?.ok ? m.value : null, complete: c.complete,
            belowTarget: pricing && m?.ok && p.target_margin_pct ? dec(m.value)!.toDecimalPlaces(2).lt(p.target_margin_pct) : false,
          };
        });
        return {
          id: p.id, name: p.name, code: p.code, outputUnit: p.output_unit, targetMarginPct: pricing ? p.target_margin_pct : undefined,
          version: { id: v.id, versionNo: v.version_no, status: v.status, reviewStatus: v.review_status },
          estimate: {
            batchQty: bulk.result.batchQty, totalBatchCost: bulk.result.totalBatchCost, costPerOutputUnit: bulk.result.costPerOutputUnit,
            complete: bulk.result.complete, sections: bulk.result.sections, warningCount: bulk.result.warnings.filter((w) => w.level !== 'info').length,
          },
          prices: pricing ? priceRows : priceRows.filter((r) => r.status === 'approved').map((r) => ({ ...r, currentMarginPct: undefined, belowTarget: undefined })),
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
      out.batches = db.all(`SELECT b.id, b.batch_number, b.status, b.planned_qty, b.actual_output_qty, b.production_date, p.name AS product_name, p.output_unit
        FROM production_batches b JOIN products p ON p.id = b.product_id ORDER BY b.id DESC LIMIT 8`);
    }
    return out;
  });
}
