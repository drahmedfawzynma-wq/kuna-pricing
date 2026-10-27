-- Customer-facing line details frozen when the line is written, so later edits to
-- products or packaging formats never change what an issued quotation shows.
ALTER TABLE quotation_lines ADD COLUMN product_name TEXT;
ALTER TABLE quotation_lines ADD COLUMN output_unit TEXT;
ALTER TABLE quotation_lines ADD COLUMN packaging_name TEXT;
ALTER TABLE quotation_lines ADD COLUMN fill_qty TEXT;
ALTER TABLE quotation_lines ADD COLUMN fill_unit TEXT;
