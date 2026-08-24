'use strict';

/*
 * Anonymous, bounded storefront probe. It may add one item and follow the
 * checkout route, but it must never type buyer data, use payment, or submit.
 */

const CHECKOUT_STATUSES = new Set([
  'guest_route_detected', 'security_challenged_pre_address',
  'security_challenged', 'blocked', 'login_required', 'unavailable', 'unknown',
]);
const CART_STATUSES = new Set(['verified', 'unavailable', 'blocked', 'selection_required', 'unknown']);

function httpsUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash ? url.toString() : null;
  } catch {
    return null;
  }
}

function classifyCheckoutPage({ url = '', text = '' } = {}) {
  const target = `${url}\n${text}`.toLowerCase();
  if (/captcha|verify your access|unusual traffic|security check|challenge/.test(target)) {
    return { status: 'security_challenged_pre_address', challenge_stage: 'pre_address' };
  }
  if (/\/member\/login|\/account\/login|login\.html/.test(target)) return { status: 'login_required' };
  if (/checkout|orderform|checkouts\//.test(target)) return { status: 'guest_route_detected' };
  return { status: 'unknown' };
}

function platformFromGenerator(value) {
  const generator = String(value || '').toLowerCase();
  if (generator.includes('cafe24')) return { platform: 'cafe24', checkout_provider: 'cafe24' };
  if (generator.includes('shopify')) return { platform: 'shopify', checkout_provider: 'shopify' };
  if (generator.includes('woocommerce')) return { platform: 'woocommerce', checkout_provider: 'unknown' };
  if (generator.includes('bigcommerce')) return { platform: 'bigcommerce', checkout_provider: 'unknown' };
  if (generator.includes('magento')) return { platform: 'magento', checkout_provider: 'unknown' };
  return null;
}

async function visible(locator) {
  try { return await locator.count() > 0 && await locator.first().isVisible(); } catch { return false; }
}

async function shortPageText(page) {
  try { return String(await page.locator('body').innerText({ timeout: 1500 })).slice(0, 4000); } catch { return ''; }
}

function createCommerceStorefrontAudit({ playwright, now = () => new Date() } = {}) {
  async function audit({ targetUrl } = {}) {
    const startUrl = httpsUrl(targetUrl);
    if (!startUrl || !playwright || !playwright.chromium) {
      return { verification_status: 'failed', outcome_code: 'invalid_probe', observed_at: now().toISOString() };
    }
    let browser;
    try {
      browser = await playwright.chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
      const context = await browser.newContext({ serviceWorkers: 'block' });
      const page = await context.newPage();
      await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      const generator = await page.locator('meta[name="generator"]').first().getAttribute('content').catch(() => null);
      const platform = platformFromGenerator(generator);
      const initial = classifyCheckoutPage({ url: page.url(), text: await shortPageText(page) });
      if (initial.status === 'security_challenged_pre_address' || initial.status === 'login_required') {
        return { verification_status: 'succeeded', observed_at: now().toISOString(), ...(platform ? { platform } : {}), checkout: initial, cart: { status: 'blocked' } };
      }
      const addToCart = page.getByRole('button', { name: /add to (cart|bag)/i });
      if (!await visible(addToCart)) {
        return { verification_status: 'succeeded', observed_at: now().toISOString(), ...(platform ? { platform } : {}), checkout: { status: 'unavailable' }, cart: { status: 'unavailable' } };
      }
      await addToCart.first().click({ timeout: 5000 });
      await page.waitForTimeout(500);
      const checkoutButton = page.getByRole('button', { name: /^(checkout|check out|checkout all)$/i });
      const checkoutLink = page.getByRole('link', { name: /^(checkout|check out|checkout all)$/i });
      const candidate = await visible(checkoutButton) ? checkoutButton.first() : (await visible(checkoutLink) ? checkoutLink.first() : null);
      if (!candidate) {
        return { verification_status: 'succeeded', observed_at: now().toISOString(), ...(platform ? { platform } : {}), cart: { status: 'verified', quantity: 1 }, checkout: { status: 'unknown' } };
      }
      await candidate.click({ timeout: 5000 });
      await page.waitForTimeout(750);
      const checkout = classifyCheckoutPage({ url: page.url(), text: await shortPageText(page) });
      return { verification_status: 'succeeded', observed_at: now().toISOString(), ...(platform ? { platform } : {}), cart: { status: 'verified', quantity: 1 }, checkout };
    } catch (error) {
      const message = String(error && error.message || '').toLowerCase();
      return { verification_status: message.includes('timeout') ? 'failed' : 'blocked', outcome_code: message.includes('timeout') ? 'timeout' : 'network', observed_at: now().toISOString() };
    } finally {
      await browser?.close().catch(() => {});
    }
  }
  return { audit };
}

module.exports = { CART_STATUSES, CHECKOUT_STATUSES, classifyCheckoutPage, createCommerceStorefrontAudit, httpsUrl, platformFromGenerator };
