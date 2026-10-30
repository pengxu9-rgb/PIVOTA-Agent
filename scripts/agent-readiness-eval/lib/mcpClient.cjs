'use strict';

// A partner-shaped MCP client: JSON-RPC 2.0 over the MCP Streamable HTTP transport, exactly what an external
// agent platform sends to the gateway's /mcp and /public/mcp doors (src/server.js; adapter
// mcp-server/src/remoteMcpAdapter.js):
//
//   POST initialize                 -> result { protocolVersion, serverInfo, capabilities }
//   POST notifications/initialized  -> 202 (no body)
//   POST tools/list                 -> result { tools: [{ name, description, inputSchema, annotations }] }
//   POST tools/call                 -> result { content: [{type:'text', text}], structuredContent?, isError? }
//
// The gateway answers application/json. A spec-conformant server may also answer text/event-stream; this
// client accepts both, so the harness does not silently depend on one server's transport choice. The
// gateway's edge heartbeat (src/services/publicReadMcpHeartbeat.js) commits a 200 early and pads the body
// with leading newlines — valid JSON whitespace — so the body is trimmed before parsing.
//
// Every call is timed client-side: `ttfb_ms` is when response headers arrived (the heartbeat commits
// headers early, so ttfb can be far below latency on a slow call), `latency_ms` when the body completed.
//
// NEVER LOGS A SECRET. Auth headers are built per request from the injected credential; nothing here
// writes them anywhere.

const { classifyTarget, ATTESTATION } = require('./safety.cjs');

const DEFAULT_ACCEPT = 'application/json, text/event-stream';

// THE ONLY TOOLS THIS CLIENT WILL EVER CALL. Compiled in, checked before any I/O: whatever the journey code,
// the config or a server's tools/list says, a checkout / payment / order tool cannot be invoked from here.
const ALLOWED_TOOLS = Object.freeze(['search_catalog', 'get_product', 'get_offers', 'get_alternatives', 'recommend_products']);

// Outcomes after which the client sends NOTHING more: the target is not provably the eval deployment
// (attestation_missing), or it tried to send us elsewhere (redirect_refused).
const HALTING_OUTCOMES = new Set(['attestation_missing', 'redirect_refused']);

class McpClient {
  /**
   * @param {{
   *   endpoint: string, auth?: 'none'|'api_key'|'bearer', apiKey?: string|null, bearerToken?: string|null,
   *   timeoutMs?: number, fetchImpl?: Function, protocolVersion?: string,
   *   clientInfo?: {name:string, version:string}, extraHeaders?: object, now?: () => number,
   * }} opts
   */
  constructor(opts) {
    if (!opts || !opts.endpoint) throw new Error('McpClient requires an endpoint');
    // Second, independent target check (run.cjs checks first): the client itself will not be built for an
    // endpoint outside the compiled-in allowlist, so removing one guard does not open the network.
    const target = classifyTarget(opts.endpoint);
    if (!target.ok) throw new Error(`McpClient refuses this endpoint: ${target.problem}`);
    this.endpoint = opts.endpoint;
    this.auth = opts.auth || 'none';
    this.apiKey = opts.apiKey || null;
    this.bearerToken = opts.bearerToken || null;
    this.timeoutMs = opts.timeoutMs || 30000;
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.requestedProtocolVersion = opts.protocolVersion || '2025-06-18';
    this.clientInfo = opts.clientInfo || { name: 'pivota-readiness-eval', version: '1.0.0' };
    this.extraHeaders = opts.extraHeaders || {};
    for (const k of Object.keys(this.extraHeaders)) {
      if (/^(host|authorization|x-agent-api-key|mcp-session-id)$/i.test(k)) throw new Error(`McpClient: extra header ${k} is not allowed`);
    }
    // Set once a response fails the attestation or redirects; every later send returns without I/O.
    this.halted = null;
    // Run-wide cancellation (safety.createKillSwitch().signal): aborts in-flight requests and refuses new ones.
    this.runSignal = opts.runSignal || null;
    this.now = opts.now || (() => performance.now());
    this.nextId = 1;
    this.sessionId = null;
    this.negotiatedProtocolVersion = null;
    this.serverInfo = null;
    if (typeof this.fetchImpl !== 'function') throw new Error('McpClient needs fetch (Node >= 18)');
  }

  headers({ initialized = true } = {}) {
    const h = {
      'content-type': 'application/json',
      accept: DEFAULT_ACCEPT,
      ...this.extraHeaders,
    };
    if (initialized && this.negotiatedProtocolVersion) h['mcp-protocol-version'] = this.negotiatedProtocolVersion;
    if (this.sessionId) h['mcp-session-id'] = this.sessionId;
    if (this.auth === 'api_key' && this.apiKey) h['x-agent-api-key'] = this.apiKey;
    if (this.auth === 'bearer' && this.bearerToken) h.authorization = `Bearer ${this.bearerToken}`;
    return h;
  }

  /**
   * Send one JSON-RPC message. Never throws: every failure is a classified record.
   * @returns {Promise<CallRecord>}
   */
  async send(method, params, { notification = false, initialized = true } = {}) {
    if (this.halted) {
      return { method, id: null, http_status: null, ttfb_ms: null, latency_ms: 0, outcome: 'halted', error: this.halted, rpc: null, session_id_header: null };
    }
    if (this.runSignal && this.runSignal.aborted) {
      return { method, id: null, http_status: null, ttfb_ms: null, latency_ms: 0, outcome: 'aborted', error: 'run stopped', rpc: null, session_id_header: null };
    }
    const id = notification ? undefined : this.nextId++;
    const body = { jsonrpc: '2.0', method, ...(id !== undefined ? { id } : {}), ...(params !== undefined ? { params } : {}) };
    const controller = new AbortController();
    const started = this.now();
    let ttfb = null;
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const record = {
      method,
      id: id ?? null,
      http_status: null,
      ttfb_ms: null,
      latency_ms: null,
      outcome: null,
      error: null,
      rpc: null,
      session_id_header: null,
    };
    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: this.headers({ initialized }),
        body: JSON.stringify(body),
        signal: this.runSignal ? AbortSignal.any([controller.signal, this.runSignal]) : controller.signal,
        redirect: 'manual',
      });
      ttfb = this.now() - started;
      record.http_status = res.status;
      const attested = res.headers && typeof res.headers.get === 'function' ? res.headers.get(ATTESTATION.header) : null;
      const halt = attested !== ATTESTATION.value
        ? ['attestation_missing', `response lacks ${ATTESTATION.header}: ${ATTESTATION.value} (got ${attested === null ? 'none' : JSON.stringify(String(attested).slice(0, 40))}); not provably the eval deployment`]
        : res.status >= 300 && res.status < 400
          ? ['redirect_refused', `HTTP ${res.status} redirect refused (redirects are never followed)`]
          : null;
      if (halt) {
        try {
          if (res.body && typeof res.body.cancel === 'function') await res.body.cancel();
        } catch {
          // Nothing to drain.
        }
        record.ttfb_ms = round(ttfb);
        record.latency_ms = round(this.now() - started);
        record.outcome = halt[0];
        record.error = halt[1];
        this.halted = `${halt[0]}: ${halt[1]}`;
        return record;
      }
      const sid = res.headers && typeof res.headers.get === 'function' ? res.headers.get('mcp-session-id') : null;
      if (sid) record.session_id_header = sid;
      const ctype = (res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-type') : '') || '';
      const text = await res.text();
      record.ttfb_ms = round(ttfb);
      record.latency_ms = round(this.now() - started);
      record.content_type = ctype.split(';')[0].trim() || null;
      record.body_bytes = Buffer.byteLength(text || '', 'utf8');
      classifyHttp(record, res.status, text, ctype, id, notification);
    } catch (err) {
      record.latency_ms = round(this.now() - started);
      if (ttfb != null) record.ttfb_ms = round(ttfb);
      if (this.runSignal && this.runSignal.aborted) {
        record.outcome = 'aborted';
        record.error = 'cancelled: run stopped';
      } else if (err && (err.name === 'AbortError' || controller.signal.aborted)) {
        record.outcome = 'timeout';
        record.error = `no complete response within ${this.timeoutMs}ms`;
      } else {
        record.outcome = 'transport_error';
        record.error = sanitizeErrorMessage(err);
      }
    } finally {
      clearTimeout(timer);
    }
    return record;
  }

  /** initialize + notifications/initialized. Returns the initialize record; .ok tells whether the handshake held. */
  async initialize() {
    const rec = await this.send(
      'initialize',
      { protocolVersion: this.requestedProtocolVersion, capabilities: {}, clientInfo: this.clientInfo },
      { initialized: false },
    );
    if (rec.outcome === 'ok' && rec.rpc && rec.rpc.result) {
      this.negotiatedProtocolVersion = rec.rpc.result.protocolVersion || this.requestedProtocolVersion;
      this.serverInfo = rec.rpc.result.serverInfo || null;
      if (rec.session_id_header) this.sessionId = rec.session_id_header;
      const note = await this.send('notifications/initialized', undefined, { notification: true });
      rec.initialized_notification = { outcome: note.outcome, http_status: note.http_status };
    }
    return rec;
  }

  async listTools() {
    return this.send('tools/list', {});
  }

  async callTool(name, args) {
    if (!ALLOWED_TOOLS.includes(name)) {
      throw new Error(`McpClient.callTool: "${name}" is not an allowed tool (allowed: ${ALLOWED_TOOLS.join(', ')})`);
    }
    const rec = await this.send('tools/call', { name, arguments: args || {} });
    rec.tool = name;
    return rec;
  }
}

function round(ms) {
  return Math.round(ms * 10) / 10;
}

// Messages from fetch failures can embed the URL; the URL carries no secret (auth rides in headers), but keep
// the record short and free of anything header-like.
function sanitizeErrorMessage(err) {
  const msg = String((err && (err.cause && err.cause.code)) || (err && err.code) || (err && err.message) || err);
  return msg.replace(/ak_(live_)?[0-9a-f]{16,}/gi, 'ak_<redacted>').slice(0, 200);
}

/** Parse an SSE body and return the JSON-RPC message answering `id` (or the last message). Exported for tests. */
function parseSseJsonRpc(text, id) {
  const events = [];
  let data = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (line === '') {
      if (data.length) events.push(data.join('\n'));
      data = [];
      continue;
    }
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (data.length) events.push(data.join('\n'));
  let last = null;
  for (const ev of events) {
    let msg;
    try {
      msg = JSON.parse(ev);
    } catch {
      continue;
    }
    const msgs = Array.isArray(msg) ? msg : [msg];
    for (const m of msgs) {
      if (m && typeof m === 'object' && ('result' in m || 'error' in m)) {
        last = m;
        if (id !== undefined && m.id === id) return m;
      }
    }
  }
  return last;
}

/** Classify a completed HTTP exchange onto record.outcome / record.rpc. Exported for tests. */
function classifyHttp(record, status, text, ctype, id, notification) {
  if (notification) {
    record.outcome = status >= 200 && status < 300 ? 'ok' : status === 429 ? 'rate_limited' : 'http_error';
    return record;
  }
  if (status === 429) {
    record.outcome = 'rate_limited';
    record.error = 'HTTP 429';
    return record;
  }
  if (status === 401 || status === 403) {
    record.outcome = 'auth_error';
    record.error = `HTTP ${status}`;
    return record;
  }
  if (status < 200 || status >= 300) {
    record.outcome = 'http_error';
    record.error = `HTTP ${status}`;
    return record;
  }
  let msg = null;
  if (/text\/event-stream/i.test(ctype || '')) {
    msg = parseSseJsonRpc(text, id);
  } else {
    try {
      msg = JSON.parse(String(text || '').trim());
    } catch {
      msg = null;
    }
  }
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
    record.outcome = 'parse_error';
    record.error = 'response is not a JSON-RPC 2.0 message';
    return record;
  }
  record.rpc = msg;
  if (msg.error) {
    record.outcome = 'jsonrpc_error';
    record.error = `JSON-RPC ${msg.error.code}: ${String(msg.error.message || '').slice(0, 160)}`;
    return record;
  }
  if (id !== undefined && msg.id !== id) {
    record.outcome = 'parse_error';
    record.error = `JSON-RPC id mismatch (sent ${id}, got ${msg.id})`;
    return record;
  }
  record.outcome = 'ok';
  return record;
}

module.exports = { McpClient, parseSseJsonRpc, classifyHttp, sanitizeErrorMessage, HALTING_OUTCOMES, ALLOWED_TOOLS };
