'use strict';

// THE REAL @google-cloud/firestore CLIENT, OFFLINE: a loopback gRPC server speaking the slice of google.firestore.v1
// the price cache uses (BatchGetDocuments, BatchWrite), and a TCP proxy in front of it that can FREEZE (accept and hold
// connections, forward nothing: a blackholed peer that never resets) and later HEAL for new connections only, while the
// frozen ones stay frozen. Everything binds 127.0.0.1. The client reaches it with { host, port, ssl: false }, which
// uses insecure channel credentials, so no Google credential or metadata server is involved.

const net = require('node:net');
const path = require('node:path');

function firestoreService() {
  const grpc = require('@grpc/grpc-js');
  const protoLoader = require('@grpc/proto-loader');
  const protos = path.join(path.dirname(require.resolve('@google-cloud/firestore')), '..', 'protos');
  const def = protoLoader.loadSync('google/firestore/v1/firestore.proto', {
    includeDirs: [protos], keepCase: false, longs: String, enums: String, defaults: true, oneofs: true,
  });
  return { grpc, service: grpc.loadPackageDefinition(def).google.firestore.v1.Firestore.service };
}

/** A Firestore that answers: every doc read is `missing`, every write succeeds. Records what it was asked. */
async function startFirestoreServer() {
  const { grpc, service } = firestoreService();
  const seen = { batchGet: [], batchWrite: [], databases: new Set() };
  const server = new grpc.Server();
  const now = () => ({ seconds: String(Math.floor(Date.now() / 1000)), nanos: 0 });
  server.addService(service, {
    batchGetDocuments(call) {
      seen.databases.add(call.request.database);
      seen.batchGet.push(call.request.documents);
      for (const name of call.request.documents) call.write({ missing: name, readTime: now() });
      call.end();
    },
    batchWrite(call, cb) {
      seen.databases.add(call.request.database);
      seen.batchWrite.push(call.request.writes.map((w) => w.update && w.update.name));
      cb(null, { writeResults: call.request.writes.map(() => ({ updateTime: now() })), status: call.request.writes.map(() => ({ code: 0 })) });
    },
  });
  const port = await new Promise((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, p) => (err ? reject(err) : resolve(p)));
  });
  return { port, seen, stop: () => new Promise((r) => server.tryShutdown(() => r())) };
}

/**
 * A TCP proxy to `upstreamPort`. healthy: forwards. freeze(): every open connection stops forwarding (both ways) and
 * new connections are accepted and held, silent. healNew(): new connections forward again; frozen ones stay frozen.
 */
async function startFreezableProxy(upstreamPort) {
  let mode = 'healthy';
  const conns = new Set();
  const server = net.createServer((client) => {
    const c = { client, upstream: null, frozen: mode === 'frozen' };
    conns.add(c);
    client.on('error', () => {});
    client.on('close', () => { conns.delete(c); if (c.upstream) c.upstream.destroy(); });
    if (c.frozen) {
      client.on('data', () => {}); // swallow, answer nothing
      return;
    }
    c.upstream = net.connect(upstreamPort, '127.0.0.1');
    c.upstream.on('error', () => client.destroy());
    client.on('data', (d) => { if (!c.frozen) c.upstream.write(d); });
    c.upstream.on('data', (d) => { if (!c.frozen) client.write(d); });
    c.upstream.on('close', () => { if (!c.frozen) client.destroy(); });
  });
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  return {
    port,
    freeze() { mode = 'frozen'; for (const c of conns) c.frozen = true; },
    healNew() { mode = 'healthy'; },
    connections: () => conns.size,
    stop() {
      for (const c of conns) { c.client.destroy(); if (c.upstream) c.upstream.destroy(); }
      return new Promise((r) => server.close(() => r()));
    },
  };
}

/** A loopback port nothing listens on (connection refused at once). */
async function refusedPort() {
  const s = net.createServer();
  const port = await new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve(s.address().port)));
  await new Promise((r) => s.close(() => r()));
  return port;
}

module.exports = { startFirestoreServer, startFreezableProxy, refusedPort };
