-- Normalize display names (en-US), set default images for upcoming categories,
-- and ensure top-category pinning/visibility aligns with the Categories page.
-- Idempotent.

-- 1) Default images (served from creator UI public assets).
UPDATE canonical_category SET default_image_url = '/mock-categories/outdoor-clothing.svg' WHERE id = 'outdoor-clothing';
UPDATE canonical_category SET default_image_url = '/mock-categories/womens-dress.svg' WHERE id = 'womens-dress';

UPDATE canonical_category SET default_image_url = '/mock-categories/makeup.svg' WHERE id = 'makeup';
UPDATE canonical_category SET default_image_url = '/mock-categories/skin-care.svg' WHERE id = 'skin-care';
UPDATE canonical_category SET default_image_url = '/mock-categories/facial-care.svg' WHERE id = 'facial-care';
UPDATE canonical_category SET default_image_url = '/mock-categories/haircare.svg' WHERE id = 'haircare';
UPDATE canonical_category SET default_image_url = '/mock-categories/eyelashes.svg' WHERE id = 'eyelashes';
UPDATE canonical_category SET default_image_url = '/mock-categories/beauty-tools.svg' WHERE id = 'beauty-tools';
UPDATE canonical_category SET default_image_url = '/mock-categories/beauty-devices.svg' WHERE id = 'beauty-devices';
UPDATE canonical_category SET default_image_url = '/mock-categories/contact-lens.svg' WHERE id = 'contact-lens';
UPDATE canonical_category SET default_image_url = '/mock-categories/nail-polish.svg' WHERE id = 'nail-polish';
UPDATE canonical_category SET default_image_url = '/mock-categories/press-on-nails.svg' WHERE id = 'press-on-nails';

UPDATE canonical_category SET default_image_url = '/mock-categories/camping-gear.svg' WHERE id = 'camping-gear';
UPDATE canonical_category SET default_image_url = '/mock-categories/hunting-accessories.svg' WHERE id = 'hunting-accessories';

UPDATE canonical_category SET default_image_url = '/mock-categories/pet-toys.svg' WHERE id = 'pet-toys';

-- 2) English display names must be consistent on the page.
INSERT INTO category_localization (category_id, locale, display_name, synonyms)
VALUES
  ('womens-loungewear', 'en-US', 'Women’s Loungewear', '["loungewear","sleepwear","pajamas","pyjamas","robe","homewear","lounge set","cozy"]'::jsonb),
  ('womens-dress', 'en-US', 'Women’s Dress', '["dress","dresses","gown","maxi dress","midi dress"]'::jsonb),
  ('pet-toys', 'en-US', 'Pets Toys', '["pets toys","pet toys","dog toy","cat toy","chew toy","pet plush"]'::jsonb)
ON CONFLICT (category_id, locale) DO UPDATE
SET display_name = EXCLUDED.display_name,
    synonyms = EXCLUDED.synonyms,
    updated_at = now();

-- 3) View overrides: make sure Fashion includes Toys (as requested) and Beauty nails children show.
UPDATE taxonomy_view_category
SET visibility_override = 'visible',
    priority_override = 85
WHERE view_id = 'GLOBAL_FASHION'
  AND category_id = 'toys';

-- Avoid duplicate/confusing cross-category for now (still exists for future use).
UPDATE taxonomy_view_category
SET visibility_override = 'hidden'
WHERE view_id = 'GLOBAL_FASHION'
  AND category_id = 'designer-toys';

-- Beauty: hide the intermediate "nails" node so its children lift to the top-level list.
UPDATE taxonomy_view_category
SET visibility_override = 'hidden'
WHERE view_id = 'GLOBAL_BEAUTY'
  AND category_id = 'nails';

-- Toys view: keep generic Toys visible; hide designer-toys by default (can be enabled later).
UPDATE taxonomy_view_category
SET visibility_override = 'hidden'
WHERE view_id = 'GLOBAL_TOYS'
  AND category_id = 'designer-toys';

-- 4) Ops pins: Top categories are Sportswear, Lingerie Set, Toys.
INSERT INTO ops_category_override (category_id, pinned, hidden, priority_boost, updated_by, reason)
VALUES
  ('sportswear', true, false, 40, 'seed', 'Top category'),
  ('lingerie-set', true, false, 30, 'seed', 'Top category'),
  ('toys', true, false, 20, 'seed', 'Top category'),
  ('womens-loungewear', false, false, 0, 'seed', 'Not a top category by default'),
  ('womens-dress', false, false, 0, 'seed', 'Not a top category by default'),
  ('other', false, true, -1000, 'seed', 'Never show Other in UI')
ON CONFLICT (category_id) DO UPDATE
SET pinned = EXCLUDED.pinned,
    hidden = EXCLUDED.hidden,
    priority_boost = EXCLUDED.priority_boost,
    updated_by = EXCLUDED.updated_by,
    reason = EXCLUDED.reason,
    updated_at = now();
