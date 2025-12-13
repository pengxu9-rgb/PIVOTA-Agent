const ALLOWED_PLACEHOLDER = '{{NAME}}';
const NO_DIGITS_REGEX = /[\d\$€£¥]/;

function hasInvalidBraces(text) {
  if (text === undefined || text === null) return false;
  const str = String(text);
  const matches = str.match(/{{[^}]*}}/g) || [];
  for (const m of matches) {
    if (m !== ALLOWED_PLACEHOLDER) return true;
  }
  if (matches.length > 1) return true;
  // If any lone { or } exist, reject.
  if (/[{}]/.test(str.replace(new RegExp(ALLOWED_PLACEHOLDER, 'g'), ''))) {
    return true;
  }
  return false;
}

function containsDigits(text) {
  if (text === undefined || text === null) return false;
  return NO_DIGITS_REGEX.test(String(text));
}

function validateCopyOverrides(copy, expectedProductIds = [], maxItems, requireExactCount = false) {
  const errors = [];
  if (typeof copy !== 'object' || Array.isArray(copy)) {
    return { valid: false, errors: ['copy_overrides must be object'] };
  }
  const allowedTop = ['intro_text', 'items', 'follow_up_question_id'];
  Object.keys(copy).forEach((k) => {
    if (!allowedTop.includes(k)) {
      errors.push(`unexpected key ${k}`);
    }
  });

  if (copy.intro_text !== undefined) {
    if (hasInvalidBraces(copy.intro_text)) errors.push('invalid braces in intro_text');
    if (containsDigits(copy.intro_text)) errors.push('digits not allowed in intro_text');
  }

  if (!Array.isArray(copy.items)) {
    errors.push('items must be array');
  } else {
    if (requireExactCount && expectedProductIds && expectedProductIds.length >= 0) {
      if (copy.items.length !== expectedProductIds.length) {
        errors.push('item count mismatch');
      }
    } else if (maxItems !== undefined && copy.items.length > maxItems) {
      errors.push('too many items');
    }
    const expectedSet = new Set(expectedProductIds || []);
    const seenIds = new Set();
    copy.items.forEach((item, idx) => {
      if (!item || typeof item !== 'object') {
        errors.push(`items[${idx}] must be object`);
        return;
      }
      const itemAllowed = ['product_id', 'headline_tmpl', 'copy_tmpl', 'highlights'];
      Object.keys(item).forEach((k) => {
        if (!itemAllowed.includes(k)) errors.push(`items[${idx}] unexpected key ${k}`);
      });
      if (!item.product_id) errors.push(`items[${idx}] missing product_id`);
      if (item.product_id) {
        if (expectedSet.size && !expectedSet.has(item.product_id)) {
          errors.push(`items[${idx}] product_id not expected`);
        }
        if (seenIds.has(item.product_id)) {
          errors.push(`items[${idx}] product_id duplicated`);
        }
        seenIds.add(item.product_id);
      }
      ['headline_tmpl', 'copy_tmpl', ...(item.highlights || [])].forEach((field, fIdx) => {
        if (typeof field === 'string') {
          if (hasInvalidBraces(field)) errors.push(`items[${idx}] invalid braces`);
          if (containsDigits(field)) errors.push(`items[${idx}] has digits`);
        } else if (fIdx < 2) {
          // headline/copy may be undefined, but not other types
          if (field !== undefined && field !== null) {
            errors.push(`items[${idx}] field type invalid`);
          }
        }
      });
      if (item.highlights !== undefined) {
        if (!Array.isArray(item.highlights)) {
          errors.push(`items[${idx}] highlights must be array`);
        } else if (item.highlights.length > 3) {
          errors.push(`items[${idx}] highlights too long`);
        }
      }
    });
  }

  const valid = errors.length === 0;
  return { valid, errors };
}

module.exports = {
  validateCopyOverrides,
  hasInvalidBraces,
  containsDigits,
};
