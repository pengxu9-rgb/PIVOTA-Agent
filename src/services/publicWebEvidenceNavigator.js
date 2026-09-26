'use strict';

// Read-only browser discovery for Commerce Index public_web evidence sources.
// It deliberately discovers links only: no policy/review pages are opened, and
// product, cart, checkout, API, and third-party requests are blocked.

const nodeNet = require('node:net');
const { createPublicOnlyConnectProxy } = require('./publicOnlyConnectProxy');
const { validatePublicBrowserUrl } = require('./commerceStorefrontAudit');

const POLICY = /return|refund|exchange|shipping|delivery|policy/i;
const REVIEWS = /review|rating|testimonial|feedback/i;
const NON_AFTER_SALES = /privacy|cookie|security|accessibility/i;
const FORBIDDEN_PATH = /\/(?:cart|checkout|checkouts|products?|collections?|api)(?:\/|$)/i;

function canonicalHttps(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || nodeNet.isIP(url.hostname)) return null;
    return url;
  } catch { return null; }
}

function hostSet(url) {
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  return new Set([host, `www.${host}`]);
}

function wildcardMatch(path, pattern) {
  const escaped = String(pattern || '').replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}`).test(path);
}

function robotsAllows(robotsText, userAgent, targetUrl) {
  const groups = []; let current = null;
  for (const rawLine of String(robotsText || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    if (!line) { current = null; continue; }
    const match = /^([^:]+):\s*(.*)$/i.exec(line); if (!match) continue;
    const key = match[1].trim().toLowerCase(); const value = match[2].trim();
    if (key === 'user-agent') {
      if (!current || current.rules.length) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase()); continue;
    }
    if (current && (key === 'allow' || key === 'disallow') && value) current.rules.push({ key, value });
  }
  const normalizedAgent = String(userAgent || '').toLowerCase();
  let best = []; let score = -1;
  for (const group of groups) {
    const matched = group.agents.filter((agent) => agent === '*' || normalizedAgent.includes(agent));
    const groupScore = matched.reduce((max, agent) => Math.max(max, agent === '*' ? 0 : agent.length), -1);
    if (groupScore > score) { best = group.rules; score = groupScore; }
  }
  if (score < 0) return false; // Unknown policy never grants browser authority.
  const path = `${targetUrl.pathname || '/'}${targetUrl.search || ''}`;
  let verdict = true; let length = -1;
  for (const rule of best) {
    if (wildcardMatch(path, rule.value) && rule.value.length >= length) {
      verdict = rule.key === 'allow'; length = rule.value.length;
    }
  }
  return verdict;
}

function normalizeTargets(rawTargets) {
  if (!Array.isArray(rawTargets)) return [];
  return rawTargets.slice(0, 10).map((raw) => {
    const base = canonicalHttps(raw && raw.base_url);
    const policy = raw && raw.crawl_policy;
    if (!base || !raw.merchant_id || !policy || policy.evidence_only !== true || policy.robots_checked !== true) return null;
    return { merchant_id: String(raw.merchant_id), market: String(raw.market || 'unknown'), base };
  }).filter(Boolean);
}

function candidateLinks(links, hosts) {
  const result = { return_policy: [], after_sales_reviews: [] }; const seen = new Set();
  for (const link of links || []) {
    const url = canonicalHttps(link && link.href); if (!url || !hosts.has(url.hostname.toLowerCase()) || FORBIDDEN_PATH.test(url.pathname) || seen.has(url.toString())) continue;
    seen.add(url.toString()); const candidate = { url: url.toString(), label: String(link.text || '').replace(/\s+/g, ' ').trim().slice(0, 160) || null };
    const marker = `${candidate.url} ${candidate.label || ''}`;
    if (POLICY.test(marker) && !NON_AFTER_SALES.test(marker) && result.return_policy.length < 8) result.return_policy.push(candidate);
    if (REVIEWS.test(marker) && result.after_sales_reviews.length < 8) result.after_sales_reviews.push(candidate);
  }
  return result;
}

function createPublicWebEvidenceNavigator({ playwright, fetchImpl = global.fetch, validateUrl = validatePublicBrowserUrl, connectProxyFactory = createPublicOnlyConnectProxy, userAgent = 'PivotaCommerceIndexBot/0.1 (+https://pivota.cc/bot)', now = () => new Date() } = {}) {
  async function fetchRobots(base, hosts) {
    let robotsUrl = new URL('/robots.txt', base).toString();
    for (let hop = 0; hop < 2; hop += 1) {
      if (!(await validateUrl(robotsUrl)).ok) return { url: robotsUrl, response: null };
      const response = await fetchImpl(robotsUrl, { headers: { 'user-agent': userAgent }, redirect: 'manual' });
      if (![301, 302, 307, 308].includes(response && response.status)) return { url: robotsUrl, response };
      const location = canonicalHttps(response.headers && response.headers.get('location'));
      if (!location || !hosts.has(location.hostname.toLowerCase())) return { url: robotsUrl, response: null };
      robotsUrl = location.toString();
    }
    return { url: robotsUrl, response: null };
  }

  async function discover({ targets } = {}) {
    const results = [];
    for (const target of normalizeTargets(targets)) {
      const hosts = hostSet(target.base); const robotsUrl = new URL('/robots.txt', target.base).toString();
      const row = { merchant_id: target.merchant_id, market: target.market, base_url: target.base.toString(), observed_at: now().toISOString(), mode: 'browser_navigation_dry_run', facts_written: 0, projections_written: 0, robots: { url: robotsUrl, decision: 'unverified_blocked' }, proposed_evidence: { return_policy: [], after_sales_reviews: [] } };
      try {
        const fetched = await fetchRobots(target.base, hosts); const robots = fetched.response;
        row.robots.url = fetched.url;
        row.robots.status = robots && robots.status;
        if (!robots || robots.status !== 200 || !robotsAllows(await robots.text(), userAgent, target.base)) { row.robots.decision = 'disallowed_or_unverified'; results.push(row); continue; }
        row.robots.decision = 'allowed';
        if (!playwright || !playwright.chromium) { row.outcome = 'browser_unavailable'; results.push(row); continue; }
        const proxyServer = connectProxyFactory(); const proxy = await proxyServer.start();
        let browser;
        try {
          browser = await playwright.chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', '--disable-quic'], proxy });
          const context = await browser.newContext({ serviceWorkers: 'block', userAgent });
          await context.route('**/*', async (route) => {
            const requestUrl = canonicalHttps(route.request().url());
            if (!requestUrl || !hosts.has(requestUrl.hostname.toLowerCase()) || FORBIDDEN_PATH.test(requestUrl.pathname) || !(await validateUrl(requestUrl.toString())).ok) return route.abort('blockedbyclient');
            return route.continue();
          });
          const page = await context.newPage();
          await page.goto(target.base.toString(), { waitUntil: 'domcontentloaded', timeout: 20000 });
          await page.waitForTimeout(750);
          const links = await page.locator('a[href]').evaluateAll((anchors) => anchors.slice(0, 1000).map((a) => ({ href: a.href, text: a.textContent || '' })));
          row.proposed_evidence = candidateLinks(links, hosts); row.outcome = 'candidates_discovered';
        } finally { await browser?.close().catch(() => {}); await proxyServer.close().catch(() => {}); }
      } catch (error) { row.outcome = String(error && error.message || 'browser_error').slice(0, 120); }
      results.push(row);
    }
    return { mode: 'browser_navigation_dry_run', facts_written: 0, projections_written: 0, results };
  }
  return { discover, normalizeTargets, robotsAllows };
}

module.exports = { candidateLinks, createPublicWebEvidenceNavigator, normalizeTargets, robotsAllows };
