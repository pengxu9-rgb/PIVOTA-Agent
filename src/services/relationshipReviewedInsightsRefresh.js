'use strict';

const { identityKey, sha256, __internal: { identity, groundingText } } = require('./relationshipReviewedIngredientEvidence');
const { assessPivotaInsightReplacement, isProtectedPivotaInsight } = require('./pivotaInsightsQuality');
const TABLE = 'public.relgraph_reviewed_seller_evidence';
const MAX_RECORDS = 17;
const DAY = 86400000;
const check = (ok, code) => { if (!ok) throw new Error(code); };
const text = value => typeof value === 'string' ? value.trim() : '';
function allowFields(value, fields) { check(value && Object.keys(value).every(key=>fields.includes(key)), 'insights_unknown_proof_field'); }
function freeze(value) { if(value && typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value; }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const hashValue = value => sha256(JSON.stringify(canonical(value)));
function sourceClaims(source) {
  return [{ id: 'entity', text: source.facts.title, source_field: 'title' },
    ...(source.facts.brand ? [{ id: 'brand', text: source.facts.brand, source_field: 'brand' }] : []),
    { id: 'description', text: source.facts.description.slice(0, 700), source_field: 'description' },
    ...(source.facts.usage ? [{ id: 'usage', text: source.facts.usage.slice(0, 700), source_field: 'usage' }] : [])];
}
function sourcePacket(packet, nowMs = Date.now(), { verifyBody = true, requireCurrent = true } = {}) {
  const owner = identity(packet?.identity);
  const at = Date.parse(packet.source_observed_at);
  check(text(packet.source_observed_at)&&Number.isFinite(at) && at <= nowMs && (!requireCurrent || nowMs - at <= 45 * DAY), 'insights_capture_not_current');
  if(verifyBody) check(Buffer.isBuffer(packet.raw_source_body) && packet.raw_source_body.length > 0 &&
    packet.raw_source_body.length <= 2 * 1024 * 1024 && sha256(packet.raw_source_body) === packet.raw_source_sha256,
  'insights_capture_hash');
  const capture = packet.source_capture;
  allowFields(capture,['capture_method','capture_id','exact_listing_verified','full_ingredient_list','identity','source_url','source_observed_at',
    'raw_source_sha256','source_excerpt','source_excerpt_sha256','formula_sha256']);
  check((capture.full_ingredient_list===undefined||typeof capture.full_ingredient_list==='boolean')&&
    (capture.formula_sha256===undefined||typeof capture.formula_sha256==='string'&&/^[a-f0-9]{64}$/.test(capture.formula_sha256))&&
    (capture.capture_id===undefined||text(capture.capture_id).length>0&&capture.capture_id.length<=512&&/^[a-z0-9._:-]+$/i.test(capture.capture_id))&&
    (capture.source_excerpt===undefined||typeof capture.source_excerpt==='string')&&
    (capture.source_excerpt_sha256===undefined||typeof capture.source_excerpt_sha256==='string'&&/^[a-f0-9]{64}$/.test(capture.source_excerpt_sha256)), 'insights_capture_metadata_type');
  check(capture?.capture_method === 'bound_pdp_fetch' && capture.exact_listing_verified === true &&
    identityKey(capture.identity) === identityKey(owner) && capture.source_url === packet.source_url &&
    capture.source_observed_at === packet.source_observed_at && capture.raw_source_sha256 === packet.raw_source_sha256,
  'insights_capture_binding');
  check(text(packet.source_url)&&packet.source_url.length<=4096,'insights_capture_url');const url = new URL(packet.source_url);
  check(url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.port &&
    ![...url.searchParams.keys()].some(key => /token|password|secret|authorization|api.?key/i.test(key)), 'insights_capture_url');
  const facts = Object.fromEntries(['title', 'brand', 'description', 'usage'].map(field => [field, text(packet.facts?.[field])]));
  const body = verifyBody ? groundingText(packet.raw_source_body.toString('utf8')) : '';
  check(facts.title&&facts.title.length<=512 && facts.brand.length<=256 && facts.description.length >= 80 && facts.description.length <= 6000 && facts.usage.length <= 6000 &&
    (!verifyBody || Object.values(facts).filter(Boolean).every(value => body.includes(groundingText(value)))), 'insights_capture_grounding');
  if(capture.source_excerpt!==undefined) check(text(capture.source_excerpt)&&capture.source_excerpt.length<=8000&&
    sha256(capture.source_excerpt)===capture.source_excerpt_sha256&&(!verifyBody||body.includes(groundingText(capture.source_excerpt)))&&
    Object.values(facts).filter(Boolean).every(value=>groundingText(capture.source_excerpt).includes(groundingText(value))), 'insights_capture_excerpt_grounding');
  return { identity: owner, source_url: url.href, source_observed_at: packet.source_observed_at,
    raw_source_sha256: packet.raw_source_sha256, source_capture: { ...capture, identity:identity(capture.identity) }, facts };
}

function prepareSellerInsights(packet, { nowMs = Date.now(), verifyBody=true, requireCurrent=true } = {}) {
  const source = sourcePacket(packet, nowMs, {verifyBody,requireCurrent});
  // A current-source allowlist excludes old intel, assessment text and social
  // claims. Category heuristics cannot add usage, benefits or safety statements.
  // Retain source sentences verbatim instead of category-derived use or safety claims.
  const description = source.facts.description.slice(0, 700);
  const usage = source.facts.usage.slice(0, 700);
  const freshness = { generated_at: new Date(nowMs).toISOString(), source_version: 'pivota.product_intel.v1' };
  const confidence = { overall: 'low', fields: { what_it_is: 'moderate', routine_fit: 'low' } };
  const core = { display_name: 'Pivota Insights', what_it_is: { headline: source.facts.title, body: description },
    best_for: [], why_it_stands_out: [], routine_fit: { step: '', am_pm: [], pairing_notes: usage ? [usage] : [] },
    watchouts: [], quality_state: 'draft', evidence_profile: 'seller_only', confidence, freshness };
  const bundle = { contract_version: 'pivota.product_intel.v1', canonical_product_ref: { ...source.identity, ...(source.facts.brand?{brand:source.facts.brand}:{}), url: source.source_url },
    product_intel_core: core, quality_state: 'draft', evidence_profile: 'seller_only', confidence, freshness,
    source_coverage: { seller: { available: true }, formula: { available: false }, reviews: { available: false },
      creator: { available: false, count: 0 }, editorial: { available: false, count: 0 } },
    external_highlight_signals: [], market_signal_badges: [], recommendation_intents: [],
    shopping_card: { subtitle: source.facts.title }, search_card: { compact_candidate: source.facts.title },
    provenance: { source_observed_at: source.source_observed_at, source_url: source.source_url,
      raw_source_sha256: source.raw_source_sha256, source_capture: source.source_capture } };
  const claims = sourceClaims(source);
  return { source, bundle, claims, bundle_sha256: hashValue(bundle), source_sha256: hashValue(source) };
}

function validateInsightsReview(prepared, review, nowMs = Date.now()) {
  allowFields(review,['provider','model','review_id','reviewed_at','bundle_sha256','source_sha256','decision','confidence','claims','provider_response_sha256','packet_sha256']);
  check(review.packet_sha256===undefined || typeof review.packet_sha256==='string'&&/^[a-f0-9]{64}$/.test(review.packet_sha256),'insights_review_packet');
  check(review.provider_response_sha256===undefined||typeof review.provider_response_sha256==='string'&&/^[a-f0-9]{64}$/.test(review.provider_response_sha256),'insights_review_response_hash');
  const at = Date.parse(review?.reviewed_at);
  check(['gpt', 'gemini'].includes(review?.provider) && text(review.model)&&text(review.model).length<=128&&text(review.review_id)&&text(review.review_id).length<=512 &&
    Number.isFinite(at) && at >= Date.parse(prepared.source.source_observed_at) && at <= nowMs &&
    review.bundle_sha256 === prepared.bundle_sha256 && review.source_sha256 === prepared.source_sha256 &&
    ['approve', 'reject', 'uncertain'].includes(review.decision) && typeof review.confidence === 'number' &&
    review.confidence >= 0 && review.confidence <= 1, 'insights_review_binding');
  check(Array.isArray(review.claims) && review.claims.length === prepared.claims.length &&
    new Set(review.claims.map(row => row.claim_id)).size === prepared.claims.length, 'insights_review_incomplete');
  for (const claim of prepared.claims) {
    const result = review.claims.find(row => row.claim_id === claim.id);
    allowFields(result,['claim_id','assessment','quote']);
    check(result && ['supported', 'unsupported', 'uncertain'].includes(result.assessment), 'insights_review_claim_missing');
    if (result.assessment === 'supported') check(text(result.quote) &&
      prepared.source.facts[claim.source_field].includes(result.quote) && result.quote.includes(claim.text), 'insights_review_quote');
  }
  return review;
}

function finalizeSellerInsights(prepared, reviews, { nowMs = Date.now() } = {}) {
  check(hashValue(prepared.bundle) === prepared.bundle_sha256 && hashValue(prepared.source) === prepared.source_sha256, 'insights_facts_changed');
  const expectedClaims = sourceClaims(prepared.source);
  check(hashValue(prepared.claims) === hashValue(expectedClaims) &&
    prepared.bundle.product_intel_core.what_it_is.headline === prepared.source.facts.title &&
    prepared.bundle.product_intel_core.what_it_is.body === prepared.source.facts.description.slice(0, 700) &&
    JSON.stringify(prepared.bundle.product_intel_core.routine_fit.pairing_notes) ===
      JSON.stringify(prepared.source.facts.usage ? [prepared.source.facts.usage.slice(0, 700)] : []), 'insights_claims_changed');
  check(Array.isArray(reviews) && reviews.length === 2 && new Set(reviews.map(review => review.provider)).size === 2 &&
    new Set(reviews.map(review => review.review_id)).size === 2, 'insights_independent_review_required');
  reviews.forEach(review => validateInsightsReview(prepared, review, nowMs));
  const accepted = reviews.every(review => review.decision === 'approve' && review.confidence >= 0.9 &&
    review.claims.every(claim => claim.assessment === 'supported'));
  const disagreement = reviews[0].decision !== reviews[1].decision || prepared.claims.some(claim =>
    reviews[0].claims.find(row => row.claim_id === claim.id).assessment !== reviews[1].claims.find(row => row.claim_id === claim.id).assessment);
  if (!accepted) return { status: disagreement ? 'human_review' : 'evidence_hold', entry: null };
  const owner = prepared.source.identity;
  const globallyScoped = owner.pivota_signature_id || [owner.product_id, owner.source_product_id].find(value => /^ext_/i.test(value));
  check(globallyScoped, 'insights_reader_key_unavailable');
  const reviewedAt = new Date(Math.max(...reviews.map(review=>Date.parse(review.reviewed_at)))).toISOString();
  const bundle = JSON.parse(JSON.stringify(prepared.bundle));
  bundle.quality_state = bundle.product_intel_core.quality_state = 'reviewed';
  bundle.provenance = { ...bundle.provenance, review_status: 'completed', review_decision: 'pass',
    reviewer: 'GPT + Gemini source review', reviewer_kind: 'assistant', review_tier: 'assistant_reviewed', reviewed_at: reviewedAt,
    dual_review: reviews, reviewed_bundle_sha256: prepared.bundle_sha256, reviewed_source_sha256: prepared.source_sha256 };
  return { status: 'approved', entry: { kb_key: `product:${globallyScoped}`, analysis: { contract_version: 'pivota.product_intel.v1', product_intel_v1: bundle },
    source: 'relgraph_current_seller_consensus', source_meta: { ...bundle.provenance, evidence_profile: 'seller_only', quality_state: 'reviewed' },
    last_success_at: reviewedAt, last_error: null } };
}

function assertSafeInsightsReplacement(existing, candidate) {
  if (existing) {
    const canonical = existing.analysis?.product_intel_v1?.canonical_product_ref;
    check(canonical && identityKey(canonical) === identityKey(candidate.analysis.product_intel_v1.canonical_product_ref), 'insights_kb_scope_collision');
  }
  const result = assessPivotaInsightReplacement({ existingEntry: existing || null, candidateEntry: candidate, sourceRow: null });
  check(result.allowed === true, 'insights_protected_replacement');
  return result;
}

function makeGraphSellerEvidence(prepared, reviews, { nowMs=Date.now() }={}) {
  check(text(prepared.source?.facts?.brand)&&prepared.source.facts.brand.length<=256,'insights_graph_brand_evidence_required');
  const generatedAt=Date.parse(prepared.bundle?.freshness?.generated_at);
  check(Number.isFinite(generatedAt)&&generatedAt<=nowMs&&generatedAt>=Date.parse(prepared.source?.source_observed_at),'insights_graph_draft_clock');
  const expected=prepareSellerInsights(prepared.source,{nowMs:generatedAt,verifyBody:false,requireCurrent:false});
  check(hashValue(expected.bundle)===hashValue(prepared.bundle)&&hashValue(expected.source)===hashValue(prepared.source)&&
    hashValue(expected.claims)===hashValue(prepared.claims),'insights_graph_extra_claims');
  const outcome=finalizeSellerInsights(prepared,reviews,{nowMs});
  if(outcome.status!=='approved') return {...outcome,record:null};
  check(reviews.every(review=>/^[a-f0-9]{64}$/.test(review.packet_sha256||'')&&text(review.model).length<=128&&text(review.review_id).length<=512&&
    (review.provider==='gpt'?/^gpt-/i.test(review.model):/^gemini-/i.test(review.model))), 'insights_actual_review_receipt_required');
  const source=JSON.parse(JSON.stringify(prepared.source));
  check(text(source.source_capture.capture_id)&&text(source.source_capture.source_excerpt)&&source.source_capture.source_excerpt.length<=8000&&
    source.source_capture.source_excerpt_sha256===sha256(source.source_capture.source_excerpt)&&/^[a-f0-9]{64}$/.test(source.raw_source_sha256), 'insights_graph_capture_proof');
  const record={schema:'relgraph.reviewed_seller_evidence.v1',identity_key:identityKey(source.identity),source,
    draft:prepared.bundle,claims:prepared.claims,bundle_sha256:prepared.bundle_sha256,source_sha256:prepared.source_sha256,reviews,
    graph_only:true,public_insights_eligible:false};
  const snapshot=JSON.parse(JSON.stringify(record));
  return {status:'approved',record:freeze({...snapshot,evidence_id:hashValue(snapshot)})};
}
function validateGraphSellerEvidence(input,{nowMs=Date.now(),requireCurrent=true,rawSourceBody}={}) {
  check(input?.schema==='relgraph.reviewed_seller_evidence.v1'&&input.graph_only===true&&input.public_insights_eligible===false&&JSON.stringify(input).length<=64000,'insights_graph_schema');
  allowFields(input,['schema','identity_key','source','draft','claims','bundle_sha256','source_sha256','reviews','graph_only','public_insights_eligible','evidence_id']);
  allowFields(input.source,['identity','source_url','source_observed_at','raw_source_sha256','source_capture','facts']);
  allowFields(input.source.facts,['title','brand','description','usage']);
  const source=sourcePacket({...input.source,raw_source_body:rawSourceBody},nowMs,{verifyBody:requireCurrent,requireCurrent});
  const prepared={source,bundle:input.draft,claims:input.claims,bundle_sha256:input.bundle_sha256,source_sha256:input.source_sha256};
  const checked=makeGraphSellerEvidence(prepared,input.reviews,{nowMs});
  check(checked.status==='approved'&&checked.record.identity_key===input.identity_key&&checked.record.evidence_id===input.evidence_id,'insights_graph_record_binding');
  return checked.record;
}
function graphSellerBundle(record) {
  const prepared={source:record.source,bundle:record.draft,claims:record.claims,bundle_sha256:record.bundle_sha256,source_sha256:record.source_sha256};
  const final=finalizeSellerInsights(prepared,record.reviews,{nowMs:Math.max(Date.now(),...record.reviews.map(review=>Date.parse(review.reviewed_at)))});
  const bundle=final.entry.analysis.product_intel_v1;
  bundle.freshness.generated_at=record.source.source_observed_at;
  bundle.product_intel_core.freshness.generated_at=record.source.source_observed_at;
  bundle.provenance.evidence_scope='relationship_graph_only';
  bundle.provenance.source_record_ref=record.evidence_id;
  bundle.graph_only=true;bundle.public_insights_eligible=false;
  return bundle;
}
// A collision holds graph-only assistant evidence; it never grants ownership.
// Read every historical canonical spelling, including denied rows that normalizers omit.
function publicSellerCollisionSql(ownerSql, urlSql) {
  const owner = field => `((${ownerSql})->>'${field}')`;
  const scalar = (field,alias) => [`c.doc->>'${field}'`, ...(alias?[`c.doc->>'${alias}'`]:[])];
  const productKeys=scalar('product_key','productKey');
  const signatures=scalar('pivota_signature_id','pivotaSignatureId');
  const ids=[...scalar('product_id','productId'),...scalar('source_product_id','sourceProductId'),...scalar('product_ref','productRef')];
  const knownIds=`ARRAY[${owner('pivota_signature_id')},${owner('product_id')},${owner('source_product_id')}]`;
  return `(public_kb.kb_key = ANY(ARRAY[${owner('product_key')},'product:' || ${owner('pivota_signature_id')},'product:' || ${owner('product_id')},'product:' || ${owner('source_product_id')}])
    OR EXISTS (SELECT 1 FROM (VALUES(public_kb.analysis#>'{product_intel_v1,canonical_product_ref}'),
      (public_kb.analysis#>'{product_intel,canonical_product_ref}'),(public_kb.analysis->'canonical_product_ref')) c(doc)
      WHERE (${owner('product_key')} <> '' AND ${owner('product_key')} = ANY(ARRAY[${productKeys.join(',')}]))
        OR (${owner('pivota_signature_id')} <> '' AND ${owner('pivota_signature_id')} = ANY(ARRAY[${signatures.join(',')}]))
        OR EXISTS (SELECT 1 FROM unnest(ARRAY[${ids.join(',')}]) alias(value)
          WHERE regexp_replace(alias.value,'^product:','','i') = ANY(${knownIds})
            AND (alias.value ~* '^(product:)?(sig_|ext_)' OR
              (lower(COALESCE(c.doc->>'merchant_id',c.doc->>'merchantId',''))=lower(${owner('merchant_id')})
                AND lower(${owner('merchant_id')}) NOT IN ('','external_seed','unknown','n/a','null','none')
                AND lower(COALESCE(c.doc->>'platform',''))=lower(${owner('platform')}))))
        OR ${urlSql} = ANY(ARRAY[c.doc->>'url',c.doc->>'canonical_url',c.doc->>'canonicalUrl']))
    OR EXISTS (SELECT 1 FROM (VALUES(public_kb.analysis->'product_intel_v1'),(public_kb.analysis->'product_intel'),(public_kb.analysis)) b(doc)
      WHERE ${urlSql}=ANY(ARRAY[b.doc#>>'{provenance,source_url}',b.doc#>>'{provenance,official_source_url}',b.doc#>>'{source_coverage,canonical_url}']))
    OR ${urlSql}=ANY(ARRAY[public_kb.source_meta->>'source_url',public_kb.source_meta->>'official_source_url']))`;
}
function publicSellerProtectedSql() {
  return `EXISTS (SELECT 1 FROM (VALUES(public_kb.analysis->'product_intel_v1'),(public_kb.analysis->'product_intel'),(public_kb.analysis)) b(doc)
    WHERE EXISTS (SELECT 1 FROM unnest(ARRAY[b.doc->>'quality_state',b.doc#>>'{product_intel_core,quality_state}',
      b.doc#>>'{provenance,review_decision}',public_kb.source_meta->>'quality_state',public_kb.source_meta->>'review_decision']) state(value)
      WHERE lower(btrim(state.value)) IN ('verified','ready','reject','reject_external','rejected','blocked','needs_review','suppressed','fail','failed'))
    OR EXISTS (SELECT 1 FROM unnest(ARRAY[b.doc#>>'{provenance,reviewer_kind}',b.doc#>>'{provenance,review_tier}',b.doc->>'review_tier',
      public_kb.source_meta->>'reviewer_kind',public_kb.source_meta->>'review_tier',public_kb.source_meta#>>'{review_contract,review_tier}']) tier(value)
      WHERE lower(tier.value) LIKE '%human%')
    OR EXISTS (SELECT 1 FROM unnest(ARRAY[b.doc->>'evidence_profile',b.doc#>>'{product_intel_core,evidence_profile}',public_kb.source_meta->>'evidence_profile']) profile(value)
      WHERE lower(btrim(profile.value)) IN ('community_supported','grounded_verified')))`;
}
async function appendGraphSellerEvidence({pool,records,rawSourceBodies,nowMs=Date.now(),apply=false,rebindExactListing}={}) {
  check(typeof apply==='boolean'&&Array.isArray(records)&&records.length>0&&records.length<=MAX_RECORDS,'insights_graph_batch_bound');
  check(Array.isArray(rawSourceBodies)&&rawSourceBodies.length===records.length,'insights_graph_capture_membership');
  const validated=records.map((record,index)=>validateGraphSellerEvidence(record,{nowMs,rawSourceBody:rawSourceBodies[index]}));
  check(new Set(validated.map(record=>record.identity_key)).size===validated.length,'insights_graph_duplicate_identity');
  check(pool&&typeof pool.connect==='function'&&typeof rebindExactListing==='function','insights_graph_transaction_rebind_required');
  const client=await pool.connect();let active=false;let unknown=false;
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');active=true;
    await client.query("SET LOCAL statement_timeout = '10000ms'");await client.query("SET LOCAL lock_timeout = '3000ms'");
    const available=await client.query('SELECT to_regclass($1) AS regclass',[TABLE]);check(available.rows?.[0]?.regclass,'insights_graph_migration_required');
    for(const record of [...validated].sort((a,b)=>a.identity_key.localeCompare(b.identity_key))) {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[record.identity_key]);
      const product=await rebindExactListing({client,record});
      const {productReadiness}=require('./relationshipEvidenceReadiness');
      check(product&&identityKey(product)===record.identity_key&&product.url===record.source.source_url&&productReadiness(product,{nowMs}).acquisition_source_bound,'insights_graph_listing_drift');
      if(product.product_intel) {
        const intel=product.product_intel;const meta=intel.provenance||{};
        check(!isProtectedPivotaInsight({analysis:{product_intel_v1:intel},source_meta:meta})&&!/human/i.test(text(meta.reviewer_kind)||text(meta.review_tier))&&
          ![intel.quality_state,intel.product_intel_core?.quality_state,meta.quality_state,meta.review_decision].some(value=>/^(reject|reject_external|rejected|blocked|needs_review|suppressed|fail|failed)$/i.test(text(value))),'insights_graph_protected_existing');
      }
      const publicTable=await client.query('SELECT to_regclass($1) AS regclass',['public.aurora_product_intel_kb']);
      if(publicTable.rows?.[0]?.regclass) {
        const publicRows=await client.query(`SELECT analysis,source_meta,kb_key,(${publicSellerProtectedSql()}) AS protected FROM public.aurora_product_intel_kb public_kb
          WHERE ${publicSellerCollisionSql('$1::jsonb','$2')} LIMIT 5 FOR SHARE`,
        [JSON.stringify(record.source.identity),record.source.source_url]);
        check(publicRows.rows.length<=4,'insights_graph_public_scan_incomplete');
        for(const row of publicRows.rows) {
          const bundle=row.analysis?.product_intel_v1||row.analysis?.product_intel||row.analysis||{};const meta={...row.source_meta,...bundle.provenance};
          check(row.protected!==true&&!isProtectedPivotaInsight(row)&&!/human/i.test(text(meta.reviewer_kind)||text(meta.review_tier))&&
            ![bundle.quality_state,bundle.product_intel_core?.quality_state,meta.quality_state,meta.review_decision].some(value=>/^(reject|reject_external|rejected|blocked|needs_review|suppressed|fail|failed)$/i.test(text(value))), 'insights_graph_protected_existing');
        }
      }
      const existing=await client.query(`SELECT proof FROM ${TABLE} WHERE identity_key=$1 LIMIT 5 FOR SHARE`,[record.identity_key]);
      check(existing.rows.length<=4,'insights_graph_existing_incomplete');
      // Initial lane permits append-only refresh of identical reviewed facts;
      // a changed source statement requires a separate reconciliation decision.
      check(existing.rows.every(row=>hashValue(row.proof.source.facts)===hashValue(record.source.facts)&&identityKey(row.proof.source.identity)===record.identity_key), 'insights_graph_existing_conflict');
    }
    let inserted=0;
    if(apply) for(const record of validated) {
      const result=await client.query(`INSERT INTO ${TABLE}(evidence_id,identity_key,source_observed_at,source_url,proof) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(evidence_id) DO NOTHING`,
        [record.evidence_id,record.identity_key,record.source.source_observed_at,record.source.source_url,JSON.stringify(record)]);
      inserted+=result.rowCount||0;
    }
    if(apply) {
      try {await client.query('COMMIT');active=false;}catch(_){unknown=true;active=false;return {schema:'relgraph.seller_ingest_receipt.v1',status:'publication_outcome_unknown',
        evidence_ids:validated.map(record=>record.evidence_id),inserted:null,kb_writes:null,public_kb_writes:0,graph_writes:0,model_calls:0,retry_allowed:false};}
    } else {await client.query('ROLLBACK');active=false;}
    return {schema:'relgraph.seller_ingest_receipt.v1',exact_listings:validated.length,inserted,kb_writes:inserted,public_kb_writes:0,graph_writes:0,model_calls:0,dry_run:!apply};
  } finally {try {if(active)await client.query('ROLLBACK');}finally{client.release(unknown?new Error('insights_commit_outcome_unknown'):undefined);}}
}
module.exports = { TABLE, sourcePacket, prepareSellerInsights, validateInsightsReview, finalizeSellerInsights, assertSafeInsightsReplacement,
  makeGraphSellerEvidence,validateGraphSellerEvidence,graphSellerBundle,appendGraphSellerEvidence,__internal:{hashValue,sourceClaims,publicSellerCollisionSql,publicSellerProtectedSql} };
