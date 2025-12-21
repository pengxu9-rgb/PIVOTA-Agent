-- Expand canonical taxonomy for upcoming categories (idempotent)
-- Adds roots: fashion, beauty, outdoor, pets (toys already exists as root)
-- Adds views: GLOBAL_BEAUTY, GLOBAL_OUTDOOR, GLOBAL_PETS, GLOBAL_TOYS

INSERT INTO taxonomy_view (view_id, market, status)
VALUES
  ('GLOBAL_BEAUTY', 'GLOBAL', 'active'),
  ('GLOBAL_OUTDOOR', 'GLOBAL', 'active'),
  ('GLOBAL_PETS', 'GLOBAL', 'active'),
  ('GLOBAL_TOYS', 'GLOBAL', 'active')
ON CONFLICT (view_id) DO UPDATE
SET market = EXCLUDED.market,
    status = EXCLUDED.status,
    updated_at = now();

INSERT INTO canonical_category (id, slug, parent_id, level, status, replaced_by_id, default_image_url, default_priority)
VALUES
  ('fashion', 'fashion', NULL, 0, 'active', NULL, NULL, 0),
  ('beauty', 'beauty', NULL, 0, 'active', NULL, NULL, 0),
  ('outdoor', 'outdoor', NULL, 0, 'active', NULL, NULL, 0),
  ('pets', 'pets', NULL, 0, 'active', NULL, NULL, 0),

  ('outdoor-clothing', 'outdoor-clothing', 'outdoor', 1, 'active', NULL, NULL, 40),
  ('womens-dress', 'womens-dress', 'fashion', 1, 'active', NULL, NULL, 60),

  ('makeup', 'makeup', 'beauty', 1, 'active', NULL, NULL, 60),
  ('skin-care', 'skin-care', 'beauty', 1, 'active', NULL, NULL, 65),
  ('facial-care', 'facial-care', 'skin-care', 2, 'active', NULL, NULL, 55),
  ('haircare', 'haircare', 'beauty', 1, 'active', NULL, NULL, 55),
  ('eyelashes', 'eyelashes', 'beauty', 1, 'active', NULL, NULL, 45),
  ('beauty-tools', 'beauty-tools', 'beauty', 1, 'active', NULL, NULL, 40),
  ('beauty-devices', 'beauty-devices', 'beauty', 1, 'active', NULL, NULL, 35),
  ('contact-lens', 'contact-lens', 'beauty', 1, 'active', NULL, NULL, 30),

  ('nails', 'nails', 'beauty', 1, 'active', NULL, NULL, 50),
  ('nail-polish', 'nail-polish', 'nails', 2, 'active', NULL, NULL, 45),
  ('press-on-nails', 'press-on-nails', 'nails', 2, 'active', NULL, NULL, 45),

  ('camping-gear', 'camping-gear', 'outdoor', 1, 'active', NULL, NULL, 50),
  ('hunting-accessories', 'hunting-accessories', 'outdoor', 1, 'active', NULL, NULL, 35),

  ('pet-toys', 'pet-toys', 'pets', 1, 'active', NULL, NULL, 45)
ON CONFLICT (id) DO UPDATE
SET slug = EXCLUDED.slug,
    parent_id = EXCLUDED.parent_id,
    level = EXCLUDED.level,
    status = EXCLUDED.status,
    replaced_by_id = EXCLUDED.replaced_by_id,
    default_image_url = EXCLUDED.default_image_url,
    default_priority = EXCLUDED.default_priority,
    updated_at = now();

-- Add pet apparel (dogs/cats clothing/shoes).
INSERT INTO canonical_category (id, slug, parent_id, level, status, replaced_by_id, default_image_url, default_priority)
VALUES
  ('pet-apparel', 'pet-apparel', 'pets', 1, 'active', NULL, NULL, 40)
ON CONFLICT (id) DO UPDATE
SET parent_id = EXCLUDED.parent_id,
    level = EXCLUDED.level,
    status = EXCLUDED.status,
    default_priority = EXCLUDED.default_priority,
    updated_at = now();

-- Update existing Fashion children to live under fashion root.
INSERT INTO canonical_category (id, slug, parent_id, level, status, replaced_by_id, default_image_url, default_priority)
VALUES
  ('sportswear', 'sportswear', 'fashion', 1, 'active', NULL, '/mock-categories/sportswear.svg', 100),
  ('lingerie-set', 'lingerie-set', 'fashion', 1, 'active', NULL, '/mock-categories/lingerie-set.svg', 90),
  ('womens-loungewear', 'womens-loungewear', 'fashion', 1, 'active', NULL, '/mock-categories/womens-loungewear.svg', 70),
  ('toys', 'toys', NULL, 0, 'active', NULL, '/mock-categories/toys.svg', 80)
ON CONFLICT (id) DO UPDATE
SET parent_id = EXCLUDED.parent_id,
    level = EXCLUDED.level,
    status = EXCLUDED.status,
    default_priority = EXCLUDED.default_priority,
    default_image_url = EXCLUDED.default_image_url,
    updated_at = now();

INSERT INTO category_localization (category_id, locale, display_name, synonyms)
VALUES
  ('fashion', 'en-US', 'Fashion', '["fashion","apparel","clothing","womenswear"]'::jsonb),
  ('beauty', 'en-US', 'Beauty', '["beauty","cosmetics","personal care"]'::jsonb),
  ('outdoor', 'en-US', 'Outdoor', '["outdoor","camping","hiking","adventure"]'::jsonb),
  ('pets', 'en-US', 'Pets', '["pets","pet supplies","pet care"]'::jsonb),
  ('pet-toys', 'en-US', 'Pet Toys', '["pet toys","dog toy","cat toy","chew toy","pet plush"]'::jsonb),

  ('womens-dress', 'en-US', 'Women''s Dress', '["dress","dresses","gown","maxi dress","midi dress"]'::jsonb),
  ('outdoor-clothing', 'en-US', 'Outdoor Clothing', '["outdoor clothing","hiking jacket","windbreaker","rain jacket"]'::jsonb),
  ('camping-gear', 'en-US', 'Camping Gear', '["camping","tent","sleeping bag","camp stove"]'::jsonb),
  ('hunting-accessories', 'en-US', 'Hunting Accessories', '["hunting","hunting accessories","scope","camouflage"]'::jsonb),

  ('makeup', 'en-US', 'Makeup', '["makeup","foundation","lipstick","concealer","blush","eyeshadow"]'::jsonb),
  ('skin-care', 'en-US', 'Skin Care', '["skin care","skincare","moisturizer","serum","cleanser","toner"]'::jsonb),
  ('facial-care', 'en-US', 'Facial Care', '["facial care","face mask","exfoliation","face wash"]'::jsonb),
  ('haircare', 'en-US', 'Haircare', '["haircare","shampoo","conditioner","hair oil","hair mask"]'::jsonb),
  ('eyelashes', 'en-US', 'Eyelashes', '["eyelashes","false lashes","lash extensions","lash glue"]'::jsonb),
  ('nails', 'en-US', 'Nails', '["nails","nail care","manicure","pedicure"]'::jsonb),
  ('nail-polish', 'en-US', 'Nail Polish', '["nail polish","polish","gel polish"]'::jsonb),
  ('press-on-nails', 'en-US', 'Press-On Nails', '["press on nails","press-ons","fake nails"]'::jsonb),
  ('beauty-tools', 'en-US', 'Beauty Tools', '["beauty tools","brush","sponge","applicator"]'::jsonb),
  ('beauty-devices', 'en-US', 'Beauty Devices', '["beauty device","LED mask","microcurrent","skin device"]'::jsonb),
  ('contact-lens', 'en-US', 'Contact Lens', '["contact lens","contacts","colored contacts","contact lenses"]'::jsonb),

  ('fashion', 'zh-CN', '服饰', '["服饰","服装","女装"]'::jsonb),
  ('beauty', 'zh-CN', '美妆', '["美妆","化妆品","个护"]'::jsonb),
  ('outdoor', 'zh-CN', '户外', '["户外","露营","徒步","探险"]'::jsonb),
  ('pets', 'zh-CN', '宠物', '["宠物","宠物用品","宠物护理"]'::jsonb),
  ('pet-toys', 'zh-CN', '宠物玩具', '["宠物玩具","狗玩具","猫玩具"]'::jsonb),
  ('pet-apparel', 'en-US', 'Pet Apparel', '["pet apparel","pet clothing","dog clothes","dog clothing","cat clothes","dog sweater","dog coat","dog onesie"]'::jsonb),
  ('pet-apparel', 'zh-CN', '宠物服饰', '["宠物服饰","宠物衣服","狗衣服","猫衣服","宠物鞋","狗鞋"]'::jsonb),

  ('womens-dress', 'zh-CN', '女式连衣裙', '["连衣裙","裙子","礼服"]'::jsonb),
  ('outdoor-clothing', 'zh-CN', '户外服装', '["户外服装","冲锋衣","风衣","雨衣"]'::jsonb),
  ('camping-gear', 'zh-CN', '露营装备', '["露营","帐篷","睡袋","炉具"]'::jsonb),
  ('hunting-accessories', 'zh-CN', '狩猎配件', '["狩猎","狩猎配件","迷彩"]'::jsonb),

  ('makeup', 'zh-CN', '彩妆', '["彩妆","粉底","口红","遮瑕","腮红","眼影"]'::jsonb),
  ('skin-care', 'zh-CN', '护肤', '["护肤","面霜","精华","洁面","爽肤水"]'::jsonb),
  ('facial-care', 'zh-CN', '面部护理', '["面部护理","面膜","去角质","洗面奶"]'::jsonb),
  ('haircare', 'zh-CN', '护发', '["护发","洗发水","护发素","发油","发膜"]'::jsonb),
  ('eyelashes', 'zh-CN', '假睫毛', '["假睫毛","睫毛","睫毛胶"]'::jsonb),
  ('nails', 'zh-CN', '美甲', '["美甲","指甲护理","修甲"]'::jsonb),
  ('nail-polish', 'zh-CN', '指甲油', '["指甲油","甲油胶"]'::jsonb),
  ('press-on-nails', 'zh-CN', '穿戴甲', '["穿戴甲","假指甲"]'::jsonb),
  ('beauty-tools', 'zh-CN', '美妆工具', '["美妆工具","化妆刷","美妆蛋"]'::jsonb),
  ('beauty-devices', 'zh-CN', '美容仪', '["美容仪","LED面罩","微电流"]'::jsonb),
  ('contact-lens', 'zh-CN', '隐形眼镜', '["隐形眼镜","美瞳"]'::jsonb)
ON CONFLICT (category_id, locale) DO UPDATE
SET display_name = EXCLUDED.display_name,
    synonyms = EXCLUDED.synonyms,
    updated_at = now();

-- View memberships (allowlists). Roots are included but hidden, so children lift to top-level in API response.
INSERT INTO taxonomy_view_category (view_id, category_id, visibility_override, priority_override, image_override)
VALUES
  -- Fashion view
  ('GLOBAL_FASHION', 'fashion', 'hidden', 0, NULL),
  ('GLOBAL_FASHION', 'sportswear', 'visible', 100, NULL),
  ('GLOBAL_FASHION', 'lingerie-set', 'visible', 90, NULL),
  ('GLOBAL_FASHION', 'toys', 'visible', 80, NULL),
  ('GLOBAL_FASHION', 'womens-loungewear', 'visible', 70, NULL),
  ('GLOBAL_FASHION', 'womens-dress', 'visible', 60, NULL),
  ('GLOBAL_FASHION', 'outdoor-clothing', 'visible', 40, NULL),
  ('GLOBAL_FASHION', 'other', 'hidden', -1000, NULL),

  -- Beauty view
  ('GLOBAL_BEAUTY', 'beauty', 'hidden', 0, NULL),
  ('GLOBAL_BEAUTY', 'makeup', 'visible', 60, NULL),
  ('GLOBAL_BEAUTY', 'skin-care', 'visible', 65, NULL),
  ('GLOBAL_BEAUTY', 'facial-care', 'visible', 55, NULL),
  ('GLOBAL_BEAUTY', 'haircare', 'visible', 55, NULL),
  ('GLOBAL_BEAUTY', 'eyelashes', 'visible', 45, NULL),
  ('GLOBAL_BEAUTY', 'nails', 'visible', 50, NULL),
  ('GLOBAL_BEAUTY', 'nail-polish', 'visible', 45, NULL),
  ('GLOBAL_BEAUTY', 'press-on-nails', 'visible', 45, NULL),
  ('GLOBAL_BEAUTY', 'beauty-tools', 'visible', 40, NULL),
  ('GLOBAL_BEAUTY', 'beauty-devices', 'visible', 35, NULL),
  ('GLOBAL_BEAUTY', 'contact-lens', 'visible', 30, NULL),
  ('GLOBAL_BEAUTY', 'other', 'hidden', -1000, NULL),

  -- Outdoor view
  ('GLOBAL_OUTDOOR', 'outdoor', 'hidden', 0, NULL),
  ('GLOBAL_OUTDOOR', 'outdoor-clothing', 'visible', 40, NULL),
  ('GLOBAL_OUTDOOR', 'camping-gear', 'visible', 50, NULL),
  ('GLOBAL_OUTDOOR', 'hunting-accessories', 'visible', 35, NULL),
  ('GLOBAL_OUTDOOR', 'other', 'hidden', -1000, NULL),

  -- Pets view
  ('GLOBAL_PETS', 'pets', 'hidden', 0, NULL),
  ('GLOBAL_PETS', 'pet-toys', 'visible', 45, NULL),
  ('GLOBAL_PETS', 'pet-apparel', 'visible', 50, NULL),
  ('GLOBAL_PETS', 'other', 'hidden', -1000, NULL),

  -- Toys view
  ('GLOBAL_TOYS', 'toys', 'visible', 80, NULL),
  ('GLOBAL_TOYS', 'other', 'hidden', -1000, NULL)
ON CONFLICT (view_id, category_id) DO UPDATE
SET visibility_override = EXCLUDED.visibility_override,
    priority_override = EXCLUDED.priority_override,
    image_override = COALESCE(EXCLUDED.image_override, taxonomy_view_category.image_override);
