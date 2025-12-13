-- Seed GLOBAL_FASHION view + core categories (idempotent)

INSERT INTO taxonomy_view (view_id, market, status)
VALUES ('GLOBAL_FASHION', 'GLOBAL', 'active')
ON CONFLICT (view_id) DO UPDATE
SET market = EXCLUDED.market,
    status = EXCLUDED.status,
    updated_at = now();

-- Core categories. Keep id == slug for stable identifiers.
INSERT INTO canonical_category (id, slug, parent_id, level, status, replaced_by_id, default_image_url, default_priority)
VALUES
  ('sportswear', 'sportswear', NULL, 0, 'active', NULL, '/mock-categories/sportswear.svg', 100),
  ('lingerie-set', 'lingerie-set', NULL, 0, 'active', NULL, '/mock-categories/lingerie-set.svg', 90),
  ('toys', 'toys', NULL, 0, 'active', NULL, '/mock-categories/toys.svg', 80),
  ('womens-loungewear', 'womens-loungewear', NULL, 0, 'active', NULL, '/mock-categories/womens-loungewear.svg', 70),
  ('other', 'other', NULL, 0, 'hidden', NULL, NULL, -1000)
ON CONFLICT (id) DO UPDATE
SET slug = EXCLUDED.slug,
    parent_id = EXCLUDED.parent_id,
    level = EXCLUDED.level,
    status = EXCLUDED.status,
    replaced_by_id = EXCLUDED.replaced_by_id,
    default_image_url = EXCLUDED.default_image_url,
    default_priority = EXCLUDED.default_priority,
    updated_at = now();

INSERT INTO category_localization (category_id, locale, display_name, synonyms)
VALUES
  ('sportswear', 'en-US', 'Sportswear', '["sportswear","activewear","athleisure","workout","gym","yoga","running","leggings","sports bra"]'::jsonb),
  ('lingerie-set', 'en-US', 'Lingerie Set', '["lingerie","bra","panty","panties","underwear","lace"]'::jsonb),
  ('toys', 'en-US', 'Toys', '["toy","plush","stuffed","doll","figure"]'::jsonb),
  ('womens-loungewear', 'en-US', 'Women''s Loungewear', '["loungewear","sleepwear","pajamas","pyjamas","robe","homewear","lounge set","cozy"]'::jsonb),
  ('sportswear', 'zh-CN', '运动服饰', '["运动","运动服","瑜伽","健身","跑步","紧身裤","运动内衣"]'::jsonb),
  ('lingerie-set', 'zh-CN', '内衣套装', '["内衣","文胸","胸罩","内裤","蕾丝"]'::jsonb),
  ('toys', 'zh-CN', '玩具', '["玩具","毛绒","公仔","娃娃","手办"]'::jsonb),
  ('womens-loungewear', 'zh-CN', '女式家居服', '["家居服","睡衣","居家","浴袍","舒适"]'::jsonb)
ON CONFLICT (category_id, locale) DO UPDATE
SET display_name = EXCLUDED.display_name,
    synonyms = EXCLUDED.synonyms,
    updated_at = now();

-- Membership in GLOBAL_FASHION (explicit allowlist)
INSERT INTO taxonomy_view_category (view_id, category_id, visibility_override, priority_override, image_override)
VALUES
  ('GLOBAL_FASHION', 'sportswear', 'visible', 100, NULL),
  ('GLOBAL_FASHION', 'lingerie-set', 'visible', 90, NULL),
  ('GLOBAL_FASHION', 'toys', 'visible', 80, NULL),
  ('GLOBAL_FASHION', 'womens-loungewear', 'visible', 70, NULL),
  ('GLOBAL_FASHION', 'other', 'hidden', -1000, NULL)
ON CONFLICT (view_id, category_id) DO UPDATE
SET visibility_override = EXCLUDED.visibility_override,
    priority_override = EXCLUDED.priority_override,
    image_override = COALESCE(EXCLUDED.image_override, taxonomy_view_category.image_override);

-- Ops-level pins (v1 defaults): Sportswear, Lingerie Set, Toys
INSERT INTO ops_category_override (category_id, pinned, hidden, priority_boost, updated_by, reason)
VALUES
  ('sportswear', true, false, 30, 'seed', 'Default top category'),
  ('lingerie-set', true, false, 20, 'seed', 'Default top category'),
  ('toys', true, false, 10, 'seed', 'Default top category'),
  ('other', false, true, -1000, 'seed', 'Never show Other in UI')
ON CONFLICT (category_id) DO UPDATE
SET pinned = EXCLUDED.pinned,
    hidden = EXCLUDED.hidden,
    priority_boost = EXCLUDED.priority_boost,
    updated_by = EXCLUDED.updated_by,
    reason = EXCLUDED.reason,
    updated_at = now();

