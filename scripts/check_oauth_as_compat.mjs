#!/usr/bin/env node
// Check that a managed Authorization Server is compatible with the Pivota MCP OAuth front door.
//
// Usage:
//   node scripts/check_oauth_as_compat.mjs <issuer-url> [expected-resource-audience]
//
// It fetches the AS metadata (RFC 8414 / OIDC), the JWKS, and reports:
//   - token endpoint, authorization endpoint
//   - Dynamic Client Registration endpoint (RFC 7591) — required for frontier MCP clients
//   - JWKS asymmetric signing algs (our verifier requires RS*/PS*/ES*/EdDSA)
//   - whether resource indicators / audience are supported
// Exit 0 if compatible, 1 otherwise. No secrets needed (all endpoints are public).

const issuer = (process.argv[2] || '').replace(/\/+$/, '');
const expectedAud = process.argv[3] || null;

if (!issuer) {
  console.error('usage: node scripts/check_oauth_as_compat.mjs <issuer-url> [expected-resource-audience]');
  process.exit(2);
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function discover() {
  const candidates = [
    `${issuer}/.well-known/oauth-authorization-server`,
    `${issuer}/.well-known/openid-configuration`,
  ];
  for (const url of candidates) {
    try {
      const doc = await getJson(url);
      return { url, doc };
    } catch {
      /* try next */
    }
  }
  throw new Error('no AS metadata at /.well-known/oauth-authorization-server or /.well-known/openid-configuration');
}

const ASYM = /^(?:RS|PS|ES)\d{3}$|^EdDSA$/;

(async () => {
  const out = { issuer, compatible: true, problems: [], notes: [] };
  let meta;
  try {
    ({ doc: meta } = await discover());
  } catch (e) {
    console.error(`FAIL: ${e.message}`);
    process.exit(1);
  }

  out.token_endpoint = meta.token_endpoint || null;
  out.authorization_endpoint = meta.authorization_endpoint || null;
  out.registration_endpoint = meta.registration_endpoint || null;
  out.jwks_uri = meta.jwks_uri || null;

  if (!out.token_endpoint) out.problems.push('no token_endpoint');
  if (!out.authorization_endpoint) out.problems.push('no authorization_endpoint');
  if (!out.registration_endpoint) {
    out.problems.push('no registration_endpoint (Dynamic Client Registration) — frontier MCP clients need DCR');
  }
  if (!out.jwks_uri) out.problems.push('no jwks_uri (our verifier needs pinned JWKS)');

  if (Array.isArray(meta.code_challenge_methods_supported) && !meta.code_challenge_methods_supported.includes('S256')) {
    out.problems.push('PKCE S256 not advertised');
  }
  // RFC 8707 resource indicators (nice-to-have; some AS bind audience differently)
  out.resource_indicators = Boolean(meta.resource_indicators_supported || meta.resource_parameter_supported);
  if (!out.resource_indicators) {
    out.notes.push('AS does not advertise resource indicators (RFC 8707); confirm the access-token "aud" can be set to the MCP resource URL, else use that AS-default audience in MCP_OAUTH_RESOURCE.');
  }

  if (out.jwks_uri) {
    try {
      const jwks = await getJson(out.jwks_uri);
      const algs = [...new Set((jwks.keys || []).map((k) => k.alg).filter(Boolean))];
      out.jwks_algs = algs;
      const asym = algs.filter((a) => ASYM.test(a));
      if (algs.length && asym.length === 0) {
        out.problems.push(`JWKS advertises only non-asymmetric algs (${algs.join(',')}); verifier requires RS*/PS*/ES*/EdDSA`);
      }
      out.jwks_key_count = (jwks.keys || []).length;
    } catch (e) {
      out.problems.push(`could not fetch JWKS: ${e.message}`);
    }
  }

  out.compatible = out.problems.length === 0;
  if (out.compatible) {
    out.recommended_env = {
      MCP_OAUTH_ENABLED: '1',
      MCP_OAUTH_AUTHORIZATION_SERVERS: issuer,
      MCP_OAUTH_ISSUERS_JSON: JSON.stringify([
        { iss: issuer, jwksUri: out.jwks_uri, algs: (out.jwks_algs && out.jwks_algs.filter((a) => ASYM.test(a))) || ['ES256', 'RS256'] },
      ]),
      MCP_OAUTH_RESOURCE: expectedAud || 'https://pivota-agent-production.up.railway.app/mcp',
    };
  }

  console.log(JSON.stringify(out, null, 2));
  process.exit(out.compatible ? 0 : 1);
})().catch((e) => {
  console.error(`ERROR: ${e?.message || e}`);
  process.exit(1);
});
