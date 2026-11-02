#!/usr/bin/env node
'use strict';

// Sign the eval OAuth client in ONCE (lib/oauth.cjs), for the production synthetic target.
//
//   READINESS_EVAL_OAUTH_CLIENT_ID=mcpc_… \
//   READINESS_EVAL_OAUTH_CLIENT_SECRET="$(gcloud secrets versions access 1 --secret=<the client secret>)" \
//     node scripts/agent-readiness-eval/oauth-login.cjs [--token-file <path>]
//   node scripts/agent-readiness-eval/oauth-login.cjs --logout [--token-file <path>]   (deletes the stored token)
//
// Prints the URL to open, waits for the loopback redirect, exchanges the code and stores the token (0600, outside
// any git checkout). Nothing secret is printed. Runbook: docs/runbooks/agent_readiness_eval.md.

const crypto = require('node:crypto');
const oauth = require('./lib/oauth.cjs');

async function main(argv = process.argv.slice(2), env = process.env, io = { out: process.stdout, err: process.stderr }, deps = {}) {
  const i = argv.indexOf('--token-file');
  const file = i >= 0 && argv[i + 1] ? argv[i + 1] : env.READINESS_EVAL_OAUTH_TOKEN_FILE || oauth.DEFAULT_TOKEN_FILE;
  if (argv.includes('--logout')) {
    // Local only: this deletes the stored token, and the access token in it lapses within the hour. Ending the
    // client's access on the server is its owner's step (docs/runbooks/agent_readiness_eval.md, target C).
    const removed = oauth.deleteToken(file);
    io.out.write(removed ? `Deleted the eval token at ${file}.\n` : `No eval token at ${file}.\n`);
    return 0;
  }
  const creds = oauth.clientCredentials(env);
  if (creds.problems.length) {
    io.err.write(`REFUSED:\n${creds.problems.map((p) => `  - ${p}`).join('\n')}\n`);
    return 2;
  }
  const { verifier, challenge } = oauth.pkcePair();
  const state = crypto.randomBytes(16).toString('hex');
  const callback = (deps.awaitCallback || oauth.awaitCallback)({ state });
  io.out.write(`Open this URL in a browser and approve the eval client:\n\n  ${oauth.authorizeUrl({ clientId: creds.clientId, state, challenge })}\n\nWaiting for ${oauth.REDIRECT_URI} ...\n`);
  let code;
  try {
    code = await callback.code;
  } catch (err) {
    io.err.write(`[oauth-login] ${err.message}\n`);
    return 1;
  }
  const token = await oauth.exchangeCode({ code, verifier, clientId: creds.clientId, clientSecret: creds.clientSecret, fetchImpl: deps.fetchImpl });
  oauth.writeToken(file, token);
  io.out.write(`Signed in. Token stored at ${file} (expires ${new Date(token.expires_at * 1000).toISOString()}${token.refresh_token ? ', refreshable' : ', NOT refreshable'}).\n`);
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`[oauth-login] fatal: ${err.message}\n`);
      process.exit(4);
    },
  );
}

module.exports = { main };
