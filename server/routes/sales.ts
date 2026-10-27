import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, requirePerm, userCan } from '../auth';
import type { DB } from '../db';
import { today } from '../db';
import { audit, currentVersion, getSetting, runCosting, saveCosting } from '../services';
import { lookupApprovedPrice } from './costings';
import { Decimal, dec } from '../../shared/decimal';
import { lineTotal, marginPct } from '../../shared/pricing';

const customerBody = z.object({
  name: z.string().trim().min(1).max(200),
  orgNumber: z.string().max(50).nullable().optional(),
  contactName: z.string().max(200).nullable().optional(),
  email: z.string().max(200).nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
  address: z.string().max(1000).nullable().optional(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default('SEK'),
  defaultVatPct: z.string().refine((v) => dec(v) !== null && dec(v)!.gte(0), 'VAT must be ≥ 0').default('25'),
  notes: z.string().max(5000).nullable().optional(),
});

const quoteBody = z.object({
  customerId: z.number().int(),
  quoteDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  deliveryCharge: z.string().refine((v) => v === '' || (dec(v) !== null && dec(v)!.gte(0)), 'delivery charge must be ≥ 0').default('0'),
  deliveryNote: z.string().max(500).nullable().optional(),
  vatPct: z.string().refine((v) => dec(v) !== null && dec(v)!.gte(0), 'VAT must be ≥ 0'),
  notes: z.string().max(5000).nullable().optional(),
  lines: z.array(z.object({
    productId: z.number().int(),
    packagingFormatId: z.number().int().nullable().optional(),
    description: z.string().max(500).nullable().optional(),
    quantity: z.string().refine((v) => dec(v)?.gt(0), 'quantity must be > 0'),
    priceUnit: z.enum(['package', 'output_unit']),
    unitPrice: z.string().nullable().optional(),
    useApprovedPrice: z.boolean().default(true),
  })).max(50),
});

function quoteTotals(lines: { line_total: string }[], delivery: string, vat: string) {
  const sub = lines.reduce((s, l) => s.plus(l.line_total), new Decimal(0));
  const del = dec(delivery) ?? new Decimal(0);
  const ex = sub.plus(del);
  const vatAmt = ex.times(dec(vat) ?? 0).div(100).toDecimalPlaces(2);
  return { subtotal: sub.toFixed(2), delivery: del.toFixed(2), totalExVat: ex.toFixed(2), vat: vatAmt.toFixed(2), totalIncVat: ex.plus(vatAmt).toFixed(2) };
}

export function registerSalesRoutes(app: FastifyInstance) {
  const db = app.db;

  // Customers
  const custDto = (c: any) => ({ id: c.id, name: c.name, orgNumber: c.org_number, contactName: c.contact_name, email: c.email, phone: c.phone, address: c.address, currency: c.currency, defaultVatPct: c.default_vat_pct, notes: c.notes, archived: !!c.archived });
  app.get('/api/customers', async (req) => {
    requirePerm(req, 'customers.read');
    return db.all(`SELECT * FROM customers ${(req.query as any).archived === '1' ? '' : 'WHERE archived = 0'} ORDER BY name`).map(custDto);
  });
  app.get('/api/customers/:id', async (req) => {
    requirePerm(req, 'customers.read');
    const c = db.get('SELECT * FROM customers WHERE id = ?', Number((req.params as any).id));
    if (!c) throw new HttpError(404, 'Customer not found.');
    return custDto(c);
  });
  app.post('/api/customers', async (req) => {
    const me = requirePerm(req, 'customers.write');
    const b = customerBody.parse(req.body);
    const id = db.run('INSERT INTO customers (name, org_number, contact_name, email, phone, address, currency, default_vat_pct, notes) VALUES (?,?,?,?,?,?,?,?,?)', b.name, b.orgNumber, b.contactName, b.email, b.phone, b.address, b.currency, b.defaultVatPct, b.notes).lastInsertRowid;
    audit(db, me, 'customer', id, 'create', `Created customer ${b.name}`, undefined, b);
    return { id };
  });
  app.patch('/api/customers/:id', async (req) => {
    const me = requirePerm(req, 'customers.write');
    const id = Number((req.params as any).id);
    const before = db.get('SELECT * FROM customers WHERE id = ?', id);
    if (!before) throw new HttpError(404, 'Customer not found.');
    const b = customerBody.parse(req.body);
    db.run("UPDATE customers SET name=?, org_number=?, contact_name=?, email=?, phone=?, address=?, currency=?, default_vat_pct=?, notes=?, updated_at=datetime('now') WHERE id=?", b.name, b.orgNumber, b.contactName, b.email, b.phone, b.address, b.currency, b.defaultVatPct, b.notes, id);
    audit(db, me, 'customer', id, 'update', `Updated customer ${b.name}`, before, b);
    return { ok: true };
  });
  app.post('/api/customers/:id/archive', async (req) => {
    const me = requirePerm(req, 'customers.write');
    const id = Number((req.params as any).id);
    const { archived } = z.object({ archived: z.boolean() }).parse(req.body);
    db.run('UPDATE customers SET archived = ? WHERE id = ?', archived ? 1 : 0, id);
    audit(db, me, 'customer', id, archived ? 'archive' : 'restore', 'Customer archive state changed');
    return { ok: true };
  });

  // Quotations
  function quoteDto(id: number, full: boolean) {
    const q = db.get<any>('SELECT q.*, c.name AS customer_name, u.name AS created_by_name, a.name AS approved_by_name FROM quotations q JOIN customers c ON c.id = q.customer_id LEFT JOIN users u ON u.id = q.created_by LEFT JOIN users a ON a.id = q.approved_by WHERE q.id = ?', id);
    if (!q) throw new HttpError(404, 'Quotation not found.');
    const lines = db.all<any>(`SELECT ql.*, COALESCE(ql.product_name, p.name) AS product_name, COALESCE(ql.output_unit, p.output_unit) AS output_unit,
      COALESCE(ql.packaging_name, pf.name) AS packaging_name, COALESCE(ql.fill_qty, pf.fill_qty) AS fill_qty, COALESCE(ql.fill_unit, pf.fill_unit) AS fill_unit, rv.version_no, rv.status AS version_status
      FROM quotation_lines ql JOIN products p ON p.id = ql.product_id LEFT JOIN packaging_formats pf ON pf.id = ql.packaging_format_id LEFT JOIN recipe_versions rv ON rv.id = ql.recipe_version_id
      WHERE quotation_id = ? ORDER BY line_no`, id);
    return {
      id: q.id, number: q.number, customerId: q.customer_id, customerName: q.customer_name, status: q.status, currency: q.currency, quoteDate: q.quote_date,
      validUntil: q.valid_until, deliveryCharge: q.delivery_charge, deliveryNote: q.delivery_note, vatPct: q.vat_pct, notes: q.notes,
      customerSnapshot: q.customer_snapshot_json ? JSON.parse(q.customer_snapshot_json) : null,
      createdAt: q.created_at, createdByName: q.created_by_name, approvedAt: q.approved_at, approvedByName: q.approved_by_name, updatedAt: q.updated_at,
      totals: quoteTotals(lines, q.delivery_charge, q.vat_pct),
      lines: lines.map((l) => {
        const base: any = {
          id: l.id, productId: l.product_id, productName: l.product_name, outputUnit: l.output_unit, packagingFormatId: l.packaging_format_id,
          packagingName: l.packaging_name, fillQty: l.fill_qty, fillUnit: l.fill_unit, description: l.description, quantity: l.quantity,
          priceUnit: l.price_unit, unitPrice: l.unit_price, lineTotal: l.line_total, recipeVersionNo: l.version_no, recipeVersionId: l.recipe_version_id,
          sellingPriceId: l.selling_price_id,
        };
        if (full && l.costing_id) {
          const c = db.get<any>('SELECT * FROM costings WHERE id = ?', l.costing_id);
          const unitCost = l.price_unit === 'package' ? c.cost_per_package : c.cost_per_output_unit;
          const m = unitCost ? marginPct(l.unit_price, unitCost) : null;
          base.costing = { id: c.id, unitCost, complete: !!c.complete, marginPct: m?.ok ? m.value : null, createdAt: c.created_at };
        }
        return base;
      }),
    };
  }

  app.get('/api/quotations', async (req) => {
    requirePerm(req, 'quotations.read');
    const rows = db.all<any>('SELECT q.id FROM quotations q ORDER BY q.id DESC LIMIT 500');
    const full = userCan(req, 'pricing.read');
    return rows.map((r) => {
      const d = quoteDto(r.id, full);
      return { id: d.id, number: d.number, customerName: d.customerName, status: d.status, quoteDate: d.quoteDate, validUntil: d.validUntil, totals: d.totals, lineCount: d.lines.length, products: [...new Set(d.lines.map((l: any) => l.productName))].join(', ') };
    });
  });

  app.get('/api/quotations/:id', async (req) => {
    requirePerm(req, 'quotations.read');
    return quoteDto(Number((req.params as any).id), userCan(req, 'pricing.read'));
  });

  /** Customer-facing document data: no recipes, costs, margins or internal notes. */
  app.get('/api/quotations/:id/print', async (req) => {
    requirePerm(req, 'quotations.read');
    const d = quoteDto(Number((req.params as any).id), false);
    const settings = Object.fromEntries(db.all<any>('SELECT key, value FROM settings').map((r) => [r.key, r.value]));
    const customer = d.customerSnapshot ?? db.get('SELECT name, org_number, contact_name, email, address FROM customers WHERE id = ?', d.customerId);
    return {
      company: { name: settings.company_name, address: settings.company_address, terms: settings.quotation_terms },
      number: d.number, status: d.status, quoteDate: d.quoteDate, validUntil: d.validUntil, currency: d.currency, vatPct: d.vatPct,
      deliveryCharge: d.deliveryCharge, deliveryNote: d.deliveryNote, notes: d.notes, customer, totals: d.totals,
      lines: d.lines.map((l: any) => ({ productName: l.productName, packagingName: l.packagingName, description: l.description, quantity: l.quantity, priceUnit: l.priceUnit, outputUnit: l.outputUnit, unitPrice: l.unitPrice, lineTotal: l.lineTotal })),
    };
  });

  function buildLines(req: any, b: z.infer<typeof quoteBody>) {
    const canManual = userCan(req, 'pricing.write');
    return b.lines.map((l, i) => {
      const product = db.get<any>('SELECT * FROM products WHERE id = ? AND archived = 0', l.productId);
      if (!product) throw new HttpError(400, `Line ${i + 1}: product not found or archived.`);
      if (l.priceUnit === 'package' && !l.packagingFormatId) throw new HttpError(400, `Line ${i + 1}: choose a packaging format or price per ${product.output_unit}.`);
      if (l.packagingFormatId && !db.get('SELECT id FROM packaging_formats WHERE id = ? AND product_id = ?', l.packagingFormatId, l.productId)) throw new HttpError(400, `Line ${i + 1}: packaging format does not belong to the product.`);
      const v = currentVersion(db, l.productId);
      let unitPrice: string;
      let sellingPriceId: number | null = null;
      const pf = l.priceUnit === 'package' ? l.packagingFormatId ?? null : null;
      if (l.useApprovedPrice || !canManual) {
        const sp = lookupApprovedPrice(db, l.productId, b.customerId, pf, l.quantity);
        if (!sp || sp.price_unit !== l.priceUnit) {
          throw new HttpError(400, `Line ${i + 1}: no approved selling price for ${product.name}${pf ? ' in this packaging' : ''} at this quantity.${canManual ? ' Enter a manual price or approve a price first.' : ' Ask an administrator to approve a price.'}`);
        }
        unitPrice = sp.price;
        sellingPriceId = sp.id;
      } else {
        const p = dec(l.unitPrice);
        if (!p || p.lte(0)) throw new HttpError(400, `Line ${i + 1}: enter a unit price greater than zero.`);
        unitPrice = p.toDecimalPlaces(2).toFixed(2);
      }
      return { ...l, packagingFormatId: l.packagingFormatId ?? null, recipeVersionId: v?.id ?? null, unitPrice, lineTotal: lineTotal(unitPrice, l.quantity)!, sellingPriceId };
    });
  }

  function writeLines(qid: number, lines: ReturnType<typeof buildLines>) {
    db.run('DELETE FROM quotation_lines WHERE quotation_id = ?', qid);
    lines.forEach((l, i) => {
      const p = db.get<any>('SELECT name, output_unit FROM products WHERE id = ?', l.productId);
      const f = l.packagingFormatId ? db.get<any>('SELECT name, fill_qty, fill_unit FROM packaging_formats WHERE id = ?', l.packagingFormatId) : null;
      db.run(
        `INSERT INTO quotation_lines (quotation_id, line_no, product_id, recipe_version_id, packaging_format_id, description, quantity, price_unit, unit_price, line_total, selling_price_id,
          product_name, output_unit, packaging_name, fill_qty, fill_unit) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        qid, i + 1, l.productId, l.recipeVersionId, l.packagingFormatId, l.description, l.quantity, l.priceUnit, l.unitPrice, l.lineTotal, l.sellingPriceId,
        p?.name, p?.output_unit, f?.name ?? null, f?.fill_qty ?? null, f?.fill_unit ?? null,
      );
    });
  }

  function nextNumber(db: DB) {
    const prefix = getSetting(db, 'quotation_prefix', 'KQ');
    const year = today().slice(0, 4);
    const last = db.get<any>("SELECT number FROM quotations WHERE number LIKE ? ORDER BY id DESC LIMIT 1", `${prefix}-${year}-%`);
    const n = last ? Number(last.number.split('-').pop()) + 1 : 1;
    return `${prefix}-${year}-${String(n).padStart(4, '0')}`;
  }

  app.post('/api/quotations', async (req) => {
    const me = requirePerm(req, 'quotations.write');
    const b = quoteBody.parse(req.body);
    if (!db.get('SELECT id FROM customers WHERE id = ?', b.customerId)) throw new HttpError(400, 'Customer not found.');
    const lines = buildLines(req, b);
    const id = db.tx(() => {
      const qid = db.run('INSERT INTO quotations (number, customer_id, quote_date, valid_until, delivery_charge, delivery_note, vat_pct, notes, created_by) VALUES (?,?,?,?,?,?,?,?,?)',
        nextNumber(db), b.customerId, b.quoteDate, b.validUntil, b.deliveryCharge || '0', b.deliveryNote, b.vatPct, b.notes, me.id).lastInsertRowid;
      writeLines(qid, lines);
      return qid;
    });
    audit(db, me, 'quotation', id, 'create', `Created draft quotation with ${lines.length} line(s)`);
    return quoteDto(id, userCan(req, 'pricing.read'));
  });

  app.put('/api/quotations/:id', async (req) => {
    const me = requirePerm(req, 'quotations.write');
    const id = Number((req.params as any).id);
    const q = db.get<any>('SELECT * FROM quotations WHERE id = ?', id);
    if (!q) throw new HttpError(404, 'Quotation not found.');
    if (q.status !== 'draft') throw new HttpError(409, `Quotation is ${q.status} and cannot be edited. Duplicate it to make a new draft.`);
    const b = quoteBody.parse(req.body);
    const lines = buildLines(req, b);
    const before = quoteDto(id, true);
    db.tx(() => {
      db.run("UPDATE quotations SET customer_id=?, quote_date=?, valid_until=?, delivery_charge=?, delivery_note=?, vat_pct=?, notes=?, updated_at=datetime('now') WHERE id=?",
        b.customerId, b.quoteDate, b.validUntil, b.deliveryCharge || '0', b.deliveryNote, b.vatPct, b.notes, id);
      writeLines(id, lines);
    });
    audit(db, me, 'quotation', id, 'update', `Updated draft ${q.number}`, { lines: before.lines, totals: before.totals }, b);
    return quoteDto(id, userCan(req, 'pricing.read'));
  });

  /** Approve: snapshot the costing for each line and lock the quotation. */
  app.post('/api/quotations/:id/approve', async (req) => {
    const me = requirePerm(req, 'quotations.approve');
    const id = Number((req.params as any).id);
    const q = db.get<any>('SELECT * FROM quotations WHERE id = ?', id);
    if (!q) throw new HttpError(404, 'Quotation not found.');
    if (q.status !== 'draft') throw new HttpError(409, `Quotation is already ${q.status}.`);
    const lines = db.all<any>('SELECT * FROM quotation_lines WHERE quotation_id = ? ORDER BY line_no', id);
    if (!lines.length) throw new HttpError(400, 'Add at least one line before approving.');
    const problems: string[] = [];
    const costings = lines.map((l) => {
      const v = l.recipe_version_id ? db.get<any>('SELECT rv.*, p.name AS product_name FROM recipe_versions rv JOIN products p ON p.id = rv.product_id WHERE rv.id = ?', l.recipe_version_id) : null;
      if (!v) { problems.push(`Line ${l.line_no}: no recipe version.`); return null; }
      if (v.status !== 'approved') problems.push(`Line ${l.line_no}: ${v.product_name} v${v.version_no} is ${v.status}; only approved recipe versions can be quoted. Approve the recipe and re-save the quotation.`);
      if (l.selling_price_id) {
        const sp = lookupApprovedPrice(db, l.product_id, q.customer_id, l.price_unit === 'package' ? l.packaging_format_id : null, l.quantity);
        if (!sp || sp.id !== l.selling_price_id || sp.price !== l.unit_price) problems.push(`Line ${l.line_no}: the approved selling price has changed since this draft was saved. Re-save the draft to pick up the current price.`);
      }
      if (v.review_status === 'needs_review') problems.push(`Line ${l.line_no}: ${v.product_name} v${v.version_no} is marked "Needs review".`);
      const c = runCosting(db, { recipeVersionId: v.id, packagingFormatId: l.packaging_format_id });
      if (!c.result.complete) problems.push(`Line ${l.line_no}: costing for ${v.product_name} is incomplete (${c.result.warnings.filter((w) => w.level !== 'info').map((w) => w.message).slice(0, 3).join(' ')}).`);
      return c;
    });
    if (problems.length) throw new HttpError(409, `Cannot approve: ${problems.join(' ')}`);
    const customer = db.get('SELECT name, org_number, contact_name, email, phone, address, currency FROM customers WHERE id = ?', q.customer_id);
    db.tx(() => {
      lines.forEach((l, i) => {
        const c = costings[i]!;
        const cid = saveCosting(db, me, 'quotation', `Quotation ${q.number} line ${l.line_no}`, c.input, c.result, c.version, l.packaging_format_id);
        db.run('UPDATE quotation_lines SET costing_id = ? WHERE id = ?', cid, l.id);
      });
      db.run("UPDATE quotations SET status = 'approved', approved_by = ?, approved_at = datetime('now'), customer_snapshot_json = ?, updated_at = datetime('now') WHERE id = ?", me.id, JSON.stringify(customer), id);
    });
    audit(db, me, 'quotation', id, 'approve', `Approved quotation ${q.number}; costing snapshots stored`);
    return quoteDto(id, true);
  });

  app.post('/api/quotations/:id/cancel', async (req) => {
    const me = requirePerm(req, 'quotations.write');
    const id = Number((req.params as any).id);
    const q = db.get<any>('SELECT * FROM quotations WHERE id = ?', id);
    if (!q) throw new HttpError(404, 'Quotation not found.');
    if (q.status === 'approved') requirePerm(req, 'quotations.approve');
    db.run("UPDATE quotations SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?", id);
    audit(db, me, 'quotation', id, 'cancel', `Cancelled quotation ${q.number}`);
    return { ok: true };
  });

  app.post('/api/quotations/:id/duplicate', async (req) => {
    const me = requirePerm(req, 'quotations.write');
    const id = Number((req.params as any).id);
    const q = db.get<any>('SELECT * FROM quotations WHERE id = ?', id);
    if (!q) throw new HttpError(404, 'Quotation not found.');
    const nid = db.tx(() => {
      const nid = db.run('INSERT INTO quotations (number, customer_id, quote_date, valid_until, delivery_charge, delivery_note, vat_pct, notes, created_by) VALUES (?,?,?,?,?,?,?,?,?)',
        nextNumber(db), q.customer_id, today(), null, q.delivery_charge, q.delivery_note, q.vat_pct, q.notes, me.id).lastInsertRowid;
      db.run(`INSERT INTO quotation_lines (quotation_id, line_no, product_id, recipe_version_id, packaging_format_id, description, quantity, price_unit, unit_price, line_total, selling_price_id, product_name, output_unit, packaging_name, fill_qty, fill_unit)
              SELECT ?, line_no, product_id, recipe_version_id, packaging_format_id, description, quantity, price_unit, unit_price, line_total, selling_price_id, product_name, output_unit, packaging_name, fill_qty, fill_unit FROM quotation_lines WHERE quotation_id = ?`, nid, id);
      return nid;
    });
    audit(db, me, 'quotation', nid, 'create', `Duplicated ${q.number} as a new draft (prices kept from original; re-save to refresh)`);
    return { id: nid };
  });
}
