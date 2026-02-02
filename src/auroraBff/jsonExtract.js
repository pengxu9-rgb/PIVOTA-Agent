function extractJsonObject(text) {
  if (!text || typeof text !== 'string') return null;

  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const candidate = extractBraced(text, start);
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // continue
    }
  }
  return null;
}

function extractBraced(text, startIdx) {
  let depth = 0;
  let inStr = false;
  let escape = false;
  let end = null;

  for (let i = startIdx; i < text.length; i += 1) {
    const ch = text[i];

    if (inStr) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\\\') {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inStr = false;
      }
      continue;
    }

    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  if (end == null || depth !== 0) return null;
  return text.slice(startIdx, end + 1);
}

module.exports = { extractJsonObject };

