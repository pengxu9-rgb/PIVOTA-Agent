-- Switch category cover assets from SVG placeholders to the uploaded JPGs in pivota-creator-ui/public/mock-categories.
-- Idempotent.

UPDATE canonical_category SET default_image_url = '/mock-categories/sportswear.jpg' WHERE id = 'sportswear';
UPDATE canonical_category SET default_image_url = '/mock-categories/lingerie-set.jpg' WHERE id = 'lingerie-set';
UPDATE canonical_category SET default_image_url = '/mock-categories/toys.jpg' WHERE id = 'toys';
UPDATE canonical_category SET default_image_url = '/mock-categories/toys.jpg' WHERE id = 'designer-toys';
UPDATE canonical_category SET default_image_url = '/mock-categories/womens-loungewear.jpg' WHERE id = 'womens-loungewear';
UPDATE canonical_category SET default_image_url = '/mock-categories/womens-dress.jpg' WHERE id = 'womens-dress';
UPDATE canonical_category SET default_image_url = '/mock-categories/outdoor-clothing.jpg' WHERE id = 'outdoor-clothing';

UPDATE canonical_category SET default_image_url = '/mock-categories/makeup.jpg' WHERE id = 'makeup';
UPDATE canonical_category SET default_image_url = '/mock-categories/skin-care.jpg' WHERE id = 'skin-care';
UPDATE canonical_category SET default_image_url = '/mock-categories/facial-care.jpg' WHERE id = 'facial-care';
UPDATE canonical_category SET default_image_url = '/mock-categories/haircare.jpg' WHERE id = 'haircare';
UPDATE canonical_category SET default_image_url = '/mock-categories/eyelashes.jpg' WHERE id = 'eyelashes';
UPDATE canonical_category SET default_image_url = '/mock-categories/beauty-tools.jpg' WHERE id = 'beauty-tools';
UPDATE canonical_category SET default_image_url = '/mock-categories/beauty-devices.jpg' WHERE id = 'beauty-devices';
UPDATE canonical_category SET default_image_url = '/mock-categories/contact-lens.jpg' WHERE id = 'contact-lens';
UPDATE canonical_category SET default_image_url = '/mock-categories/nail-polish.jpg' WHERE id = 'nail-polish';
UPDATE canonical_category SET default_image_url = '/mock-categories/press-on-nails.jpg' WHERE id = 'press-on-nails';

UPDATE canonical_category SET default_image_url = '/mock-categories/camping-gear.jpg' WHERE id = 'camping-gear';
UPDATE canonical_category SET default_image_url = '/mock-categories/hunting-accessories.jpg' WHERE id = 'hunting-accessories';
UPDATE canonical_category SET default_image_url = '/mock-categories/pet-toys.jpg' WHERE id = 'pet-toys';

