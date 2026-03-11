function normalizeDateToken(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const match = raw.match(/^(\d{4})[-/](\d{2})[-/](\d{2})$/);
  if (!match) return null;
  const [, year, month, day] = match;
  return `${year}-${month}-${day}`;
}

function normalizeDestination(value) {
  const raw = String(value || '')
    .replace(/^[\s"'`]+|[\s"'`]+$/g, '')
    .replace(/[。．.!?]+$/g, '')
    .trim();
  return raw || null;
}

function buildDatesLabel(startDate, endDate) {
  const start = normalizeDateToken(startDate);
  const end = normalizeDateToken(endDate);
  if (!start || !end) return null;
  return `${start} to ${end}`;
}

function normalizeTravelPlan(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const nestedDates = value.dates && typeof value.dates === 'object' && !Array.isArray(value.dates)
    ? value.dates
    : null;
  const destination = normalizeDestination(value.destination || value.city || value.location);
  const startDate = normalizeDateToken(
    value.start_date || value.startDate || nestedDates?.start || nestedDates?.start_date,
  );
  const endDate = normalizeDateToken(
    value.end_date || value.endDate || nestedDates?.end || nestedDates?.end_date,
  );
  const rawDates = typeof value.dates === 'string' ? value.dates.trim() : null;
  const dates = buildDatesLabel(startDate, endDate) || rawDates || null;

  if (!destination && !startDate && !endDate && !dates) return null;

  return {
    ...(destination ? { destination } : {}),
    ...(startDate ? { start_date: startDate } : {}),
    ...(endDate ? { end_date: endDate } : {}),
    ...(dates ? { dates } : {}),
  };
}

function extractTravelPlanFromMessage(message) {
  const raw = String(message || '').trim();
  if (!raw) return null;

  const canonicalEn = raw.match(/Destination\s*:\s*([^.\n]+)[.\n\r\s]+Dates\s*:\s*(\d{4}[-/]\d{2}[-/]\d{2})\s*(?:to|until|through|thru|->|—|-)\s*(\d{4}[-/]\d{2}[-/]\d{2})/i);
  if (canonicalEn) {
    return normalizeTravelPlan({
      destination: canonicalEn[1],
      start_date: canonicalEn[2],
      end_date: canonicalEn[3],
    });
  }

  const canonicalCn = raw.match(/目的地\s*[：:]\s*([^。.\n]+)[。.\n\r\s]+日期\s*[：:]\s*(\d{4}[-/]\d{2}[-/]\d{2})\s*(?:到|至|—|-|~|～)\s*(\d{4}[-/]\d{2}[-/]\d{2})/i);
  if (canonicalCn) {
    return normalizeTravelPlan({
      destination: canonicalCn[1],
      start_date: canonicalCn[2],
      end_date: canonicalCn[3],
    });
  }

  const freeformEn = raw.match(/(?:travel(?:ing)?\s+to|be\s+in|going\s+to)\s+([A-Za-z][A-Za-z\s.'-]{1,80}?)\s+(?:from|between)\s+(\d{4}[-/]\d{2}[-/]\d{2})\s*(?:to|until|through|thru|and|->|—|-)\s*(\d{4}[-/]\d{2}[-/]\d{2})/i);
  if (freeformEn) {
    return normalizeTravelPlan({
      destination: freeformEn[1],
      start_date: freeformEn[2],
      end_date: freeformEn[3],
    });
  }

  const freeformCn = raw.match(/(\d{4}[-/]\d{2}[-/]\d{2})\s*(?:到|至|—|-|~|～)\s*(\d{4}[-/]\d{2}[-/]\d{2}).{0,24}?(?:去|到|飞去|前往)([^。.\n]+)$/i);
  if (freeformCn) {
    return normalizeTravelPlan({
      destination: freeformCn[3],
      start_date: freeformCn[1],
      end_date: freeformCn[2],
    });
  }

  return null;
}

function resolveTravelPlanFromSources(...sources) {
  for (const source of sources) {
    const normalized = normalizeTravelPlan(source);
    if (normalized) return normalized;
  }
  return null;
}

function hasCompleteTravelPlan(value) {
  const plan = normalizeTravelPlan(value);
  if (!plan || !plan.destination) return false;
  return Boolean(plan.dates || (plan.start_date && plan.end_date));
}

function hasTravelCue(message) {
  const raw = String(message || '').trim();
  if (!raw) return false;
  return /travel|trip|destination\s*:|dates\s*:|travel plan|itinerary|旅行|行程|目的地|日期/i.test(raw);
}

module.exports = {
  buildDatesLabel,
  extractTravelPlanFromMessage,
  hasCompleteTravelPlan,
  hasTravelCue,
  normalizeTravelPlan,
  resolveTravelPlanFromSources,
};
