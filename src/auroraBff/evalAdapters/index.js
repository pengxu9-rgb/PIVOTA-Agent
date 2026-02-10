'use strict';

const lapa = require('./lapaAdapter');
const celebamaskhq = require('./celebamaskAdapter');
const fasseg = require('./fassegAdapter');
const acne04 = require('./acne04Adapter');

const ADAPTERS = Object.freeze({
  lapa,
  celebamaskhq,
  fasseg,
  acne04,
});

function normalizeDatasetName(input) {
  const token = String(input || '').trim().toLowerCase();
  if (!token) return '';
  if (token === 'celebamask-hq' || token === 'celebamask_hq') return 'celebamaskhq';
  return token;
}

function getAdapter(name) {
  const normalized = normalizeDatasetName(name);
  return ADAPTERS[normalized] || null;
}

function listAdapters() {
  return Object.keys(ADAPTERS);
}

module.exports = {
  ADAPTERS,
  normalizeDatasetName,
  getAdapter,
  listAdapters,
};
