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
 */
(function () {
  'use strict';

  var POLL_MIN = 2;
  var POLL_MAX = 15;
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
      var approved = view.screen === 'placing' || view.screen === 'authenticate';
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
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-top-navigation-by-user-activation');
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

  function actionCard(view, opts) {
    var card = el('section', 'card step');
    append(card, el('h2', null, opts.title));
    append(card, el('p', null, opts.body));
    if (opts.note) append(card, el('p', 'fine', opts.note));
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
    row('Order number', order.reference);
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
    return resultCard('done', 'Order placed', 'Your order at ' + merchantName(view) + ' is confirmed.', extra);
  }

  function outcomeCard(view) {
    var outcome = view.outcome || {};
    var kind = view.screen === 'outcome_unknown' ? 'checking' : 'stopped';
    var extra = null;
    // Never a retry for an outcome-unknown purchase: the order may already exist.
    if (outcome.retry_hint && !outcome.outcome_unknown) {
      extra = el('p', 'fine', 'You can go back to the chat to try again.');
    }
    return resultCard(kind, outcome.title || "This purchase didn't go through", outcome.message || 'Go back to the chat to check what happened.', extra);
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
      case 'confirming_total':
        return progressCard('Confirming your total', 'Getting the final total from ' + m + ', including shipping and tax…');
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
        var json = JSON.stringify(r.body);
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
