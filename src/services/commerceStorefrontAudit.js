'use strict';

const nodeDns = require('node:dns');
const nodeNet = require('node:net');
const { validatePublicHttpsImageUrl } = require('../photoBackendClient');
const { createPublicOnlyConnectProxy } = require('./publicOnlyConnectProxy');

/*
 * Anonymous, bounded storefront journey. It may search for one product, add
 * one item, follow checkout, and fill Pivota-owned synthetic shipping data.
 * It never enters payment data and never clicks a pay/place-order control.
 */

const CHECKOUT_STATUSES = new Set([
  'guest_route_detected', 'security_challenged_pre_address',
  'security_challenged', 'blocked', 'login_required', 'unavailable', 'unknown',
]);
const CART_STATUSES = new Set(['verified', 'unavailable', 'blocked', 'selection_required', 'unknown']);
const STEP_STATUSES = new Set(['passed', 'failed', 'blocked', 'not_supported', 'not_run']);
const STEP_REASONS = new Set([
  'storefront_loaded', 'search_result_found', 'search_unavailable',
  'search_no_result', 'pdp_confirmed', 'pdp_unconfirmed', 'cart_item_added',
  'cart_control_unavailable', 'checkout_reached', 'checkout_route_missing',
  'address_fields_filled', 'address_form_unavailable', 'challenge',
  'login_required', 'network', 'timeout', 'not_attempted',
]);
const STEP_NAMES = [
  'storefront_access', 'product_search', 'product_detail',
  'add_to_cart', 'shipping_address', 'checkout',
];

function httpsUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && !url.search && !url.hash && !nodeNet.isIP(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
}

async function validatePublicBrowserUrl(value, { lookup = nodeDns.promises.lookup, validateUrl = validatePublicHttpsImageUrl } = {}) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { return { ok: false }; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !url.hostname || nodeNet.isIP(url.hostname)) return { ok: false };
  const result = await validateUrl(url.toString(), { lookup });
  return result && result.ok ? { ok: true } : { ok: false };
}

function classifyCheckoutPage({ url = '', text = '' } = {}) {
  const target = String(url) + '\n' + String(text);
  const normalized = target.toLowerCase();
  if (/captcha|verify your access|unusual traffic|security check|challenge/.test(normalized)) {
    return { status: 'security_challenged_pre_address', challenge_stage: 'pre_address' };
  }
  if (/\/member\/login|\/account\/login|login\.html/.test(normalized)) return { status: 'login_required' };
  if (/checkout|orderform|checkouts\//.test(normalized)) return { status: 'guest_route_detected' };
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

function sanitizeSearchQuery(value) {
  return String(value || '')
    .replace(/\s*[|–—-]\s*[^|–—-]{1,60}$/u, '')
    .replace(/\s+/g, ' ').trim().slice(0, 120);
}

function journeySteps(overrides = {}) {
  return STEP_NAMES.map((step) => {
    const item = overrides[step] || { status: 'not_run', reason: 'not_attempted' };
    return { step, status: item.status, reason: item.reason };
  });
}

async function visible(locator) {
  try { return await locator.count() > 0 && await locator.first().isVisible(); } catch { return false; }
}

async function firstVisible(...locators) {
  for (const locator of locators) if (locator && await visible(locator)) return locator.first();
  return null;
}

async function shortPageText(page) {
  try { return String(await page.locator('body').innerText({ timeout: 1500 })).slice(0, 4000); } catch { return ''; }
}

async function productTitle(page) {
  let h1 = ''; let og = ''; let title = '';
  try { h1 = await page.locator('h1').first().innerText({ timeout: 1000 }); } catch {}
  try { og = await page.locator('meta[property="og:title"]').first().getAttribute('content'); } catch {}
  try { title = typeof page.title === 'function' ? await page.title() : ''; } catch {}
  return sanitizeSearchQuery(h1 || og || title);
}

async function dismissBlockingDialogs(page) {
  const dialogs = page.getByRole('dialog');
  const count = await dialogs.count().catch(() => 0);
  for (let index = 0; index < Math.min(count, 4); index += 1) {
    const dialog = dialogs.nth(index);
    if (!(await visible(dialog))) continue;
    const close = await firstVisible(
      dialog.getByRole('button', { name: /^(close|close dialog|no thanks|not now)$/i }),
      dialog.locator('[aria-label*="close" i]'),
    );
    if (close) {
      await close.click({ timeout: 1500 }).catch(() => {});
      await page.waitForTimeout(150);
    }
  }
}

async function searchFromStorefront(page, { startUrl, query }) {
  if (!query) return { status: 'not_supported', reason: 'search_unavailable' };
  const home = new URL('/', startUrl).toString();
  await page.goto(home, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await dismissBlockingDialogs(page);
  let search = await firstVisible(
    page.getByRole('searchbox'),
    page.locator('input[type="search"]'),
    page.locator('input[name*="search" i]'),
    page.locator('input[placeholder*="search" i]'),
  );
  if (!search) {
    const opener = await firstVisible(
      page.getByRole('button', { name: /^search$/i }),
      page.getByRole('link', { name: /^search$/i }),
      page.locator('[aria-label="Search"]'),
    );
    if (opener) {
      await opener.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(250);
      search = await firstVisible(
        page.getByRole('searchbox'),
        page.locator('input[type="search"]'),
        page.locator('input[name*="search" i]'),
        page.locator('input[placeholder*="search" i]'),
      );
    }
  }
  if (!search) return { status: 'not_supported', reason: 'search_unavailable' };
  await search.fill(query, { timeout: 3000 });
  await search.press('Enter', { timeout: 3000 });
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(500);
  const targetPath = new URL(startUrl).pathname.replace(/\/$/, '');
  const found = await page.locator('a[href]').evaluateAll((nodes, path) => nodes.some((node) => {
    try { return new URL(node.href).pathname.replace(/\/$/, '') === path; } catch { return false; }
  }), targetPath).catch(() => false);
  return found
    ? { status: 'passed', reason: 'search_result_found' }
    : { status: 'failed', reason: 'search_no_result' };
}

async function fillSyntheticAddress(page) {
  const fill = async (selectors, value) => {
    const locator = await firstVisible(...selectors.map((selector) => page.locator(selector)));
    if (!locator) return false;
    await locator.fill(value, { timeout: 2500 }).catch(() => {});
    return true;
  };
  // Checkout frameworks often rebuild the address form after country changes.
  // Select the country first, then locate and fill the current controls.
  const country = await firstVisible(
    page.locator('select[name*="country" i]'), page.locator('select[autocomplete="country"]'),
  );
  if (country) {
    await country.selectOption({ label: 'United States' }).catch(() => country.selectOption('US').catch(() => {}));
    await page.waitForTimeout(500);
  }
  const filled = {
    email: await fill(['input[type="email"]', 'input[name*="email" i]'], 'store-readiness-probe@pivota.cc'),
    first: await fill(['input[name*="first" i]', 'input[autocomplete="given-name"]'], 'Pivota'),
    last: await fill(['input[name*="last" i]', 'input[autocomplete="family-name"]'], 'Readiness Probe'),
    address: await fill(['input[name*="address1" i]', 'input[name="address"]', 'input[autocomplete="address-line1"]'], '1 Test Street'),
    city: await fill(['input[name*="city" i]', 'input[autocomplete="address-level2"]'], 'Beverly Hills'),
    postal: await fill(['input[name*="zip" i]', 'input[name*="postal" i]', 'input[autocomplete="postal-code"]'], '90210'),
  };
  const state = await firstVisible(
    page.locator('select[name*="zone" i]'), page.locator('select[name*="state" i]'),
    page.locator('select[autocomplete="address-level1"]'),
  );
  if (state) await state.selectOption({ label: 'California' }).catch(() => state.selectOption('CA').catch(() => {}));
  if (!filled.address || !filled.city || !filled.postal) {
    return { status: 'not_supported', reason: 'address_form_unavailable' };
  }
  // Filling these synthetic fields is enough to prove the address stage. The
  // worker does not click Pay, Place order, Complete order, or an equivalent.
  return { status: 'passed', reason: 'address_fields_filled' };
}

function createCommerceStorefrontAudit({ playwright, now = () => new Date(), validateUrl = validatePublicBrowserUrl, connectProxyFactory = createPublicOnlyConnectProxy } = {}) {
  async function audit({ targetUrl } = {}) {
    const startUrl = httpsUrl(targetUrl);
    const steps = {};
    const output = (value) => ({ ...value, steps: journeySteps(steps) });
    if (!startUrl || !playwright || !playwright.chromium) {
      return output({ verification_status: 'failed', outcome_code: 'invalid_probe', observed_at: now().toISOString() });
    }
    if (!(await validateUrl(startUrl)).ok) {
      return output({ verification_status: 'blocked', outcome_code: 'invalid_probe', observed_at: now().toISOString() });
    }
    let browser; let connectProxy;
    try {
      connectProxy = connectProxyFactory();
      const proxy = await connectProxy.start();
      if (!proxy || !proxy.server) throw new Error('public_connect_proxy_unavailable');
      browser = await playwright.chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', '--disable-quic'], proxy });
      const context = await browser.newContext({ serviceWorkers: 'block' });
      await context.route('**/*', async (route) => {
        const allowed = await validateUrl(route.request().url());
        if (!allowed.ok) return route.abort('blockedbyclient');
        return route.continue();
      });
      const page = await context.newPage();
      await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      steps.storefront_access = { status: 'passed', reason: 'storefront_loaded' };
      const generator = await page.locator('meta[name="generator"]').first().getAttribute('content').catch(() => null);
      const platform = platformFromGenerator(generator);
      const initial = classifyCheckoutPage({ url: page.url(), text: await shortPageText(page) });
      if (initial.status === 'security_challenged_pre_address' || initial.status === 'login_required') {
        const reason = initial.status === 'login_required' ? 'login_required' : 'challenge';
        steps.storefront_access = { status: 'blocked', reason };
        for (const name of STEP_NAMES.slice(1)) steps[name] = { status: 'blocked', reason };
        return output({ verification_status: 'succeeded', observed_at: now().toISOString(), ...(platform ? { platform } : {}), checkout: initial, cart: { status: 'blocked' } });
      }

      const query = await productTitle(page);
      steps.product_search = await searchFromStorefront(page, { startUrl, query }).catch(() => ({ status: 'failed', reason: 'search_no_result' }));
      await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      const addToCart = await firstVisible(
        page.getByRole('button', { name: /add to (cart|bag)/i }),
        page.locator('button[name="add"]'),
        page.locator('[data-add-to-cart]'),
      );
      const hasProductIdentity = Boolean(await productTitle(page));
      steps.product_detail = hasProductIdentity && addToCart
        ? { status: 'passed', reason: 'pdp_confirmed' }
        : { status: 'failed', reason: 'pdp_unconfirmed' };
      if (!addToCart) {
        steps.add_to_cart = { status: 'failed', reason: 'cart_control_unavailable' };
        steps.shipping_address = { status: 'not_run', reason: 'not_attempted' };
        steps.checkout = { status: 'failed', reason: 'checkout_route_missing' };
        return output({ verification_status: 'succeeded', observed_at: now().toISOString(), ...(platform ? { platform } : {}), checkout: { status: 'unavailable' }, cart: { status: 'unavailable' } });
      }
      await addToCart.click({ timeout: 5000 });
      await page.waitForTimeout(700);
      steps.add_to_cart = { status: 'passed', reason: 'cart_item_added' };

      let checkoutControl = await firstVisible(
        page.getByRole('button', { name: /^(checkout|check out|checkout all)$/i }),
        page.getByRole('link', { name: /^(checkout|check out|checkout all)$/i }),
      );
      if (!checkoutControl) {
        const cartControl = await firstVisible(
          page.getByRole('link', { name: /^(cart|bag|view cart|view bag)$/i }),
          page.locator('a[href*="/cart"]'),
        );
        if (cartControl) {
          await cartControl.click({ timeout: 5000 }).catch(() => {});
          await page.waitForTimeout(500);
          checkoutControl = await firstVisible(
            page.getByRole('button', { name: /^(checkout|check out|checkout all)$/i }),
            page.getByRole('link', { name: /^(checkout|check out|checkout all)$/i }),
          );
        }
      }
      if (!checkoutControl) {
        steps.checkout = { status: 'failed', reason: 'checkout_route_missing' };
        steps.shipping_address = { status: 'not_run', reason: 'not_attempted' };
        return output({ verification_status: 'succeeded', observed_at: now().toISOString(), ...(platform ? { platform } : {}), cart: { status: 'verified', quantity: 1 }, checkout: { status: 'unknown' } });
      }
      await checkoutControl.click({ timeout: 5000 });
      await page.waitForTimeout(1000);
      // Some Shopify themes leave their checkout form submission on /cart.
      // The canonical guest checkout route is a safe, same-origin fallback.
      if (platform?.platform === 'shopify' && /\/cart\/?(?:[?#].*)?$/.test(new URL(page.url()).pathname)) {
        await page.goto(new URL('/checkout', startUrl).toString(), { waitUntil: 'domcontentloaded', timeout: 20000 });
      }
      const checkout = classifyCheckoutPage({ url: page.url(), text: await shortPageText(page) });
      if (checkout.status === 'guest_route_detected') {
        steps.checkout = { status: 'passed', reason: 'checkout_reached' };
        steps.shipping_address = await fillSyntheticAddress(page);
      } else {
        const reason = checkout.status === 'login_required' ? 'login_required'
          : checkout.status.startsWith('security_') ? 'challenge' : 'checkout_route_missing';
        steps.checkout = { status: checkout.status === 'unknown' ? 'failed' : 'blocked', reason };
        steps.shipping_address = { status: checkout.status === 'unknown' ? 'not_run' : 'blocked', reason: checkout.status === 'unknown' ? 'not_attempted' : reason };
      }
      return output({ verification_status: 'succeeded', observed_at: now().toISOString(), ...(platform ? { platform } : {}), cart: { status: 'verified', quantity: 1 }, checkout });
    } catch (error) {
      const message = String(error && error.message || '').toLowerCase();
      const timedOut = message.includes('timeout');
      const reason = timedOut ? 'timeout' : 'network';
      for (const name of STEP_NAMES) if (!steps[name]) steps[name] = { status: 'blocked', reason };
      return output({ verification_status: timedOut ? 'failed' : 'blocked', outcome_code: reason, observed_at: now().toISOString() });
    } finally {
      await browser?.close().catch(() => {});
      await connectProxy?.close().catch(() => {});
    }
  }
  return { audit };
}

module.exports = {
  CART_STATUSES, CHECKOUT_STATUSES, STEP_REASONS, STEP_STATUSES,
  classifyCheckoutPage, createCommerceStorefrontAudit, dismissBlockingDialogs,
  fillSyntheticAddress, httpsUrl, journeySteps,
  platformFromGenerator, sanitizeSearchQuery, validatePublicBrowserUrl,
};
