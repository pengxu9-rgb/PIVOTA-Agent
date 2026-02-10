const crypto = require('node:crypto');
const { z } = require('zod');

const SCHEMA_VERSION = 'aurora.ingredient_kb_v2.v1';
const MARKET_VALUES = ['EU', 'CN', 'JP', 'US', 'GLOBAL'];
const EVIDENCE_GRADES = ['A', 'B', 'C'];

const marketScopeSchema = z.enum(MARKET_VALUES);
const evidenceGradeSchema = z.enum(EVIDENCE_GRADES);
const httpUrlSchema = z
  .string()
  .url('invalid URL')
  .refine((value) => /^https?:\/\//i.test(value), 'URL must start with http:// or https://');
const timestampSchema = z
  .string()
  .min(10)
  .refine((value) => Number.isFinite(Date.parse(value)), 'invalid datetime');

const citationSchema = z.object({
  source_url: httpUrlSchema,
  doc_title: z.string().min(1).max(240),
  publisher: z.string().min(1).max(160),
  published_at: timestampSchema.nullable().optional(),
  retrieved_at: timestampSchema,
  excerpt: z.string().min(1).max(240),
  hash: z.string().min(16).max(128),
  license_hint: z.string().min(1).max(200).nullable().optional(),
});

const claimSchema = z.object({
  claim_id: z.string().min(1).max(120),
  claim_text: z.string().min(1).max(240),
  evidence_grade: evidenceGradeSchema,
  market_scope: z.array(marketScopeSchema).min(1),
  citations: z.array(citationSchema).min(1),
  risk_flags: z.array(z.string().min(1).max(80)).default([]),
});

const safetyNoteSchema = z.object({
  note_id: z.string().min(1).max(120),
  note_text: z.string().min(1).max(240),
  evidence_grade: evidenceGradeSchema,
  market_scope: z.array(marketScopeSchema).min(1),
  citations: z.array(citationSchema).min(1),
  risk_flags: z.array(z.string().min(1).max(80)).default([]),
});

const ingredientV2Schema = z.object({
  ingredient_id: z.string().min(1).max(120),
  inci_name: z.string().min(1).max(240),
  zh_name: z.string().max(240).nullable().optional(),
  aliases: z.array(z.string().min(1).max(160)).default([]),
  identifiers: z
    .object({
      cosing_id: z.string().max(120).nullable().optional(),
      cas_no: z.string().max(120).nullable().optional(),
      ec_no: z.string().max(120).nullable().optional(),
    })
    .default({}),
  functions: z.array(z.string().min(1).max(120)).default([]),
  restrictions: z.array(z.string().min(1).max(240)).default([]),
  evidence_grade: evidenceGradeSchema,
  market_scope: z.array(marketScopeSchema).min(1),
  claims: z.array(claimSchema).default([]),
  safety_notes: z.array(safetyNoteSchema).default([]),
  do_not_mix: z.array(z.string().min(1).max(160)).default([]),
  manifest_refs: z.array(z.string().min(1).max(160)).default([]),
});

const manifestEntrySchema = z.object({
  source: z.string().min(1).max(160),
  license_hint: z.string().min(1).max(200).nullable().optional(),
  retrieved_at: timestampSchema,
  sha256: z.string().min(32).max(128),
  file_path: z.string().min(1).max(400),
  record_count: z.number().int().min(0),
});

const marketPolicyDocsSchema = z
  .object({
    EU: z.array(citationSchema).default([]),
    CN: z.array(citationSchema).default([]),
    JP: z.array(citationSchema).default([]),
    US: z.array(citationSchema).default([]),
  })
  .default({ EU: [], CN: [], JP: [], US: [] });

const ingredientKbV2DatasetSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  generated_at: timestampSchema,
  ingredients: z.array(ingredientV2Schema),
  manifests: z.array(manifestEntrySchema),
  market_policy_docs: marketPolicyDocsSchema,
});

function createCitationHash(parts) {
  const payload = Array.isArray(parts) ? parts.map((item) => String(item || '').trim()).join('||') : String(parts || '');
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function validateIngredientKbV2(data) {
  return ingredientKbV2DatasetSchema.safeParse(data);
}

function assertValidIngredientKbV2(data) {
  const parsed = validateIngredientKbV2(data);
  if (!parsed.success) {
    const issue = parsed.error.issues && parsed.error.issues[0] ? parsed.error.issues[0] : null;
    const pathText = issue && Array.isArray(issue.path) ? issue.path.join('.') : 'unknown';
    const message = issue && issue.message ? issue.message : 'invalid ingredient kb v2 payload';
    throw new Error(`ingredient_kb_v2 schema invalid at ${pathText}: ${message}`);
  }
  return parsed.data;
}

module.exports = {
  SCHEMA_VERSION,
  MARKET_VALUES,
  EVIDENCE_GRADES,
  citationSchema,
  claimSchema,
  safetyNoteSchema,
  ingredientV2Schema,
  manifestEntrySchema,
  marketPolicyDocsSchema,
  ingredientKbV2DatasetSchema,
  createCitationHash,
  validateIngredientKbV2,
  assertValidIngredientKbV2,
};
