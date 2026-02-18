const Ajv2020 = require('ajv/dist/2020').default;
const addFormats = require('ajv-formats');
const schema = require('./recoBlocksResponse.v2.schema.json');

const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
  allowUnionTypes: true,
});

addFormats(ajv);

const validateFn = ajv.compile(schema);

function formatAjvError(err) {
  const path = err && err.instancePath ? err.instancePath : '/';
  const message = err && err.message ? err.message : 'invalid';
  return `${path} ${message}`.trim();
}

function validateRecoBlocksResponse(resp) {
  const ok = Boolean(validateFn(resp));
  if (ok) return { ok: true, errors: [] };
  const rawErrors = Array.isArray(validateFn.errors) ? validateFn.errors : [];
  return {
    ok: false,
    errors: rawErrors.map(formatAjvError),
  };
}

module.exports = {
  validateRecoBlocksResponse,
  RECO_BLOCKS_RESPONSE_SCHEMA_ID: schema.$id,
};
