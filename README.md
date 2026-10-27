# Kuna Production & Pricing

Web application for Kuna's food-extract recipes, batch costing, selling prices and quotations.

Workflow: **materials and prices → recipes (versioned) → batch calculator → pricing and scenarios → customer quotation**, plus production batches with actual output and quality release.

## Install on a Mac

Requirements: Node.js **22.13 or newer** (`node -v`) from nodejs.org.

1. Clone this repository to `~/Documents/Projects/kuna-pricing` (GitHub Desktop: *Clone a Repository from the Internet*).
2. In Terminal:
   ```bash
   cd ~/Documents/Projects/kuna-pricing
   ./scripts/install-mac.sh
   ```
   This installs packages, builds the interface, starts the app as a background service (starts at login, restarts if it stops) and schedules a daily backup. It opens http://127.0.0.1:4310; the first visit asks you to create the administrator account.

Where things live:

| What | Location |
|---|---|
| Code (Git) | `~/Documents/Projects/kuna-pricing` |
| Live database | `~/KunaData/kuna.db` (outside the code folder and outside iCloud) |
| Log files | `~/KunaData/server.log`, `~/KunaData/backup.log` |
| Backups | `iCloud Drive/Kuna Backups` (or `~/KunaData/backups` without iCloud), daily at 12:30 and before every update, newest 90 kept |

### Updating

In GitHub Desktop click **Fetch origin**, then **Pull origin**. Then:
```bash
cd ~/Documents/Projects/kuna-pricing
./scripts/install-mac.sh
```
The installer backs up your data, rebuilds and restarts. Database changes are applied automatically at startup; your data is never replaced.

To stop the background service: `./scripts/uninstall-mac.sh` (data and backups are kept).

### First use

1. Create the administrator account on the first screen.
2. Load the Batchworks materials and all recipes in one go (safe to run twice; existing products are skipped):
   ```bash
   cd ~/Documents/Projects/kuna-pricing && npm run import
   ```
   Or use **Imports** → drop the Batchworks materials CSV and all recipe CSVs together (copies are in `sample-data/`) → review each preview → apply.
3. **Recipes** → check each draft → approve.
4. **Batch calculator** → add labour for the batch under *Costs for this batch*.
5. **Batch calculator**, **Pricing**, **Quotations** as needed.

## Configuration (environment variables)

Copy `.env.example` values into your shell or a launch script.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4310` | HTTP port |
| `HOST` | `127.0.0.1` | Use `0.0.0.0` to allow other computers on the network |
| `KUNA_DB_FILE` | `~/KunaData/kuna.db` | Database file |
| `KUNA_SECURE_COOKIES` | `0` | Set `1` when served over HTTPS (required for production) |
| `KUNA_ADMIN_EMAIL` / `KUNA_ADMIN_PASSWORD` | – | Optional: create the first admin at startup instead of the setup screen |
| `KUNA_BACKUP_DIR` | `~/KunaData/backups` | Where `npm run backup` writes |
| `KUNA_BACKUP_KEEP` | `90` | Number of backups kept |

No secrets are stored in code. Passwords are hashed with scrypt; sessions are random tokens stored hashed.

## Architecture

* **Server:** Node + TypeScript (Fastify). All business rules and permission checks run on the server.
* **Database:** SQLite (built into Node), one file, WAL mode. Schema in `server/migrations/*.sql`, applied automatically at startup and tracked in `schema_migrations`. All money, quantities and rates are stored as exact decimal strings and calculated with decimal.js.
* **Costing engine:** `shared/engine.ts` and `shared/pricing.ts`, pure functions used by both the server (authoritative values and snapshots) and the browser (instant recalculation).
* **Client:** React + Vite, served by the same process from `dist/`.

### Roles (enforced server side)

| Role | Can |
|---|---|
| Administrator | Everything, including approving prices and quotations, users, settings, audit log |
| Production | Materials and supplier prices, recipes (edit/approve), costings, production batches, imports |
| Quality | Recipe compositions (no costs), quality specs, QC results, release or reject batches |
| Sales | Customers, quotations using **approved** prices only. No recipes, costs, supplier prices or margins |

### Historical integrity

* Approved recipe versions are locked; editing creates a new draft version.
* Saved costings, price approvals, approved quotations and production batches store a full snapshot (recipe lines, quantities, material prices, exchange rates, yield, packaging, allocation rules). New material prices never change them.
* Scenarios are separate records and change nothing until a price is explicitly proposed and approved.

### Calculation rules

* Unit cost = total applicable batch cost ÷ sellable units (accepted sellable output, or whole packages filled).
* Price for target gross margin = unit cost ÷ (1 − margin). Price for markup = unit cost × (1 + markup). Gross margin = (price − cost) ÷ price.
* Recipe quantities are for the reference batch; the selected production scale multiplies them once.
* Fixed costs do not scale; hourly costs scale only when marked; step costs charge per started step; percentage overhead applies to production costs, never to packaging or to itself. An overhead marked "includes utilities" together with separate utility lines is flagged as double counting.
* Mass ↔ volume conversion requires a material density. Missing prices are never zero: the costing is marked incomplete and cannot be approved.
* Rounding: full precision internally; selling prices rounded half up to 2 decimals; quotation line total = rounded unit price × quantity. Full list under Settings.

## Batchworks import

Original values are stored unchanged on every imported record (visible under "Imported data"). Findings from the supplied files:

* Each export lists quantities for a **1 L reference batch** and multiplies costs by "Sellable units" (= litres produced). Imported as reference batch 1 L with that production scale as the default.
* No water is added to recipes. Labour from the export is not imported by default; enter labour per batch instead (batch calculator → *Costs for this batch*, or on the production batch record, planned and actual).
* Packaging "per unit" 50 is the batch total; proposed as 1 per package with a 1 L fill (confirm).
* Price warnings: undated or outdated exchange rates, pack price equal to unit price, and same invoice amounts in different currencies for similarly named items (B12 / V B12, Stevia / Stevia 97 %).

## Backup and restore

Backups run automatically (see above). For an extra one at any time:

```bash
cd ~/Documents/Projects/kuna-pricing && npm run backup
```

To restore: run `./scripts/uninstall-mac.sh`, copy the chosen backup to `~/KunaData/kuna.db` (delete any `kuna.db-wal` and `kuna.db-shm` beside it), then run `./scripts/install-mac.sh`.

User administration from the terminal:

```bash
npm run user -- create anna@kuna.se "Anna Svensson" sales 'a-long-password'
npm run user -- reset-password anna@kuna.se 'new-long-password'
```

## Tests

```bash
npm test
```

51 automated tests cover the acceptance cases (2 kg / 500 g at 50 SEK/kg, 10 000 SEK over 100 L and 80 L, 30 % markup and margin), single scaling, missing prices, density rules, the complete material → quotation workflow via the API, historical integrity after price changes, QC release rules, role restrictions on every confidential endpoint, locks on packaging formats and sales units once used, re-checking prices when approving a quotation, and the Batchworks import of all supplied files. A browser walkthrough of the full workflow (setup → import → approve recipe → calculate → price → quotation → batch) was also run against the built app.

## Production deployment notes

This runs well as a single-server application for one site. Before exposing it beyond one computer:

* Serve it behind HTTPS (for example Caddy or nginx) and set `KUNA_SECURE_COOKIES=1`, `HOST=0.0.0.0`.
* Run it as a service (launchd on macOS, systemd on Linux) and schedule backups.
* For several sites or high concurrency, the plain-SQL data layer can be moved to PostgreSQL; the migrations are standard SQL.

## Not yet implemented

* Supplier lot receiving, stock movements, expiry-based (FEFO) allocation and dispatch blocking (tables exist: `material_lots`, `batch_inputs`; no UI yet).
* File attachments for quality results (a document reference field is stored instead).
* Sub-recipes (intermediate extracts as ingredients) with circular-dependency checks.
* Costing basis "actual purchase-lot cost" (current reference price and scenario prices are implemented).
* Multi-currency selling prices (selling prices are in SEK; purchasing supports any currency with recorded rates).
* Password reset by email, single sign-on, two-factor authentication.
