#!/usr/bin/env node

const PROFILES = ['default', 'public', 'generic_mcp'];

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function profileEnvKey(profile) {
  return String(profile || 'default')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_');
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function envCandidates(profile, suffix) {
  const profileKey = profileEnvKey(profile);
  return unique([
    `CELESTIAL_COMMERCE_STAGING_${profileKey}_${suffix}`,
    `STAGING_${profileKey}_${suffix}`,
    'CELESTIAL_COMMERCE_STAGING_AUTH_TOKEN' && suffix === 'AUTH_TOKEN'
      ? 'CELESTIAL_COMMERCE_STAGING_AUTH_TOKEN'
      : '',
    'STAGING_AUTH_TOKEN' && suffix === 'AUTH_TOKEN' ? 'STAGING_AUTH_TOKEN' : '',
    'CELESTIAL_COMMERCE_STAGING_DEFAULT_AUTH_TOKEN' && suffix === 'AUTH_TOKEN'
      ? 'CELESTIAL_COMMERCE_STAGING_DEFAULT_AUTH_TOKEN'
      : '',
    'STAGING_DEFAULT_AUTH_TOKEN' && suffix === 'AUTH_TOKEN'
      ? 'STAGING_DEFAULT_AUTH_TOKEN'
      : '',
    'CELESTIAL_COMMERCE_STAGING_AGENT_API_KEY' && suffix === 'AGENT_API_KEY'
      ? 'CELESTIAL_COMMERCE_STAGING_AGENT_API_KEY'
      : '',
    'STAGING_AGENT_API_KEY' && suffix === 'AGENT_API_KEY'
      ? 'STAGING_AGENT_API_KEY'
      : '',
    'CELESTIAL_COMMERCE_STAGING_DEFAULT_AGENT_API_KEY' && suffix === 'AGENT_API_KEY'
      ? 'CELESTIAL_COMMERCE_STAGING_DEFAULT_AGENT_API_KEY'
      : '',
    'STAGING_DEFAULT_AGENT_API_KEY' && suffix === 'AGENT_API_KEY'
      ? 'STAGING_DEFAULT_AGENT_API_KEY'
      : '',
  ]);
}

function resolveEnv(profile, suffix) {
  for (const key of envCandidates(profile, suffix)) {
    const value = clean(process.env[key]);
    if (value) {
      return { key, present: true };
    }
  }
  return { key: '', present: false };
}

function suggestedNames(profile) {
  const profileKey = profileEnvKey(profile);
  if (profileKey === 'DEFAULT') {
    return ['STAGING_AUTH_TOKEN', 'STAGING_AGENT_API_KEY'];
  }
  return [`STAGING_${profileKey}_AUTH_TOKEN`, `STAGING_${profileKey}_AGENT_API_KEY`];
}

const results = PROFILES.map((profile) => {
  const token = resolveEnv(profile, 'AUTH_TOKEN');
  const apiKey = resolveEnv(profile, 'AGENT_API_KEY');
  return {
    profile,
    auth_token_env: token.key || null,
    agent_api_key_env: apiKey.key || null,
    available: token.present || apiKey.present,
    suggested_env_names: suggestedNames(profile),
  };
});

const missing = results.filter((entry) => !entry.available);

const payload = {
  ok: missing.length === 0,
  required_profiles: PROFILES,
  profiles: results,
  missing_profiles: missing.map((entry) => entry.profile),
};

if (missing.length > 0) {
  const details = missing
    .map((entry) => `${entry.profile}: ${entry.suggested_env_names.join(' or ')}`)
    .join('; ');
  console.error(`Missing staging auth profiles: ${details}`);
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(payload, null, 2));
