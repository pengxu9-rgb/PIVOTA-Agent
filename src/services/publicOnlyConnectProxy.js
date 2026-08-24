'use strict';

const dns = require('node:dns');
const http = require('node:http');
const net = require('node:net');
const { isPrivateIpAddress } = require('../photoBackendClient');

const CONNECT_TIMEOUT_MS = 10_000;

function parseConnectAuthority(authority) {
  try {
    const raw = String(authority || '').trim();
    // WHATWG normalizes an explicit :443 to an empty URL.port, so retain the
    // CONNECT authority's port check before parsing it as a URL.
    if (!/^([^:/?#\s]+):443$/.test(raw)) return null;
    const target = new URL(`https://${raw}`);
    if (!target.hostname || target.username || target.password || target.pathname !== '/' || target.search || target.hash
      || net.isIP(target.hostname)) return null;
    const hostname = target.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) return null;
    return { hostname, port: 443 };
  } catch {
    return null;
  }
}

async function resolvePublicConnectTarget(authority, { lookup = dns.promises.lookup } = {}) {
  const parsed = parseConnectAuthority(authority);
  if (!parsed) return null;
  try {
    const rows = await lookup(parsed.hostname, { all: true, verbatim: true });
    const addresses = (Array.isArray(rows) ? rows : [rows])
      .map((row) => String(row && row.address || '').trim())
      .filter(Boolean);
    // Reject a mixed answer too: selecting the first public IP would make DNS
    // policy depend on resolver ordering rather than a single public-only rule.
    if (!addresses.length || addresses.some(isPrivateIpAddress)) return null;
    return { ...parsed, address: addresses[0] };
  } catch {
    return null;
  }
}

function createPublicOnlyConnectProxy({
  lookup = dns.promises.lookup,
  connect = net.connect,
  host = '127.0.0.1',
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
} = {}) {
  const server = http.createServer((_req, response) => {
    response.writeHead(405, { connection: 'close' });
    response.end();
  });

  server.on('connect', async (request, clientSocket, head) => {
    const target = await resolvePublicConnectTarget(request.url, { lookup });
    if (!target) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    let upstream;
    let completed = false;
    const deny = () => {
      if (completed) return;
      completed = true;
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      upstream?.destroy();
    };
    try {
      // Connect to the validated address, never the hostname. Chromium sends
      // TLS through this tunnel, preserving SNI while preventing a second DNS
      // lookup from changing the destination (DNS rebinding).
      upstream = connect({ host: target.address, port: target.port });
      upstream.setTimeout(connectTimeoutMs, deny);
      upstream.once('error', deny);
      clientSocket.once('error', () => upstream?.destroy());
      upstream.once('connect', () => {
        if (completed) return;
        completed = true;
        upstream.setTimeout(0);
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head?.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
    } catch {
      deny();
    }
  });

  async function start() {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, host, () => { server.off('error', reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('public_connect_proxy_unavailable');
    return { server: `http://${host}:${address.port}` };
  }

  async function close() {
    if (!server.listening) return;
    await new Promise((resolve) => server.close(() => resolve()));
  }

  return { start, close, server };
}

module.exports = { createPublicOnlyConnectProxy, parseConnectAuthority, resolvePublicConnectTarget };
