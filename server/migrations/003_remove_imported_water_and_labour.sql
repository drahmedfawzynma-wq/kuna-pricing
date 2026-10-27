-- Water and the Batchworks labour line are no longer part of imported recipes.
-- Remove the placeholder lines that earlier imports added to DRAFT versions only
-- (approved and archived versions are never changed), and clear the matching review notes.
DELETE FROM recipe_ingredients
 WHERE quantity IS NULL AND needs_review = 1
   AND material_id IN (SELECT id FROM materials WHERE code = 'water')
   AND recipe_version_id IN (SELECT id FROM recipe_versions WHERE status = 'draft' AND import_batch_id IS NOT NULL);

DELETE FROM recipe_cost_items
 WHERE category = 'labour' AND rate IS NULL AND needs_review = 1
   AND recipe_version_id IN (SELECT id FROM recipe_versions WHERE status = 'draft' AND import_batch_id IS NOT NULL);

UPDATE recipe_versions
   SET review_notes = TRIM(REPLACE(REPLACE(REPLACE(REPLACE(review_notes,
         'Water quantity per reference batch not entered.', ''),
         'Labour rate/hours interpretation unresolved.', ''),
         char(10) || char(10), char(10)), char(10) || char(10), char(10)), char(10) || ' ')
 WHERE status = 'draft' AND import_batch_id IS NOT NULL AND review_notes IS NOT NULL;

UPDATE recipe_versions SET review_status = 'ok', review_notes = NULL
 WHERE status = 'draft' AND import_batch_id IS NOT NULL AND review_status = 'needs_review'
   AND (review_notes IS NULL OR review_notes = '');

-- Archive the placeholder Water material if nothing uses it and it was never priced.
UPDATE materials SET archived = 1, updated_at = datetime('now')
 WHERE code = 'water'
   AND NOT EXISTS (SELECT 1 FROM recipe_ingredients WHERE material_id = materials.id)
   AND NOT EXISTS (SELECT 1 FROM material_prices WHERE material_id = materials.id);
