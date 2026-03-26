const { EventEmitter } = require('events');

function normalizeHeaders(headers) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers || {})) {
    normalized[String(key).toLowerCase()] = value;
  }
  return normalized;
}

class ResponseCapture extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = {};
    this.headersSent = false;
    this.finished = false;
    this.body = undefined;
  }

  status(code) {
    this.statusCode = Number(code) || 200;
    return this;
  }

  setHeader(name, value) {
    this.headers[String(name).toLowerCase()] = value;
    return this;
  }

  set(name, value) {
    return this.setHeader(name, value);
  }

  getHeader(name) {
    return this.headers[String(name).toLowerCase()];
  }

  json(body) {
    this.body = body;
    this.headersSent = true;
    this.finished = true;
    this.emit('finish');
    return this;
  }

  send(body) {
    this.body = body;
    this.headersSent = true;
    this.finished = true;
    this.emit('finish');
    return this;
  }

  end(body) {
    if (body !== undefined) this.body = body;
    this.headersSent = true;
    this.finished = true;
    this.emit('finish');
    return this;
  }
}

async function executeExpressJsonHandler(
  handler,
  { body, headers, routeContext = {}, invokeAuth = null } = {},
) {
  const requestHeaders = normalizeHeaders(headers);
  const req = {
    body,
    headers: requestHeaders,
    method: 'POST',
    path: routeContext.path || '/internal/commerce/invoke',
    originalUrl: routeContext.path || '/internal/commerce/invoke',
    query: routeContext.query || {},
    params: routeContext.params || {},
    socket: routeContext.socket || { localPort: routeContext.localPort || null },
    invokeAuth,
    header(name) {
      return requestHeaders[String(name || '').toLowerCase()];
    },
    get(name) {
      return requestHeaders[String(name || '').toLowerCase()];
    },
  };
  const res = new ResponseCapture();

  await Promise.resolve(handler(req, res, routeContext));
  if (!res.finished) {
    res.end();
  }

  return {
    statusCode: res.statusCode,
    headers: res.headers,
    body: res.body,
  };
}

module.exports = {
  executeExpressJsonHandler,
};
