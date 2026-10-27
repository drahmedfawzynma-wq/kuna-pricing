-- Water is not part of Kuna recipes. Remove every Water ingredient line from every recipe
-- version (draft, approved or archived). Saved costings, quotations and batches keep their own
-- snapshots, so their figures do not change. The Water material is archived (its price history kept).
DELETE FROM recipe_ingredients
 WHERE material_id IN (SELECT id FROM materials WHERE code = 'water' OR lower(name) = 'water' OR category = 'water');

UPDATE recipe_versions
   SET review_notes = NULLIF(TRIM(REPLACE(REPLACE(review_notes, 'Water quantity per reference batch not entered.', ''), char(10) || char(10), char(10)), char(10) || ' '), '')
 WHERE review_notes LIKE '%Water quantity%';

UPDATE recipe_versions SET review_status = 'ok'
 WHERE status = 'draft' AND review_status = 'needs_review' AND review_notes IS NULL AND import_batch_id IS NOT NULL;

UPDATE materials SET archived = 1, review_status = 'ok', updated_at = datetime('now')
 WHERE code = 'water' OR lower(name) = 'water' OR category = 'water';

DELETE FROM batch_inputs
 WHERE material_id IN (SELECT id FROM materials WHERE code = 'water' OR lower(name) = 'water' OR category = 'water');
