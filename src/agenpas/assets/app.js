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
    // The step the open hosted popup is for (its `action.kind`): the page closes the popup once that step is over.
    popupKind: null,
    // A popup this page opened on the buyer's own Approve tap in the card choice, before the approval page exists:
    // { win, until }. The approval page is loaded into it as soon as a read carries it (no second tap), once.
    pendingPopup: null,
    image: { state: 'idle', src: null, slot: null },
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
    // Sent back to the terms: the form is not drawn again until the buyer accepts them on this page. A second send-back
    // after a fresh acceptance, a second "not requested", or any other refusal of the address closes the step.
    addressSentBack: false,
    addressSentBackCount: 0,
    addressNotRequestedCount: 0,
    // Reads that still show the form (and no terms) while sent back: after ADDRESS_SENT_BACK_MAX_READS, closed.
    addressSentBackReads: 0,
    addressClosed: false,
    // The consent offer on screen: { step, offer, shownAt, checked, posting, accepted, error, retryAt, button }.
    consent: null,
    latestOffer: null,
    // The card choice (AGENPAS_CARD_PICKER_ENABLED): the card the buyer picked here (a handle, memory only), whether the
    // picker is open and what it has ticked, a POST in flight, its message, its automatic retries, and whether this page
    // confirmed the card (the approval screen then says "Continue to the secure page").
    cardDraft: null,
    cardPickerOpen: false,
    cardPickerDraft: null,
    cardBusy: false,
    cardMessage: null,
    cardRetries: 0,
    cardConfirmed: false,
    // The radio that had the keyboard before a re-render (a handle): it gets the focus back.
    cardFocus: null,
    // When the last card-choice POST was sent (ms): a poll that started before it answers with an older view, which is
    // dropped (it would show the unconfirmed choice again after the confirmation).
    cardPostAt: 0,
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

  // The dark panel: the store, ONE amount, and the item. The amount is the quoted total once the store has priced the
  // cart (the most the buyer approves), the item price before that, and the total charged once the order is placed.
  function summaryCard(view) {
    // The address form is long: on a phone the panel above it is drawn small (`summary-compact`).
    var card = el('section', view.screen === 'shipping_address' ? 'card summary summary-compact' : 'card summary');
    var a = view.amounts || {};
    var done = view.screen === 'done';
    // Open: a buyer step may still follow. A HELD purchase ("We're checking with the store") is not open, even while
    // its state is not final: its amount is drawn like a stopped one, and nothing says "you'll approve".
    var open = !done && !view.terminal && view.screen !== 'outcome_unknown';
    var qty = view.quantity || 1;
    var unit = money(a.unit_price_minor, view.currency);
    var items = typeof a.unit_price_minor === 'number' ? money(a.unit_price_minor * qty, view.currency) : null;
    var quoted = money(a.quoted_total_minor, view.currency);

    // The agent's name, only when the backend names one it checked (the view has no member otherwise).
    if (view.agent_display_name) append(card, el('p', 'hero-agent', 'Requested by ' + view.agent_display_name));
    if (open && quoted) {
      append(card, el('p', 'hero-cap', (view.state === 'placing' ? 'You approved up to ' : "You'll approve up to ") + quoted));
    }
    if (view.merchant_domain) append(card, el('p', 'hero-store', view.merchant_domain));
    // Done: the total charged, when it could be read (the result card says "See your email receipt" when not).
    var amount = done ? money(a.final_total_minor, view.currency) : (quoted || items);
    if (amount) {
      // The number always says what it is. Before the store prices the cart it is the item price ONLY (shipping and
      // tax are not in it yet), and it is never called a total. On a stopped or held purchase the quoted total is
      // "Quoted total": the buyer may never have approved it, and nothing says it was charged.
      var label = done ? 'Total charged' : quoted ? (open ? null : 'Quoted total') : (qty > 1 ? 'Price for ' + qty + ' items' : 'Item price');
      if (label) append(card, el('p', 'hero-label', label));
      append(card, el('p', open || done ? 'hero-amount' : 'hero-amount hero-amount-off', amount));
    }
    if (!done) {
      if (quoted) {
        // The parts as the store gave them, side by side: no sum is implied (a discount may sit between them).
        var parts = [];
        var shipping = money(a.shipping_minor, view.currency);
        var tax = money(a.tax_minor, view.currency);
        if (items && (shipping || tax)) parts.push('Items ' + items);
        if (shipping) parts.push('Shipping ' + shipping);
        if (tax) parts.push('Tax ' + tax);
        if (parts.length) append(card, el('p', 'hero-sub', parts.join(' · ')));
      } else if (open) {
        // On the approval step itself "before you approve" would be wrong: there it only says the number leaves them out.
        append(card, el('p', 'hero-sub', view.screen === 'approve'
          ? 'Shipping and tax are not included.'
          : 'Shipping and tax are added before you approve.'));
      }
    }

    var item = el('div', 'hero-item');
    var image = productImageSlot(view);
    if (image) {
      item.className = 'hero-item hero-item-with-image';
      item.appendChild(image);
    }
    var text = el('div', 'hero-item-text');
    append(text, el('p', 'hero-item-name product', view.product_name || 'Your item'));
    var meta = [];
    if (view.variant_title) meta.push(view.variant_title);
    if (view.quantity) meta.push('Qty ' + view.quantity);
    if (qty > 1 && unit) meta.push(unit + ' each');
    if (meta.length) append(text, el('p', 'hero-item-meta', meta.join(' · ')));
    item.appendChild(text);
    card.appendChild(item);
    return card;
  }

  // ---- the product image -----------------------------------------------------------------------------------------
  //
  // Only when the view says `product_image` (the backend named an image of the exact variant bought). The page never
  // learns the store's URL: it asks /agenpas/api/p/<id>/image, which the gateway answers with the bytes it fetched
  // itself, and reads them into a data: URL (the CSP allows images from 'self' and data: only; an <img> cannot send
  // the link token header). Asked ONCE per page load; a failure, a wrong type or a size over the cap shows no image.
  // Filled IN PLACE when it arrives: never a re-render, which would reload a framed hosted page in embed mode.
  var IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  var IMAGE_MAX_BYTES = 2 * 1024 * 1024;
  var IMAGE_DATA_URL_RE = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;

  function productImageSlot(view) {
    if (!view.product_image || ui.image.state === 'none') return null;
    var slot = el('div', 'hero-item-image');
    ui.image.slot = slot;
    if (ui.image.state === 'ready') fillImageSlot(slot, ui.image.src);
    else if (ui.image.state === 'idle') loadProductImage();
    return slot;
  }

  function fillImageSlot(slot, src) {
    var img = document.createElement('img');
    img.alt = '';  // the item's name is the text beside it
    img.decoding = 'async';
    img.onerror = function () {
      ui.image = { state: 'none', src: null, slot: null };
      removeImageSlot(slot);
    };
    img.src = src;
    slot.appendChild(img);
  }

  // The slot goes, and its item is drawn as an item without an image again.
  function removeImageSlot(slot) {
    var item = slot && slot.parentNode;
    if (!item) return;
    item.className = 'hero-item';
    item.removeChild(slot);
  }

  function dropImageSlot() {
    var slot = ui.image.slot;
    ui.image = { state: 'none', src: null, slot: null };
    removeImageSlot(slot);
  }

  function loadProductImage() {
    ui.image.state = 'loading';
    fetch('/agenpas/api/p/' + match[1] + '/image', {
      method: 'GET',
      headers: { Accept: IMAGE_TYPES.join(', '), 'X-Agenpas-Link': token },
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    }).then(function (res) {
      // The type is checked on the data: URL below (the blob's type IS the answer's Content-Type).
      if (res.status !== 200) throw new Error('no image');
      return res.blob();
    }).then(function (blob) {
      if (!blob || !blob.size || blob.size > IMAGE_MAX_BYTES) throw new Error('no image');
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () { resolve(reader.result); };
        reader.onerror = function () { reject(new Error('no image')); };
        reader.readAsDataURL(blob);
      });
    }).then(function (src) {
      if (typeof src !== 'string' || !IMAGE_DATA_URL_RE.test(src)) throw new Error('no image');
      ui.image.state = 'ready';
      ui.image.src = src;
      if (ui.image.slot) fillImageSlot(ui.image.slot, src);
    }).catch(function () {
      dropImageSlot();
    });
  }

  // The one line under a buyer step (card, address form, confirming the total, approval). Only those call it: a
  // result screen, a dead end and a "checking" card never do.
  // - Once the store has priced the cart, the amount on the page is the most the buyer approves: the ceiling line.
  // - Before that the page shows the item price only, so it promises no ceiling: it says the full total comes first.
  // - An approval step with no quoted total says neither (there is no amount on the page to be a ceiling).
  function assurance(view, card) {
    var a = view.amounts || {};
    if (money(a.quoted_total_minor, view.currency)) {
      append(card, el('p', 'assure', "The final total can't be more than the amount you approve."));
    } else if (view.screen !== 'approve') {
      append(card, el('p', 'assure', "You'll see the full total before you approve."));
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

  // `opts` (the card choice only): { label, onTap, then }. ONE tap agrees AND approves (staging run-through 11-27: a
  // separate "Agree and continue" then "Approve" was one tap too many): `label` replaces "Agree and continue", `onTap`
  // runs inside the buyer's own tap (it opens the approval popup), and `then` runs once the consent is recorded (it
  // posts the card), instead of waiting for the next read to show Approve.
  function consentBlock(view, opts) {
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

    var buttonLabel = opts && opts.label ? opts.label : 'Agree and continue';
    var button = el('button', 'btn btn-primary', c && c.posting ? 'Saving…' : buttonLabel);
    button.type = 'button';
    button.addEventListener('click', function () {
      if (!consentReady()) return;
      if (opts && typeof opts.onTap === 'function') opts.onTap();
      if (ui.consent) ui.consent.then = opts && typeof opts.then === 'function' ? opts.then : null;
      submitConsent();
    });
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
        if (c.step === 'shipping_address') {
          ui.addressConsentNote = null;
          ui.addressSentBack = false;
        }
        var then = c.then;
        c.then = null;
        if (then) {
          // The card choice's one tap: the terms are recorded, so the card goes now (its own answer is the next view).
          then();
          return;
        }
        render();
        pollNow();
        return;
      }
      // Not recorded: whatever the tap opened for the approval goes, and the card is not sent.
      c.then = null;
      closePendingPopup();
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
      if (ui.consent === c) {
        c.then = null;
        closePendingPopup();
        consentError("We couldn't save that just now. Please try again.");
      }
    });
  }

  // "Visa ending 4242": the card the purchase's checkout is bound to, only when the API names it (approval and order
  // placed only; the API never sends it anywhere else).
  function cardText(view) {
    var c = view.payment_card;
    if (!c || typeof c.label !== 'string' || !/^[0-9]{4}$/.test(String(c.last4 || ''))) return null;
    return c.label + ' ending ' + c.last4;
  }

  function actionCard(view, opts) {
    var card = el('section', 'card step');
    append(card, el('h1', null, opts.title));
    append(card, el('p', 'muted', opts.body));
    if (opts.note) append(card, el('p', 'fine', opts.note));
    if (opts.showCard && cardText(view)) {
      var pay = el('dl', 'rows');
      var payRow = el('div', 'row');
      append(payRow, el('dt', null, 'Pay with'), el('dd', null, cardText(view)));
      append(card, append(pay, payRow));
    }
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

  // ---- the card choice ------------------------------------------------------------------------------------------

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // A stale answer while the worker holds the purchase lasts a moment: the page sends the same card again, twice at most.
  var CARD_CHOICE_RETRIES = 2;
  var CARD_CHOICE_RETRY_MS = 1500;

  function cardLabel(card) {
    return card.label + (card.last4 ? ' ending ' + card.last4 : '');
  }

  function cardAdded(card) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(card.added_on || ''));
    return m ? 'Added ' + MONTHS[Number(m[2]) - 1] + ' ' + Number(m[3]) : null;
  }

  function hasCard(choice, handle) {
    return choice.cards.some(function (c) { return c.handle === handle; });
  }

  function selectedCard(choice) {
    var picked = null;
    choice.cards.forEach(function (c) { if (!choice.confirmed && ui.cardDraft && c.handle === ui.cardDraft) picked = c; });
    if (picked) return picked;
    choice.cards.forEach(function (c) { if (!picked && c.selected) picked = c; });
    return picked;
  }

  // The buyer's pick is no longer on the list (a card removed, the list changed): never fall back to another card
  // without saying so.
  // "Add a new card" in the picker: a pick of its own (never a card handle, which is 24 hex).
  var NEW_CARD = 'new';

  function forgetVanishedPick(choice) {
    if (choice.confirmed) return;
    if (ui.cardDraft && ui.cardDraft !== NEW_CARD && !hasCard(choice, ui.cardDraft)) {
      ui.cardDraft = null;
      ui.cardMessage = 'Your saved cards changed. Check the card, then approve again.';
    }
    if (ui.cardPickerDraft && ui.cardPickerDraft !== NEW_CARD && !hasCard(choice, ui.cardPickerDraft)) ui.cardPickerDraft = null;
  }

  function cardPicker(choice, current) {
    var box = el('fieldset', 'card-picker');
    append(box, el('legend', null, 'Choose a card'));
    var draft = ui.cardPickerDraft || (ui.cardDraft === NEW_CARD ? NEW_CARD : current.handle);
    var options = choice.cards.concat([{ handle: NEW_CARD, label: 'Add a new card', last4: null, added_on: null }]);
    options.forEach(function (c) {
      var on = c.handle === draft;
      var option = el('label', on ? 'card-option selected' : 'card-option');
      var radio = el('input');
      radio.type = 'radio';
      radio.name = 'card';
      radio.value = c.handle;
      radio.checked = on;
      radio.addEventListener('change', function () { ui.cardPickerDraft = c.handle; ui.cardFocus = c.handle; render(); });
      if (ui.cardFocus === c.handle) {
        ui.cardFocus = null;
        setTimeout(function () { radio.focus(); }, 0);
      }
      var text = el('span', 'card-option-text');
      append(text, el('span', 'card-option-label', c.handle === NEW_CARD ? c.label : cardLabel(c)));
      var added = c.handle === NEW_CARD ? "On our payment partner's secure page" : cardAdded(c);
      if (added) append(text, el('span', 'fine', added));
      append(option, radio, text);
      box.appendChild(option);
    });
    var use = el('button', 'btn btn-primary', draft === NEW_CARD ? 'Add a new card' : 'Use this card');
    use.type = 'button';
    use.addEventListener('click', function () {
      ui.cardDraft = ui.cardPickerDraft || current.handle;
      ui.cardPickerOpen = false;
      ui.cardPickerDraft = null;
      ui.cardMessage = null;
      render();
    });
    var cancel = el('button', 'btn btn-ghost', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', function () {
      ui.cardPickerOpen = false;
      ui.cardPickerDraft = null;
      render();
    });
    append(box, use, cancel);
    append(box, el('p', 'fine', 'Saved with our payment partner. We only see the last four digits.'));
    return box;
  }

  function chooseCardCard(view) {
    var choice = view.card_choice;
    forgetVanishedPick(choice);
    // A choice still open: whatever an earlier approval on this page did, this one is not confirmed yet.
    if (!choice.confirmed) ui.cardConfirmed = false;
    var current = selectedCard(choice);
    var quoted = money(view.amounts && view.amounts.quoted_total_minor, view.currency);
    // The buyer picked "Add a new card" here (or already asked for it): the card row says so, and Approve adds it.
    var wantsNew = !choice.confirmed && (ui.cardDraft === NEW_CARD || choice.new_card === true);
    var card = el('section', 'card step');
    append(card, el('h1', null, 'Approve your purchase'));
    append(card, el('p', 'muted', choice.confirmed
      ? "Next, confirm with Face ID or fingerprint on our payment partner's secure page."
      : "Check the card, then approve. You'll confirm with Face ID or fingerprint on our payment partner's secure page."));
    var rows = el('dl', 'rows');
    var row = el('div', 'row card-row');
    var value = el('dd');
    append(value, el('span', 'card-row-label', wantsNew ? 'A new card' : cardLabel(current)));
    var added = wantsNew ? "You'll add it on the secure page" : !choice.confirmed && cardAdded(current);
    if (added) append(value, el('span', 'fine card-row-added', added));
    append(row, el('dt', null, 'Pay with'), value);
    // Change: with more than one card, or to add a new one (never once the new card is asked for).
    if (!choice.confirmed && !choice.new_card && !ui.cardPickerOpen) {
      var change = el('button', 'btn-change', 'Change');
      change.type = 'button';
      change.setAttribute('aria-label', 'Change card');
      change.disabled = ui.cardBusy;
      change.addEventListener('click', function () {
        ui.cardPickerOpen = true;
        ui.cardPickerDraft = ui.cardDraft === NEW_CARD ? NEW_CARD : current.handle;
        render();
      });
      row.appendChild(change);
    }
    // While the picker is open it IS the card line: the row comes back when a card is picked.
    if (!ui.cardPickerOpen || choice.confirmed) append(card, append(rows, row));
    if (choice.confirmed || choice.new_card === true) {
      var prep = el('div', 'waiting');
      append(prep, spinner(), el('p', 'waiting-text', choice.new_card === true
        ? 'Getting the secure card page ready…' : 'Getting the secure page ready…'));
      card.appendChild(prep);
      return card;
    }
    if (ui.cardPickerOpen) {
      card.appendChild(cardPicker(choice, current));
      return card;
    }
    if (ui.cardMessage) {
      var note = el('p', 'form-error', ui.cardMessage);
      note.setAttribute('role', 'alert');
      card.appendChild(note);
    }
    // The approval terms first: the card is part of what the buyer approves. Approve appears once they are accepted.
    var verb = wantsNew ? 'Add card and approve' : 'Approve';
    if (choice.consent_pending) {
      // ONE tap: the terms, the card and (for a saved card) the approval popup, together.
      var picked = wantsNew ? { new_card: true } : { handle: current.handle };
      if (view.consent) {
        card.appendChild(consentBlock(view, {
          label: 'Agree and ' + (wantsNew ? 'add card and approve' : 'approve') + (quoted ? ' ' + quoted : ''),
          onTap: function () { if (!wantsNew && !ui.cardBusy) preOpenApproval(); },
          then: function () { submitCardChoice(picked); },
        }));
      }
      return card;
    }
    var approve = el('button', 'btn btn-primary', ui.cardBusy ? 'Approving…' : quoted ? verb + ' ' + quoted : verb);
    approve.type = 'button';
    approve.disabled = ui.cardBusy;
    approve.addEventListener('click', function () {
      // Inside the buyer's own tap (a popup opened later, without one, is blocked): a saved card's approval page is
      // the next step, so its popup is opened now and filled when the page exists.
      if (!wantsNew && !ui.cardBusy) preOpenApproval();
      submitCardChoice(wantsNew ? { new_card: true } : { handle: current.handle });
    });
    card.appendChild(approve);
    return card;
  }

  // `choice` is exactly what is sent: {handle} or {new_card: true}; a stale retry sends the same again.
  function submitCardChoice(choice) {
    if (ui.cardBusy) return;
    ui.cardBusy = true;
    ui.cardMessage = null;
    ui.cardPostAt = Date.now();
    render();
    fetch('/agenpas/api/p/' + match[1] + '/card-choice', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Agenpas-Link': token },
      body: JSON.stringify(choice),
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (b) { return { status: res.status, body: b }; });
    }).then(function (r) {
      ui.cardBusy = false;
      if (r.status === 200 && r.body && typeof r.body.screen === 'string') {
        ui.cardConfirmed = true;
        ui.cardRetries = 0;
        ui.cardPickerOpen = false;
        ui.view = r.body;
        ui.lastJson = viewKey(r.body);
        render();
        if (r.body.terminal) { stop(); forgetToken(); return; }
        schedule(r.body.poll_after_seconds);
        return;
      }
      var refusal = r.status === 409 && r.body && typeof r.body.error === 'string' ? r.body.error : null;
      if (refusal === 'consent_required') {
        // The terms are not on record (yet, or any more): read again, and the page offers them first.
        ui.cardRetries = 0;
        ui.cardMessage = null;
        pollNow();
        render();
        return;
      }
      if (refusal === 'card_choice_stale' && ui.cardRetries < CARD_CHOICE_RETRIES) {
        // Most often the worker is looking at the purchase this very moment: the same card again, shortly.
        ui.cardRetries += 1;
        ui.cardBusy = true;
        render();
        setTimeout(function () { ui.cardBusy = false; submitCardChoice(choice); }, CARD_CHOICE_RETRY_MS);
        return;
      }
      ui.cardRetries = 0;
      // The card was not taken: no approval page follows, so the popup opened for it goes.
      closePendingPopup();
      if (refusal === 'card_choice_stale' || refusal === 'card_choice_not_offered') {
        ui.cardDraft = null;
        ui.cardMessage = choice && choice.new_card === true
          ? "We couldn't start adding a new card. Check the card, then try again."
          : 'Your saved cards changed. Check the card, then approve again.';
        pollNow();
      } else if (refusal === 'card_choice_closed') {
        ui.cardMessage = null;
        pollNow();
      } else if (r.status === 429) {
        ui.cardMessage = 'Too many tries. Wait a minute, then try again.';
      } else if (r.status === 410) {
        showExpired(r.body && r.body.link_ttl_minutes);
        return;
      } else {
        ui.cardMessage = "We couldn't approve that just now. Please try again in a moment.";
      }
      render();
    }).catch(function () {
      ui.cardBusy = false;
      closePendingPopup();
      ui.cardMessage = "We couldn't approve that just now. Please try again in a moment.";
      render();
    });
  }

  function progressCard(title, body) {
    var card = el('section', 'card step');
    var head = el('div', 'progress-head');
    append(head, spinner(), el('h1', null, title));
    append(card, head, el('p', 'muted', body));
    return card;
  }

  function noticeCard(title, body) {
    var card = el('section', 'card step');
    append(card, el('h1', null, title), el('p', 'muted', body));
    return card;
  }

  function resultCard(kind, title, body, extra) {
    var card = el('section', 'card step result result-' + kind);
    var icon = el('span', 'result-icon icon-' + kind);
    icon.setAttribute('aria-hidden', 'true');
    append(card, icon, el('h1', null, title), el('p', 'muted', body));
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
    row('Paid with', cardText(view));
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
      extra = el('p', 'back-hint', 'You can go back to the chat to try again.');
    }
    return resultCard(kind, outcome.title || "This purchase didn't go through", outcome.message || 'Go back to the chat to check what happened.', extra);
  }

  // ---- the shipping address (AGENPAS_COLLECT_SHIPPING) ----------------------------------------------------------
  //
  // A plain form of the fields the purchase is missing. There is NO card field: the card is only ever typed on the
  // payment partner's page. The address goes only to this page's own API (same origin) and is never stored.

  var ADDRESS_FIELDS = {
    email: { label: 'Email', type: 'email', autocomplete: 'email', inputmode: 'email' },
    firstName: { label: 'First name', autocomplete: 'shipping given-name' },
    lastName: { label: 'Last name', autocomplete: 'shipping family-name' },
    phone: { label: 'Phone', type: 'tel', autocomplete: 'shipping tel', inputmode: 'tel' },
    addressLine1: { label: 'Address', autocomplete: 'shipping address-line1' },
    addressLine2: { label: 'Apartment, suite, etc. (optional)', autocomplete: 'shipping address-line2', optional: true },
    city: { label: 'City', autocomplete: 'shipping address-level2' },
    region: { label: 'State', autocomplete: 'shipping address-level1' },
    postalCode: { label: 'ZIP code', autocomplete: 'shipping postal-code' },
    country: { label: 'Country', autocomplete: 'shipping country', options: [['US', 'United States']] },
  };
  // The backend's caps for these two (a2a_shipping_address.MAX_LENGTH); every other field: 200.
  var FIELD_MAX_CHARS = { region: 100, postalCode: 32 };
  var ADDRESS_ORDER = ['email', 'firstName', 'lastName', 'phone', 'addressLine1', 'addressLine2', 'city', 'region', 'postalCode', 'country'];
  var ERROR_TEXT = {
    required: 'This is required.',
    invalid_email: 'Enter a valid email address.',
    invalid_phone: 'Enter a valid phone number.',
    unsupported_country: 'We can only ship to the United States for now.',
    too_long: 'This is too long.',
    invalid_characters: 'Remove the special characters.',
  };

  // Offered beside a whole address (one whose first line is asked for) when the backend does NOT list them: the store's
  // own checkout asks for a state or ZIP if it needs one. Only such an added field is optional; a field the backend
  // lists stays required, whatever it is.
  var ADDRESS_OPTIONAL_COMPANIONS = ['region', 'postalCode'];

  function listedFieldsOf(view) {
    var req = view.address_request || {};
    return Array.isArray(req.fields_missing) ? req.fields_missing : [];
  }

  /** The companions this form adds as optional: not listed by the backend, beside a listed `addressLine1`. */
  function addedOptionalOf(view) {
    var listed = listedFieldsOf(view);
    if (listed.indexOf('addressLine1') < 0) return [];
    return ADDRESS_OPTIONAL_COMPANIONS.filter(function (f) { return listed.indexOf(f) < 0; });
  }

  function addressFieldsOf(view) {
    var shown = listedFieldsOf(view).concat(addedOptionalOf(view));
    return ADDRESS_ORDER.filter(function (f) { return shown.indexOf(f) >= 0; });
  }

  function fieldOptional(field, added) {
    return Boolean(ADDRESS_FIELDS[field].optional) || added.indexOf(field) >= 0;
  }

  /** Client-side checks for a quick answer; the gateway and the backend check again. Returns {field: code}. */
  function checkAddress(fields, values, added) {
    var errors = {};
    fields.forEach(function (f) {
      var v = String(values[f] || '').trim();
      if (!v) {
        if (!fieldOptional(f, added || [])) errors[f] = 'required';
        return;
      }
      if (v.length > (FIELD_MAX_CHARS[f] || 200)) errors[f] = 'too_long';
      else if (f === 'email' && !/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(v)) errors[f] = 'invalid_email';
      else if (f === 'phone' && (!/^[0-9+\s\-().]+$/.test(v) || v.replace(/[^0-9]/g, '').length < 10)) errors[f] = 'invalid_phone';
      else if (f === 'country' && v.toUpperCase() !== 'US') errors[f] = 'unsupported_country';
    });
    return errors;
  }

  function addressInput(field, added) {
    var meta = ADDRESS_FIELDS[field];
    var optional = fieldOptional(field, added || []);
    var addedLabel = added && added.indexOf(field) >= 0;
    var id = 'agenpas-' + field;
    // One box per field, its label inside; `field-<name>` sets how wide it sits in a row.
    var wrap = el('div', 'field field-' + field + (ui.addressErrors[field] ? ' field-bad' : ''));
    var label = el('label', 'field-label', addedLabel ? meta.label + ' (optional)' : meta.label);
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
    if (!optional) input.setAttribute('aria-required', 'true');
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
    if (ui.addressClosed) {
      return noticeCard("We can't take your address here any more", 'Go back to the chat.');
    }
    // The address step is consent-gated: the terms first, and the form only from a later read (the API then sends
    // `address_request`). Whatever the buyer already typed is kept in memory for it.
    if (view.consent && !view.address_request) {
      var gate = el('section', 'card step');
      append(gate, el('h1', null, 'Where should we send it?'),
        el('p', 'muted', 'Your address goes to ' + merchantName(view) + ' so they can ship your order.'));
      if (ui.addressConsentNote) {
        var note = el('p', 'fine', ui.addressConsentNote);
        note.setAttribute('role', 'status');
        gate.appendChild(note);
      }
      gate.appendChild(consentBlock(view));
      return assurance(view, gate);
    }
    // Sent back to the terms and not accepted again yet: never the form without them (no resend loop).
    if (ui.addressSentBack) {
      return progressCard('Checking the terms…', 'This page updates on its own. What you typed is kept.');
    }
    var fields = addressFieldsOf(view);
    var added = addedOptionalOf(view);
    var prefill = (view.address_request && view.address_request.prefill) || {};
    Object.keys(prefill).forEach(function (k) {
      if (ui.address[k] === undefined && typeof prefill[k] === 'string') ui.address[k] = prefill[k];
    });
    var card = el('section', 'card step');
    append(card, el('h1', null, 'Where should we send it?'),
      el('p', 'muted', 'Your address goes to ' + merchantName(view) + ' so they can ship your order.'));
    var form = el('form', 'address-form');
    form.setAttribute('novalidate', 'novalidate');
    fields.forEach(function (f) { form.appendChild(addressInput(f, added)); });
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
      submitAddress(view, fields, added);
    });
    card.appendChild(form);
    return assurance(view, card);
  }

  function submitAddress(view, fields, added) {
    if (ui.addressBusy) return;
    var errors = checkAddress(fields, ui.address, added);
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
      var refusal = r.status === 409 && r.body && typeof r.body.error === 'string' ? r.body.error : null;
      if (refusal === 'consent_required') {
        // The terms for this step are not accepted (yet, or any more): back to them, never the form without them.
        // What the buyer typed stays in memory and fills the form again once they agree; the page says so. Sent back
        // again after a fresh acceptance: the step closes (no loop).
        ui.addressMessage = null;
        ui.addressErrors = {};
        ui.addressSentBackCount += 1;
        if (ui.addressSentBackCount >= 2) {
          ui.addressClosed = true;
        } else {
          ui.addressSentBack = true;
          ui.addressConsentNote = 'Please accept the terms first. What you typed is kept, and the form comes back after you agree.';
        }
        if (ui.consent && ui.consent.step === 'shipping_address') ui.consent = null;
        ui.lastJson = null;
        render();
        pollNow();
        return;
      }
      if (refusal === 'address_not_taken' || (refusal === 'address_not_requested' && ui.addressNotRequestedCount >= 1)) {
        // The address can't be taken here any more (collection turned off, ...), or the step is still not asked for
        // after a fresh read: closed, never a retry loop and never a generic error. Read the purchase again.
        ui.addressMessage = null;
        ui.addressErrors = {};
        ui.addressClosed = true;
        ui.lastJson = null;
        render();
        pollNow();
        return;
      }
      if (refusal === 'address_not_requested') {
        // The purchase is past the address step (or not at it): the next read shows where it is.
        ui.addressNotRequestedCount += 1;
        ui.addressMessage = null;
        ui.addressErrors = {};
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
        // "Pivota never sees your card number" is said once, in the page's footer.
        return assurance(view, actionCard(view, {
          title: 'Add a card',
          body: "You'll enter it on our payment partner's secure page.",
          button: 'Add a card securely',
          waiting: 'Waiting for your card…',
        }));
      case 'choose_card':
        return assurance(view, chooseCardCard(view));
      case 'confirming_total': {
        var confirming = progressCard('Confirming your total', 'Getting the final total from ' + m + ', including shipping and tax…');
        // The approval's terms may be accepted while the total is confirmed.
        if (view.consent) confirming.appendChild(consentBlock(view));
        return assurance(view, confirming);
      }
      case 'unavailable':
        return noticeCard("This step isn't available right now", 'Please go back to the chat and try again in a little while. This page updates on its own.');
      case 'details_needed':
        return noticeCard((view.outcome && view.outcome.title) || 'Some details are needed',
          (view.outcome && view.outcome.message) || 'Go back to the chat to continue.');
      case 'approve':
        return assurance(view, actionCard(view, {
          title: 'Approve your purchase',
          body: "With Face ID or fingerprint, on our payment partner's secure page.",
          // The card was confirmed on this page with "Approve": this button only opens the secure page.
          button: ui.cardConfirmed ? 'Continue to the secure page' : quoted ? 'Approve ' + quoted : 'Approve',
          waiting: 'Waiting for your approval…',
          showCard: true,
        }));
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
    reconcilePopups(view);
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

  // ---- popups this page opened --------------------------------------------------------------------------------------
  //
  // THE APPROVAL AFTER THE CARD CHOICE (staging run-through 11-27: a second tap on "Continue to the secure page" right after
  // Approve felt redundant). On desktop the card choice's Approve opens the popup inside that tap, showing "Getting the
  // secure page ready…", and the approval page is loaded into it as soon as a read carries it. Only from the buyer's
  // own tap on THIS page (memory only: a reload, another tab or a later visit has none), consumed once, given up after
  // PENDING_POPUP_MS or as soon as the purchase goes anywhere but towards its approval. Mobile and webviews keep the one
  // tap on the secure page button (a background tab may be paused, and a webview may refuse a window it did not ask for).
  //
  // CLOSING. A hosted popup this page opened is closed once its step is over (the partner's page may stay on "safe to
  // close now"): the approval once the order is being placed (or ended), the card page once the card is in. Never on a
  // screen that does not say the step moved on ("not available right now", a read error): the buyer may still be there.
  var PENDING_POPUP_MS = 180000;
  var PENDING_POPUP_SCREENS = { choose_card: true, confirming_total: true, approve: true };
  var STEP_OVER = {
    approval: { placing: true, authenticate: true, done: true, failed: true, refused: true, expired: true, outcome_unknown: true },
    card_binding: { choose_card: true, confirming_total: true, approve: true, placing: true, done: true, failed: true, refused: true,
      expired: true, outcome_unknown: true },
    authenticate: { done: true, failed: true, refused: true, expired: true, outcome_unknown: true },
  };

  function windowClosed(w) {
    try {
      return !w || w.closed;
    } catch (e) {
      return true;
    }
  }

  function preOpenApproval() {
    if (!isDesktop()) return;
    closePendingPopup();
    var w = null;
    try {
      w = window.open('', 'agenpas_hosted', 'popup=yes,width=480,height=760');
    } catch (e) {
      w = null;
    }
    // Blocked: the approve screen's button stays the way there, exactly as before.
    if (!w) return;
    try { w.opener = null; } catch (e) { /* ignore */ }
    try {
      w.document.title = 'Secure page';
      w.document.body.textContent = 'Getting the secure page ready…';
    } catch (e) { /* a window of another origin under that name: it is replaced when the page is ready */ }
    ui.pendingPopup = { win: w, until: Date.now() + PENDING_POPUP_MS };
  }

  function closePendingPopup() {
    var p = ui.pendingPopup;
    ui.pendingPopup = null;
    if (p && !windowClosed(p.win)) {
      try { p.win.close(); } catch (e) { /* ignore */ }
    }
  }

  function showInPopup(w, action) {
    try {
      w.location.replace(action.url);
    } catch (e) {
      w.location.href = action.url;
    }
    ui.popup = w;
    ui.popupKind = action.kind;
    watchPopup();
  }

  function reconcilePopups(view) {
    var p = ui.pendingPopup;
    if (p) {
      var a = view.action;
      if (windowClosed(p.win)) {
        ui.pendingPopup = null;
      } else if (view.screen === 'approve' && a && a.kind === 'approval' && a.open_mode !== 'embed' && isHttps(a.url)) {
        ui.pendingPopup = null;
        showInPopup(p.win, a);
        ui.waitingKind = a.kind;
        schedule(POLL_MIN);
      } else if (Date.now() > p.until || !PENDING_POPUP_SCREENS[view.screen] || (a && a.open_mode === 'embed') || view.terminal) {
        closePendingPopup();
      }
    }
    var over = ui.popupKind && STEP_OVER[ui.popupKind];
    if (ui.popup && over && over[view.screen]) {
      var w = ui.popup;
      ui.popup = null;
      ui.popupKind = null;
      if (ui.popupTimer) clearInterval(ui.popupTimer);
      ui.popupTimer = null;
      if (!windowClosed(w)) {
        try { w.close(); } catch (e) { /* ignore */ }
      }
    }
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
        showInPopup(w, action);
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
    renderMessage('This link has expired', 'For your security, AgenPaz links ' + lasting + '. Go back to the chat and ask for a new link to see your purchase.');
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

  // The address step across reads. Sent back to the terms but the reads keep showing the form (the backend's read and
  // write disagree): after a few such reads the step closes ("Go back to the chat") rather than wait forever. A read
  // that shows a NEW form (after one without it) starts the "not requested" count again.
  var ADDRESS_SENT_BACK_MAX_READS = 3;
  function trackAddressStep(body) {
    var hasForm = Boolean(body.address_request);
    var hadForm = Boolean(ui.view && ui.view.address_request);
    if (hasForm && !hadForm) ui.addressNotRequestedCount = 0;
    if (ui.addressSentBack && hasForm && !body.consent) {
      ui.addressSentBackReads += 1;
      if (ui.addressSentBackReads >= ADDRESS_SENT_BACK_MAX_READS && !ui.addressClosed) {
        ui.addressClosed = true;
        ui.lastJson = null;
      }
    } else if (!ui.addressSentBack) {
      ui.addressSentBackReads = 0;
    }
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
    var startedAt = ui.lastPollAt;
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
      if (r.status === 200 && r.body && typeof r.body.screen === 'string' && startedAt < ui.cardPostAt) {
        // Read before the card was confirmed (or refused): older than what the page holds. Read again shortly.
        schedule(POLL_MIN);
        return;
      }
      if (r.status === 200 && r.body && typeof r.body.screen === 'string') {
        syncConsent(r.body);
        trackAddressStep(r.body);
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
