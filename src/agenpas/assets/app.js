/*
 * AgenPas buyer page (docs/agenpas.md). Vanilla JS, no dependencies, served same-origin under a strict CSP.
 *
 * - Reads the purchase id from the path and the link token from the URL fragment (`#t=`, never sent to a server);
 *   clears the fragment and sends the token only in the API's `X-Agenpas-Link` header. An invalid or expired link
 *   is judged by the API (404 / 410) and shown as a friendly screen.
 * - Renders with createElement/textContent only: nothing from the API is ever parsed as HTML.
 * - There is NO card input anywhere: the card is typed only on the payment partner's hosted page, which opens in a
 *   popup (desktop) or a new tab / this tab (mobile and in-app webviews), because it cannot be framed. When the
 *   server says `open_mode: "embed"` (AGENPAS_EMBED_HOSTED_PAGES) it is framed instead.
 * - Polls at the server's poll_after_seconds (2..15 s), backs off on errors, stops when the purchase is final or
 *   the link has expired, and polls at once when the buyer comes back to this tab or closes the popup.
 * - CONSENT (only when the API sends `consent`, i.e. AGENPAS_CONSENT_ENABLED is on and the backend asks for it): before
 *   the card or approval step, links to Pivota's Terms of Service and Privacy Policy, an UNCHECKED checkbox and
 *   "Agree and continue" (disabled until checked, and for a few seconds after the offer is first shown). The click
 *   POSTs {step, offer_id, issued_at} as JSON; the hosted page's button appears only once a later read carries its URL.
 */
(function () {
  'use strict';

  var POLL_MIN = 2;
  var POLL_MAX = 15;
  // The buyer has the offer in front of them at least this long before "Agree and continue" works: the backend's own
  // minimum plus a second when the API states it (`consent.min_dwell_seconds`), else 4 s (above the backend's default).
  var CONSENT_DWELL_MS = 4000;
  // An offer is kept while THIS PAGE first saw it less than this long ago (the backend accepts up to 30 minutes). Measured
  // on the page's own clock from when it saw the offer, never from the offer's `issued_at`: a phone's clock can be off.
  var CONSENT_OFFER_MAX_AGE_MS = 25 * 60 * 1000;
  var PATH_RE = /^\/agenpas\/p\/((?:pp|ap|rp)_[0-9a-f]{24})\/?$/;

  var app = document.getElementById('app');
  var match = PATH_RE.exec(window.location.pathname);
  var TOKEN_KEY = 'agenpas:t:' + (match ? match[1] : '');
  var token = readToken();

  // THE LINK TOKEN. It arrives in the URL FRAGMENT (`#t=…`), which no browser sends to a server, is kept in memory,
  // and is sent only in the `X-Agenpas-Link` header. The fragment is then cleared from the address bar and history.
  // A copy also goes to this tab's sessionStorage (never sent anywhere): on a phone the hosted page often replaces
  // this page in the same tab, and coming back reloads it without the fragment it was opened with.
  function readToken() {
    var fromHash = '';
    try {
      fromHash = new URLSearchParams(String(window.location.hash || '').replace(/^#/, '')).get('t') || '';
    } catch (e) {
      fromHash = '';
    }
    if (fromHash) {
      try { window.sessionStorage.setItem(TOKEN_KEY, fromHash); } catch (e) { /* storage blocked: memory only */ }
      try {
        window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
      } catch (e) { /* ignore */ }
      return fromHash;
    }
    try {
      return (match && window.sessionStorage.getItem(TOKEN_KEY)) || '';
    } catch (e) {
      return '';
    }
  }

  function forgetToken() {
    try { window.sessionStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
  }

  var ui = {
    view: null,
    waitingKind: null,
    lastScreen: null,
    popup: null,
    popupTimer: null,
    pollTimer: null,
    errors: 0,
    stopped: false,
    lastPollAt: 0,
    inFlight: false,
    noticeEl: null,
    lastJson: null,
    // The address form: what the buyer typed (kept across re-renders, in memory only, never stored), field errors
    // (codes), and whether a submit is in flight.
    address: {},
    addressErrors: {},
    addressMessage: null,
    addressBusy: false,
    // Shown above the terms when an address submit was sent back to them (409 consent_required).
    addressConsentNote: null,
    // The consent offer on screen: { step, offer, shownAt, checked, posting, accepted, error, retryAt, button }.
    consent: null,
    latestOffer: null,
  };

  // ---- tiny DOM helpers ----------------------------------------------------------------------------------------

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function append(parent) {
    for (var i = 1; i < arguments.length; i += 1) {
      if (arguments[i]) parent.appendChild(arguments[i]);
    }
    return parent;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function spinner() {
    var s = el('span', 'spinner');
    s.setAttribute('aria-hidden', 'true');
    return s;
  }

  function money(minor, currency) {
    if (typeof minor !== 'number' || !isFinite(minor) || !currency) return null;
    try {
      var nf = new Intl.NumberFormat(undefined, { style: 'currency', currency: currency });
      var digits = nf.resolvedOptions().maximumFractionDigits;
      return nf.format(minor / Math.pow(10, digits));
    } catch (e) {
      return null;
    }
  }

  function merchantName(view) {
    return view.merchant_domain || 'the store';
  }

  function isHttps(url) {
    try {
      return new URL(url).protocol === 'https:';
    } catch (e) {
      return false;
    }
  }

  // ---- screens -------------------------------------------------------------------------------------------------

  function summaryCard(view) {
    var card = el('section', 'card summary');
    append(card, el('p', 'eyebrow', 'Your purchase'));
    append(card, el('h1', 'product', view.product_name || 'Your item'));
    var meta = [];
    if (view.variant_title) meta.push(view.variant_title);
    if (view.quantity) meta.push('Qty ' + view.quantity);
    if (meta.length) append(card, el('p', 'muted', meta.join(' · ')));
    if (view.merchant_domain) append(card, el('p', 'merchant', 'Sold by ' + view.merchant_domain));

    var a = view.amounts || {};
    var rows = el('dl', 'rows');
    function row(label, value, strong) {
      if (!value) return;
      var wrap = el('div', strong ? 'row row-strong' : 'row');
      append(wrap, el('dt', null, label), el('dd', null, value));
      rows.appendChild(wrap);
    }
    var unit = money(a.unit_price_minor, view.currency);
    var qty = view.quantity || 1;
    var items = typeof a.unit_price_minor === 'number' ? money(a.unit_price_minor * qty, view.currency) : null;
    // Done: the total charged is on the result card below, once.
    if (view.screen !== 'done') {
      row(qty > 1 ? 'Price (' + qty + ' × ' + unit + ')' : 'Price', items);
      if (typeof a.quoted_total_minor === 'number') {
        row('Shipping', money(a.shipping_minor, view.currency));
        row('Tax', money(a.tax_minor, view.currency));
      }
    }
    if (rows.firstChild) card.appendChild(rows);

    if (view.screen !== 'done' && !view.terminal) {
      var quoted = money(a.quoted_total_minor, view.currency);
      var approved = view.state === 'placing';
      if (quoted) {
        append(card, el('p', 'approve-cap', (approved ? 'You approved up to ' : "You'll approve up to ") + quoted));
        append(card, el('p', 'fine', "The final total includes shipping and tax and can't be more than the amount you approve."));
      } else {
        append(card, el('p', 'fine', "Shipping and tax are added before you approve. The final total can't be more than the amount you approve."));
      }
    }
    return card;
  }

  function hostedButton(view, label) {
    var action = view.action;
    if (!action || !isHttps(action.url)) return null;
    var link = el('a', 'btn btn-primary', label);
    link.href = action.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.setAttribute('referrerpolicy', 'no-referrer');
    link.addEventListener('click', function (ev) { openHosted(action, ev); });
    return link;
  }

  function hostedFrame(view) {
    var action = view.action;
    if (!action || !isHttps(action.url)) return null;
    var frame = el('iframe', 'hosted-frame');
    frame.src = action.url;
    frame.title = action.kind === 'card_binding' ? "Payment partner's secure card page" : "Payment partner's secure approval page";
    frame.setAttribute('referrerpolicy', 'no-referrer');
    // No top-navigation token: a framed hosted page can never navigate the buyer's AgenPas tab away.
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
    frame.setAttribute('allow', 'publickey-credentials-get; publickey-credentials-create');
    return frame;
  }

  function waitingBlock(view, text) {
    var box = el('div', 'waiting');
    append(box, spinner(), el('p', 'waiting-text', text));
    var again = hostedButton(view, 'Open the secure page again');
    if (again) {
      again.className = 'btn btn-secondary';
      box.appendChild(again);
    }
    var check = el('button', 'btn btn-ghost', "I've finished — check now");
    check.type = 'button';
    check.addEventListener('click', function () { pollNow(); });
    box.appendChild(check);
    return box;
  }

  // ---- consent -------------------------------------------------------------------------------------------------

  function externalLink(text, url) {
    if (!isHttps(url)) return el('span', null, text);
    var a = el('a', 'legal-link', text);
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.setAttribute('referrerpolicy', 'no-referrer');
    return a;
  }

  function versionNote(version) {
    return typeof version === 'string' && version ? el('span', 'legal-version', ' (version ' + version + ')') : null;
  }

  function consentReady() {
    var c = ui.consent;
    return Boolean(c && c.checked && !c.posting && !c.accepted && Date.now() >= c.shownAt + c.dwellMs
      && Date.now() >= (c.retryAt || 0));
  }

  function updateConsentButton() {
    var c = ui.consent;
    if (!c || !c.button) return;
    c.button.disabled = !consentReady();
    if (c.button.disabled) c.button.setAttribute('aria-disabled', 'true');
    else c.button.setAttribute('aria-disabled', 'false');
  }

  // A re-check once the dwell (or a 429's wait) is over: the button updates in place, nothing is re-rendered.
  function scheduleConsentCheck() {
    var c = ui.consent;
    if (!c) return;
    var wait = Math.max(c.shownAt + c.dwellMs, c.retryAt || 0) - Date.now();
    if (wait > 0) setTimeout(updateConsentButton, wait + 50);
  }

  function dwellMsOf(offered) {
    var n = offered ? Number(offered.min_dwell_seconds) : NaN;
    return isFinite(n) && n >= 0 && Math.floor(n) === n ? (n + 1) * 1000 : CONSENT_DWELL_MS;
  }

  /**
   * Start again from the newest offer the page has read: the tick is cleared, the dwell restarts, and the next poll
   * re-renders (an answer that differs only in its offer would otherwise not be drawn again).
   */
  function adoptLatestOffer(c, error) {
    if (ui.latestOffer) c.offer = ui.latestOffer;
    if (ui.latestVersions) {
      c.terms_version = ui.latestVersions.terms;
      c.privacy_version = ui.latestVersions.privacy;
    }
    c.checked = false;
    c.accepted = false;
    c.waited = 0;
    c.seenAt = Date.now();
    c.shownAt = Date.now();
    c.dwellMs = ui.latestDwellMs || CONSENT_DWELL_MS;
    c.retryAt = 0;
    c.error = error || null;
    ui.lastJson = null;
    scheduleConsentCheck();
  }

  /** Keep the offer the buyer is reading; a new step (or an offer this page has held too long) starts a new one. */
  function syncConsent(view) {
    var offered = view && view.consent;
    ui.latestOffer = offered && offered.offer ? offered.offer : null;
    ui.latestDwellMs = dwellMsOf(offered);
    ui.latestVersions = offered ? { terms: offered.terms_version, privacy: offered.privacy_version } : null;
    if (!offered) {
      ui.consent = null;
      return;
    }
    var c = ui.consent;
    // New terms (a version moved on) are a new offer too: the kept one names versions the buyer is no longer shown.
    var versionsMoved = Boolean(c) && (c.terms_version !== offered.terms_version || c.privacy_version !== offered.privacy_version);
    if (!c || c.step !== offered.step || !c.offer || versionsMoved || Date.now() - c.seenAt > CONSENT_OFFER_MAX_AGE_MS) {
      var replacing = Boolean(c);
      ui.consent = {
        step: offered.step, offer: offered.offer, seenAt: Date.now(), shownAt: Date.now(), dwellMs: ui.latestDwellMs,
        terms_version: offered.terms_version, privacy_version: offered.privacy_version,
        checked: false, posting: false, accepted: false, error: null, retryAt: 0, button: null, waited: 0,
      };
      // A newer offer for the same answer shape must still be drawn (the poll skips an answer whose key is unchanged).
      if (replacing) ui.lastJson = null;
      scheduleConsentCheck();
      return;
    }
    // Recorded, yet the step is still offered after a few reads: let the buyer agree again rather than wait forever.
    if (c.accepted) {
      c.waited += 1;
      if (c.waited >= 3) adoptLatestOffer(c, 'Please agree once more to continue.');
    }
  }

  function consentBlock(view) {
    var offered = view.consent;
    var c = ui.consent;
    var box = el('div', 'consent');
    if (c && c.accepted) {
      append(box, spinner(), el('p', 'waiting-text', offered.step === 'card_binding'
        ? 'Thanks. Getting the secure card page ready…'
        : offered.step === 'shipping_address'
          ? 'Thanks. Getting the address form ready…'
          : "Thanks. You'll approve on our payment partner's secure page as soon as it's ready…"));
      return box;
    }
    var intro = el('p', 'consent-intro');
    append(intro, el('span', null, offered.step === 'card_binding' ? "Before you add your card, read Pivota's "
      : offered.step === 'shipping_address' ? "Before you give your shipping address, read Pivota's " : "Before you approve, read Pivota's "));
    // The versions are the ones the acceptance records (the same read's values): the buyer sees what is recorded.
    append(intro, externalLink('Terms of Service', offered.terms_url), versionNote(offered.terms_version), el('span', null, ' and '),
      externalLink('Privacy Policy', offered.privacy_url), versionNote(offered.privacy_version), el('span', null, '.'));
    box.appendChild(intro);

    var label = el('label', 'consent-check');
    var input = el('input');
    input.type = 'checkbox';
    input.checked = Boolean(c && c.checked);
    input.addEventListener('change', function () {
      if (!ui.consent) return;
      ui.consent.checked = Boolean(input.checked);
      ui.consent.error = null;
      if (ui.consent.errorEl) ui.consent.errorEl.textContent = '';
      updateConsentButton();
    });
    append(label, input, el('span', null, 'I agree to the Terms of Service and Privacy Policy'));
    box.appendChild(label);

    var button = el('button', 'btn btn-primary', c && c.posting ? 'Saving…' : 'Agree and continue');
    button.type = 'button';
    button.addEventListener('click', function () { submitConsent(); });
    box.appendChild(button);
    var errorEl = el('p', 'fine consent-error', c && c.error ? c.error : '');
    errorEl.setAttribute('role', 'status');
    box.appendChild(errorEl);
    if (c) {
      c.button = button;
      c.errorEl = errorEl;
    }
    updateConsentButton();
    return box;
  }

  function consentError(text) {
    var c = ui.consent;
    if (!c) return;
    c.posting = false;
    c.error = text;
    render();
  }

  function submitConsent() {
    var c = ui.consent;
    if (!c || !consentReady() || !c.offer) return;
    c.posting = true;
    c.error = null;
    render();
    fetch('/agenpas/api/p/' + match[1] + '/consent', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Agenpas-Link': token },
      body: JSON.stringify({ step: c.step, offer_id: c.offer.id, issued_at: c.offer.issued_at }),
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (body) {
        var header = function (name) { return res.headers && typeof res.headers.get === 'function' ? res.headers.get(name) : null; };
        return { status: res.status, body: body, retryAfter: header('Retry-After'), guard: header('X-Agenpas-Guard') };
      });
    }).then(function (r) {
      if (ui.consent !== c) return;
      if (r.status === 200) {
        c.posting = false;
        c.accepted = true;
        if (c.step === 'shipping_address') ui.addressConsentNote = null;
        render();
        pollNow();
        return;
      }
      if (r.status === 410) {
        showExpired(r.body && r.body.link_ttl_minutes);
        return;
      }
      if (r.status === 404) {
        // Only the API's own JSON answer judges the link. A 404 from a guard in front of it (a plain-text answer with
        // X-Agenpas-Guard, e.g. the consent route switched off) or with no readable body is "not available right now":
        // the link may still be good, so the token is kept.
        var guarded = Boolean(r.guard) || !r.body || typeof r.body.error !== 'string';
        if (!guarded && r.body.error === 'link_invalid') {
          stop();
          forgetToken();
          renderMessage("This link isn't valid", 'Please open the link exactly as the chat gave it to you, or ask the chat for a new one.');
          return;
        }
        if (!guarded && r.body.error === 'not_found') {
          stop();
          renderMessage("We can't find this purchase", 'Go back to the chat to check on it.');
          return;
        }
        consentError("This isn't available right now. Please try again in a little while.");
        return;
      }
      if (r.status === 409 && r.body && r.body.error === 'consent_too_soon') {
        // Nothing changed: the backend wants the offer on screen a little longer. Keep the tick; wait; press again.
        c.retryAt = Date.now() + c.dwellMs;
        scheduleConsentCheck();
        consentError('Just a moment. You can press "Agree and continue" again in a few seconds.');
        return;
      }
      if (r.status === 409 || (r.status === 400 && r.body && r.body.error === 'consent_refused')) {
        // The offer or the terms moved on (or the backend refused this offer): read them again, from the newest
        // offer, and agree again.
        adoptLatestOffer(c, 'Something changed. Please read the terms again, then agree.');
        consentError('Something changed. Please read the terms again, then agree.');
        pollNow();
        return;
      }
      if (r.status === 429) {
        // Keep the buyer's tick; let them try again after the wait.
        var wait = Math.min(POLL_MAX, Math.max(POLL_MIN, Number(r.retryAfter) || (r.body && Number(r.body.retry_after_seconds)) || POLL_MIN));
        c.retryAt = Date.now() + wait * 1000;
        scheduleConsentCheck();
        consentError('Too many tries just now. Please wait a moment, then try again.');
        return;
      }
      consentError("We couldn't save that just now. Please try again.");
    }).catch(function () {
      if (ui.consent === c) consentError("We couldn't save that just now. Please try again.");
    });
  }

  function actionCard(view, opts) {
    var card = el('section', 'card step');
    append(card, el('h2', null, opts.title));
    append(card, el('p', null, opts.body));
    if (opts.note) append(card, el('p', 'fine', opts.note));
    // The terms first: no hosted page button exists until a later read carries its URL.
    if (view.consent && !view.action) {
      card.appendChild(consentBlock(view));
      return card;
    }
    if (!view.action) {
      var prep = el('div', 'waiting');
      append(prep, spinner(), el('p', 'waiting-text', 'Getting the secure page ready…'));
      card.appendChild(prep);
      return card;
    }
    if (view.action.open_mode === 'embed') {
      append(card, hostedFrame(view));
      return card;
    }
    if (ui.waitingKind === view.action.kind) {
      append(card, waitingBlock(view, opts.waiting));
    } else {
      append(card, hostedButton(view, opts.button));
    }
    return card;
  }

  function progressCard(title, body) {
    var card = el('section', 'card step');
    var head = el('div', 'progress-head');
    append(head, spinner(), el('h2', null, title));
    append(card, head, el('p', 'muted', body));
    return card;
  }

  function noticeCard(title, body) {
    var card = el('section', 'card step');
    append(card, el('h2', null, title), el('p', 'muted', body));
    return card;
  }

  function resultCard(kind, title, body, extra) {
    var card = el('section', 'card step result result-' + kind);
    var icon = el('span', 'result-icon icon-' + kind);
    icon.setAttribute('aria-hidden', 'true');
    append(card, icon, el('h2', null, title), el('p', null, body));
    if (extra) card.appendChild(extra);
    return card;
  }

  function doneCard(view) {
    var order = view.order || {};
    var list = el('dl', 'rows');
    function row(label, value) {
      if (!value) return;
      var wrap = el('div', 'row');
      append(wrap, el('dt', null, label), el('dd', null, value));
      list.appendChild(wrap);
    }
    row('Order number', order.reference_withheld ? "Your order number is in the store's confirmation email." : order.reference);
    row('Total charged', order.total_unparsed
      ? 'See your email receipt'
      : money(view.amounts && view.amounts.final_total_minor, view.currency));
    row('Store', view.merchant_domain);
    var extra = el('div');
    extra.appendChild(list);
    if (order.status_url && isHttps(order.status_url)) {
      var link = el('a', 'btn btn-secondary', 'View your order at ' + merchantName(view));
      link.href = order.status_url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      extra.appendChild(link);
    }
    extra.appendChild(el('p', 'fine', 'You can go back to the chat now.'));
    return resultCard('done', 'Your order is placed', 'Your order at ' + merchantName(view) + ' is confirmed.', extra);
  }

  function outcomeCard(view) {
    var outcome = view.outcome || {};
    var kind = view.screen === 'outcome_unknown' ? 'checking' : 'stopped';
    var extra = null;
    // Never a retry for an outcome-unknown purchase: the order may already exist.
    // The hint line only when the message does not already say it.
    if (outcome.retry_hint && !outcome.outcome_unknown && !/start again|try again/i.test(outcome.message || '')) {
      extra = el('p', 'fine', 'You can go back to the chat to try again.');
    }
    return resultCard(kind, outcome.title || "This purchase didn't go through", outcome.message || 'Go back to the chat to check what happened.', extra);
  }

  // ---- the shipping address (AGENPAS_COLLECT_SHIPPING) ----------------------------------------------------------
  //
  // A plain form of the fields the purchase is missing. There is NO card field: the card is only ever typed on the
  // payment partner's page. The address goes only to this page's own API (same origin) and is never stored.

  var US_STATES = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY',
    'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA',
    'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'];
  var ADDRESS_FIELDS = {
    email: { label: 'Email', type: 'email', autocomplete: 'email', inputmode: 'email' },
    firstName: { label: 'First name', autocomplete: 'shipping given-name' },
    lastName: { label: 'Last name', autocomplete: 'shipping family-name' },
    phone: { label: 'Phone', type: 'tel', autocomplete: 'shipping tel', inputmode: 'tel' },
    addressLine1: { label: 'Address', autocomplete: 'shipping address-line1' },
    addressLine2: { label: 'Apartment, suite, etc. (optional)', autocomplete: 'shipping address-line2', optional: true },
    city: { label: 'City', autocomplete: 'shipping address-level2' },
    region: { label: 'State', autocomplete: 'shipping address-level1', options: US_STATES.map(function (c) { return [c, c]; }) },
    postalCode: { label: 'ZIP code', autocomplete: 'shipping postal-code', inputmode: 'numeric' },
    country: { label: 'Country', autocomplete: 'shipping country', options: [['US', 'United States']] },
  };
  var ADDRESS_ORDER = ['email', 'firstName', 'lastName', 'phone', 'addressLine1', 'addressLine2', 'city', 'region', 'postalCode', 'country'];
  var ERROR_TEXT = {
    required: 'This is required.',
    invalid_email: 'Enter a valid email address.',
    invalid_phone: 'Enter a valid phone number.',
    invalid_postal_code: 'Enter a 5-digit ZIP code.',
    invalid_region: 'Choose a state.',
    unsupported_country: 'We can only ship to the United States for now.',
    too_long: 'This is too long.',
    invalid_characters: 'Remove the special characters.',
  };

  function addressFieldsOf(view) {
    var req = view.address_request || {};
    var listed = Array.isArray(req.fields_missing) ? req.fields_missing : [];
    return ADDRESS_ORDER.filter(function (f) { return listed.indexOf(f) >= 0; });
  }

  /** Client-side checks for a quick answer; the gateway and the backend check again. Returns {field: code}. */
  function checkAddress(fields, values) {
    var errors = {};
    fields.forEach(function (f) {
      var v = String(values[f] || '').trim();
      if (!v) {
        if (!ADDRESS_FIELDS[f].optional) errors[f] = 'required';
        return;
      }
      if (v.length > 200) errors[f] = 'too_long';
      else if (f === 'email' && !/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(v)) errors[f] = 'invalid_email';
      else if (f === 'phone' && (!/^[0-9+\s\-().]+$/.test(v) || v.replace(/[^0-9]/g, '').length < 10)) errors[f] = 'invalid_phone';
      else if (f === 'postalCode' && !/^\d{5}(-?\d{4})?$/.test(v)) errors[f] = 'invalid_postal_code';
      else if (f === 'region' && US_STATES.indexOf(v.toUpperCase()) < 0) errors[f] = 'invalid_region';
      else if (f === 'country' && v.toUpperCase() !== 'US') errors[f] = 'unsupported_country';
    });
    return errors;
  }

  function addressInput(field) {
    var meta = ADDRESS_FIELDS[field];
    var id = 'agenpas-' + field;
    var wrap = el('div', 'field');
    var label = el('label', 'field-label', meta.label);
    label.setAttribute('for', id);
    var input;
    if (meta.options) {
      input = el('select', 'field-input');
      if (meta.options.length > 1) {
        var blank = el('option', null, 'Choose…');
        blank.value = '';
        input.appendChild(blank);
      }
      meta.options.forEach(function (o) {
        var opt = el('option', null, o[1]);
        opt.value = o[0];
        input.appendChild(opt);
      });
    } else {
      input = el('input', 'field-input');
      input.type = meta.type || 'text';
      if (meta.inputmode) input.setAttribute('inputmode', meta.inputmode);
      input.setAttribute('maxlength', '200');
    }
    input.id = id;
    input.name = field;
    input.setAttribute('autocomplete', meta.autocomplete);
    if (!meta.optional) input.setAttribute('aria-required', 'true');
    input.value = ui.address[field] || (meta.options && meta.options.length === 1 ? meta.options[0][0] : '');
    if (meta.options && meta.options.length === 1) ui.address[field] = input.value;
    function keep() { ui.address[field] = input.value; }
    input.addEventListener('input', keep);
    input.addEventListener('change', keep);
    append(wrap, label, input);
    var code = ui.addressErrors[field];
    if (code) {
      var errId = id + '-error';
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', errId);
      var err = el('p', 'field-error', ERROR_TEXT[code] || 'Check this field.');
      err.id = errId;
      wrap.appendChild(err);
    }
    return wrap;
  }

  function addressCard(view) {
    // The address step is consent-gated: the terms first, and the form only from a later read (the API then sends
    // `address_request`). Whatever the buyer already typed is kept in memory for it.
    if (view.consent && !view.address_request) {
      var gate = el('section', 'card step');
      append(gate, el('h2', null, 'Where should we send it?'),
        el('p', null, 'Your address goes to ' + merchantName(view) + ' so they can ship your order.'));
      if (ui.addressConsentNote) {
        var note = el('p', 'fine', ui.addressConsentNote);
        note.setAttribute('role', 'status');
        gate.appendChild(note);
      }
      gate.appendChild(consentBlock(view));
      return gate;
    }
    var fields = addressFieldsOf(view);
    var prefill = (view.address_request && view.address_request.prefill) || {};
    Object.keys(prefill).forEach(function (k) {
      if (ui.address[k] === undefined && typeof prefill[k] === 'string') ui.address[k] = prefill[k];
    });
    var card = el('section', 'card step');
    append(card, el('h2', null, 'Where should we send it?'),
      el('p', null, 'Your address goes to ' + merchantName(view) + ' so they can ship your order.'));
    var form = el('form', 'address-form');
    form.setAttribute('novalidate', 'novalidate');
    fields.forEach(function (f) { form.appendChild(addressInput(f)); });
    // Sent back to the terms (409 consent_required): said here too until the next read shows them.
    if (ui.addressConsentNote) {
      var sentBack = el('p', 'fine', ui.addressConsentNote);
      sentBack.setAttribute('role', 'status');
      form.appendChild(sentBack);
    }
    if (ui.addressMessage) {
      var msg = el('p', 'field-error form-error', ui.addressMessage);
      msg.setAttribute('role', 'alert');
      form.appendChild(msg);
    }
    var submit = el('button', 'btn btn-primary', ui.addressBusy ? 'Saving…' : 'Continue');
    submit.type = 'submit';
    if (ui.addressBusy) submit.setAttribute('disabled', 'disabled');
    form.appendChild(submit);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      submitAddress(view, fields);
    });
    card.appendChild(form);
    return card;
  }

  function submitAddress(view, fields) {
    if (ui.addressBusy) return;
    var errors = checkAddress(fields, ui.address);
    ui.addressErrors = errors;
    ui.addressMessage = Object.keys(errors).length ? 'Please check the highlighted fields.' : null;
    if (Object.keys(errors).length) {
      render();
      return;
    }
    var body = {};
    fields.forEach(function (f) {
      var v = String(ui.address[f] || '').trim();
      if (v) body[f] = v;
    });
    ui.addressBusy = true;
    render();
    fetch('/agenpas/api/p/' + match[1] + '/shipping-address', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Agenpas-Link': token },
      body: JSON.stringify(body),
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (b) { return { status: res.status, body: b }; });
    }).then(function (r) {
      ui.addressBusy = false;
      if (r.status === 200 && r.body && typeof r.body.screen === 'string') {
        ui.address = {};
        ui.addressErrors = {};
        ui.addressMessage = null;
        ui.addressConsentNote = null;
        ui.view = r.body;
        ui.lastJson = JSON.stringify(r.body);
        render();
        if (r.body.terminal) { stop(); forgetToken(); return; }
        schedule(r.body.poll_after_seconds);
        return;
      }
      if (r.status === 409 && r.body && r.body.error === 'consent_required') {
        // The terms for this step are not accepted (yet, or any more): back to them. What the buyer typed stays in
        // memory and fills the form again once they agree; the page says so.
        ui.addressMessage = null;
        ui.addressErrors = {};
        ui.addressConsentNote = 'Please accept the terms first. What you typed is kept, and the form comes back after you agree.';
        if (ui.consent && ui.consent.step === 'shipping_address') ui.consent = null;
        ui.lastJson = null;
        render();
        pollNow();
        return;
      }
      if (r.status === 422) {
        ui.addressErrors = (r.body && r.body.field_errors) || {};
        ui.addressMessage = 'Please check the highlighted fields.';
      } else if (r.status === 409) {
        ui.addressMessage = null;
        ui.addressErrors = {};
        setNotice('We already have your address.');
        pollNow();
      } else if (r.status === 429) {
        ui.addressMessage = 'Too many tries. Wait a minute, then try again.';
      } else if (r.status === 410) {
        showExpired(r.body && r.body.link_ttl_minutes);
        return;
      } else {
        ui.addressMessage = "We couldn't save your address just now. Please try again in a moment.";
      }
      render();
    }).catch(function () {
      ui.addressBusy = false;
      ui.addressMessage = "We couldn't save your address just now. Please try again in a moment.";
      render();
    });
  }

  function stepCard(view) {
    var m = merchantName(view);
    var quoted = money(view.amounts && view.amounts.quoted_total_minor, view.currency);
    switch (view.screen) {
      case 'preparing':
        return progressCard('Getting your order ready', 'Checking the price and availability at ' + m + '…');
      case 'add_card':
        return actionCard(view, {
          title: 'Add a card',
          body: "Your card is added on our payment partner's secure page. Pivota never sees your card number.",
          button: 'Add a card securely',
          waiting: 'Waiting for your card…',
        });
      case 'confirming_total': {
        var confirming = progressCard('Confirming your total', 'Getting the final total from ' + m + ', including shipping and tax…');
        // The approval's terms may be accepted while the total is confirmed.
        if (view.consent) confirming.appendChild(consentBlock(view));
        return confirming;
      }
      case 'unavailable':
        return noticeCard("This step isn't available right now", 'Please go back to the chat and try again in a little while. This page updates on its own.');
      case 'details_needed':
        return noticeCard((view.outcome && view.outcome.title) || 'Some details are needed',
          (view.outcome && view.outcome.message) || 'Go back to the chat to continue.');
      case 'approve':
        return actionCard(view, {
          title: 'Approve your purchase',
          body: 'Approve ' + (quoted || 'this purchase') + ' at ' + m + ' with Face ID or fingerprint.',
          note: "You approve on our payment partner's secure page.",
          button: quoted ? 'Approve ' + quoted : 'Approve',
          waiting: 'Waiting for your approval…',
        });
      case 'authenticate':
        return actionCard(view, {
          title: 'Confirm with your bank',
          body: 'Your bank wants to confirm this purchase on its own secure page.',
          button: 'Continue to your bank',
          waiting: 'Waiting for your bank…',
        });
      case 'shipping_address':
        return addressCard(view);
      case 'shipping_address_elsewhere':
        return progressCard('We need your shipping address', 'Go back to the chat to add your address. This page updates on its own.');
      case 'parked':
        return progressCard('Getting things ready…', 'This is taking a little longer than usual. This page updates on its own.');
      case 'placing':
        return progressCard('Placing your order at ' + m + '…', 'This usually takes under a minute. You can keep this page open.');
      case 'done':
        return doneCard(view);
      case 'failed':
      case 'refused':
      case 'expired':
      case 'outcome_unknown':
        return outcomeCard(view);
      default:
        return progressCard('Checking on your purchase…', "We're getting the latest from " + m + '. This page updates on its own.');
    }
  }

  function render() {
    var view = ui.view;
    if (!view) return;
    if (view.screen !== ui.lastScreen) {
      ui.waitingKind = null;
      ui.lastScreen = view.screen;
    }
    clear(app);
    append(app, summaryCard(view), stepCard(view), noticeEl());
  }

  // ONE notice element for the page's life, updated IN PLACE: showing or clearing "Reconnecting…" never rebuilds the
  // cards (which would reload a framed hosted page in embed mode).
  function noticeEl() {
    if (!ui.noticeEl) {
      ui.noticeEl = el('p', 'notice');
      ui.noticeEl.setAttribute('role', 'status');
    }
    return ui.noticeEl;
  }

  function setNotice(text) {
    var node = noticeEl();
    node.textContent = text || '';
    if (ui.view && node.parentNode !== app) app.appendChild(node);
  }

  function renderMessage(title, body) {
    clear(app);
    var card = el('section', 'card');
    append(card, el('h1', null, title), el('p', null, body));
    app.appendChild(card);
  }

  // ---- hosted pages --------------------------------------------------------------------------------------------

  function isDesktop() {
    try {
      return window.matchMedia('(pointer: fine)').matches && window.innerWidth >= 720;
    } catch (e) {
      return false;
    }
  }

  function watchPopup() {
    if (ui.popupTimer) clearInterval(ui.popupTimer);
    ui.popupTimer = setInterval(function () {
      var closed = true;
      try {
        closed = !ui.popup || ui.popup.closed;
      } catch (e) {
        closed = true;
      }
      if (closed) {
        clearInterval(ui.popupTimer);
        ui.popupTimer = null;
        ui.popup = null;
        pollNow();
      }
    }, 1000);
  }

  function openHosted(action, ev) {
    if (!isHttps(action.url)) {
      ev.preventDefault();
      return;
    }
    if (isDesktop()) {
      ev.preventDefault();
      var w = null;
      try {
        w = window.open('', 'agenpas_hosted', 'popup=yes,width=480,height=760');
      } catch (e) {
        w = null;
      }
      if (w) {
        try { w.opener = null; } catch (e) { /* ignore */ }
        try {
          w.location.replace(action.url);
        } catch (e) {
          w.location.href = action.url;
        }
        ui.popup = w;
        watchPopup();
      } else {
        // Popup blocked: go there in this tab. Coming back reloads this page, which picks up where it was.
        window.location.assign(action.url);
        return;
      }
    }
    // Mobile / webview: the link's own target=_blank (or an in-place navigation where a webview ignores it).
    ui.waitingKind = action.kind;
    render();
    schedule(POLL_MIN);
  }

  // ---- polling -------------------------------------------------------------------------------------------------

  function linkExpired() {
    var exp = ui.view && ui.view.link_expires_at ? Date.parse(ui.view.link_expires_at) : NaN;
    return isFinite(exp) && Date.now() >= exp;
  }

  function stop() {
    ui.stopped = true;
    if (ui.pollTimer) clearTimeout(ui.pollTimer);
    ui.pollTimer = null;
  }

  function schedule(seconds) {
    if (ui.stopped) return;
    if (ui.pollTimer) clearTimeout(ui.pollTimer);
    var s = Math.min(POLL_MAX, Math.max(POLL_MIN, Number(seconds) || POLL_MIN));
    ui.pollTimer = setTimeout(poll, s * 1000);
  }

  function pollNow() {
    if (ui.stopped) return;
    var since = (Date.now() - ui.lastPollAt) / 1000;
    if (since >= POLL_MIN) poll();
    else schedule(POLL_MIN - since);
  }

  function showExpired(ttlMinutes) {
    stop();
    forgetToken();
    var minutes = Number(ttlMinutes) || (ui.view && Number(ui.view.link_ttl_minutes)) || 0;
    var lasting = minutes >= 1 ? 'only work for ' + Math.floor(minutes) + (Math.floor(minutes) === 1 ? ' minute' : ' minutes') : 'only work for a short time';
    renderMessage('This link has expired', 'For your security, AgenPas links ' + lasting + '. Go back to the chat and ask for a new link to see your purchase.');
  }

  function onError() {
    ui.errors += 1;
    var backoff = Math.min(POLL_MAX, POLL_MIN * Math.pow(2, ui.errors - 1));
    if (ui.view) {
      setNotice('Reconnecting…');
    } else {
      renderMessage("We can't load your purchase right now", "We'll keep trying. You can leave this page open.");
    }
    schedule(backoff);
  }

  // What decides a re-render: the answer, except the consent offer's id and time (they change on every read, and a
  // re-render would drop the buyer's focus on the checkbox). Without a consent member: the answer itself, as before.
  function viewKey(body) {
    if (!body.consent || typeof body.consent !== 'object') return JSON.stringify(body);
    var copy = {};
    for (var k in body) if (Object.prototype.hasOwnProperty.call(body, k)) copy[k] = body[k];
    copy.consent = {
      step: body.consent.step, terms_url: body.consent.terms_url, privacy_url: body.consent.privacy_url,
      terms_version: body.consent.terms_version, privacy_version: body.consent.privacy_version,
    };
    return JSON.stringify(copy);
  }

  function poll() {
    if (ui.stopped || ui.inFlight) return;
    if (linkExpired()) {
      showExpired();
      return;
    }
    ui.inFlight = true;
    ui.lastPollAt = Date.now();
    fetch('/agenpas/api/p/' + match[1], {
      method: 'GET',
      headers: { Accept: 'application/json', 'X-Agenpas-Link': token },
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (body) { return { status: res.status, body: body }; });
    }).then(function (r) {
      ui.inFlight = false;
      if (r.status === 200 && r.body && typeof r.body.screen === 'string') {
        syncConsent(r.body);
        var json = viewKey(r.body);
        // An unchanged answer is not re-rendered: a re-render would reload a framed hosted page (embed mode) and
        // drop a focused button.
        var changed = json !== ui.lastJson;
        ui.errors = 0;
        ui.view = r.body;
        ui.lastJson = json;
        if (changed) render();
        setNotice('');
        if (r.body.terminal) {
          // Final: nothing more to fetch, and nothing left for the token to open.
          stop();
          forgetToken();
          return;
        }
        schedule(r.body.poll_after_seconds);
        return;
      }
      if (r.status === 410) {
        showExpired(r.body && r.body.link_ttl_minutes);
        return;
      }
      if (r.status === 404) {
        stop();
        if (!(r.body && r.body.error === 'not_found')) forgetToken();
        if (r.body && r.body.error === 'not_found') {
          renderMessage("We can't find this purchase", 'Go back to the chat to check on it.');
        } else {
          renderMessage("This link isn't valid", 'Please open the link exactly as the chat gave it to you, or ask the chat for a new one.');
        }
        return;
      }
      onError();
    }).catch(function () {
      ui.inFlight = false;
      onError();
    });
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') pollNow();
  });
  window.addEventListener('pageshow', function (ev) {
    if (ev.persisted) pollNow();
  });

  if (!app) return;
  if (!match || !token) {
    renderMessage("This link isn't valid", 'Please open the link exactly as the chat gave it to you, or ask the chat for a new one.');
    return;
  }
  poll();
}());
