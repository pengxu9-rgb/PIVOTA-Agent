function normalizeOfferMoney(amount, currency) {
  const raw = amount;
  let normalizedAmount = 0;
  let normalizedCurrency = String(currency || 'USD').toUpperCase() || 'USD';

  if (typeof raw === 'number') {
    normalizedAmount = raw;
  } else if (typeof raw === 'string') {
    normalizedAmount = Number(raw) || 0;
  } else if (raw && typeof raw === 'object') {
    const candidateAmount =
      raw.amount ??
      raw.current?.amount ??
      raw.price ??
      raw.value ??
      null;
    if (typeof candidateAmount === 'number') normalizedAmount = candidateAmount;
    else if (typeof candidateAmount === 'string') normalizedAmount = Number(candidateAmount) || 0;

    const candidateCurrency =
      raw.currency ??
      raw.current?.currency ??
      raw.currency_code ??
      null;
    if (typeof candidateCurrency === 'string' && candidateCurrency.trim()) {
      normalizedCurrency = candidateCurrency.trim().toUpperCase();
    }
  }

  return {
    amount: Number(normalizedAmount) || 0,
    currency: normalizedCurrency,
  };
}

module.exports = {
  normalizeOfferMoney,
};
