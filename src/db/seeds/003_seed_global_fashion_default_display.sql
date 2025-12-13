-- GLOBAL_FASHION default display set (launch phase).
-- Uses view overrides (taxonomy_view_category) to control visibility and ordering within GLOBAL_FASHION.
-- Idempotent.

-- 1) Hide everything in GLOBAL_FASHION by default (except allowlist + bookkeeping nodes).
UPDATE taxonomy_view_category
SET visibility_override = 'hidden'
WHERE view_id = 'GLOBAL_FASHION'
  AND category_id NOT IN (
    'sportswear',
    'lingerie-set',
    'womens-loungewear',
    'womens-dress',
    'outdoor-clothing',
    'fashion',
    'other'
  );

-- 2) Ensure allowlist is visible and ordered (priority_override).
UPDATE taxonomy_view_category
SET visibility_override = 'visible',
    priority_override = 100
WHERE view_id = 'GLOBAL_FASHION' AND category_id = 'sportswear';

UPDATE taxonomy_view_category
SET visibility_override = 'visible',
    priority_override = 90
WHERE view_id = 'GLOBAL_FASHION' AND category_id = 'lingerie-set';

UPDATE taxonomy_view_category
SET visibility_override = 'visible',
    priority_override = 80
WHERE view_id = 'GLOBAL_FASHION' AND category_id = 'womens-loungewear';

UPDATE taxonomy_view_category
SET visibility_override = 'visible',
    priority_override = 70
WHERE view_id = 'GLOBAL_FASHION' AND category_id = 'womens-dress';

-- Optional cross category (visible but not pinned at ops level).
UPDATE taxonomy_view_category
SET visibility_override = 'visible',
    priority_override = 60
WHERE view_id = 'GLOBAL_FASHION' AND category_id = 'outdoor-clothing';

-- 3) Keep Fashion root hidden (children are lifted by API).
UPDATE taxonomy_view_category
SET visibility_override = 'hidden',
    priority_override = 0
WHERE view_id = 'GLOBAL_FASHION' AND category_id = 'fashion';

-- 4) Double-ensure Other is hidden.
UPDATE taxonomy_view_category
SET visibility_override = 'hidden',
    priority_override = -1000
WHERE view_id = 'GLOBAL_FASHION' AND category_id = 'other';

-- 5) Ops pins for stable top categories (global).
INSERT INTO ops_category_override (category_id, pinned, hidden, priority_boost, updated_by, reason)
VALUES
  ('sportswear', true, false, 30, 'seed', 'GLOBAL_FASHION launch: top category'),
  ('lingerie-set', true, false, 20, 'seed', 'GLOBAL_FASHION launch: top category'),
  ('womens-loungewear', true, false, 15, 'seed', 'GLOBAL_FASHION launch: top category'),
  ('womens-dress', true, false, 10, 'seed', 'GLOBAL_FASHION launch: top category'),
  ('other', false, true, -1000, 'seed', 'Never show Other in UI')
ON CONFLICT (category_id) DO UPDATE
SET pinned = EXCLUDED.pinned,
    hidden = EXCLUDED.hidden,
    priority_boost = EXCLUDED.priority_boost,
    updated_by = EXCLUDED.updated_by,
    reason = EXCLUDED.reason,
    updated_at = now();

