#!/usr/bin/env node
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {batchDecisions,exportRows,reviewTemplate,evaluateBatch}=require('../src/services/relationshipRecommendationBatchAudit');
function arg(argv,name) {const i=argv.indexOf(`--${name}`);return i<0?null:argv[i+1];}
function read(file) {return JSON.parse(fs.readFileSync(file,'utf8'));}
function write(file,value) {fs.mkdirSync(path.dirname(path.resolve(file)),{recursive:true});fs.writeFileSync(file,`${JSON.stringify(value,null,2)}\n`);}
async function exportBatch(queryFn,review,{runId=null,chunkSize=250}={}) {
  if (!Number.isInteger(chunkSize) || chunkSize<1 || chunkSize>500) throw new Error('Export chunk size must be 1..500');
  const decisions=batchDecisions(review); const rows=[];
  for (let i=0;i<decisions.length;i+=chunkSize) {
    const result=await queryFn(`SELECT id,anchor_type,anchor_ref,anchor_snapshot,candidate_product_ref,candidate_snapshot,
      relation_type,display_label,market,vertical,category_taxonomy,use_case,score_total,score_breakdown,price_evidence,
      source_refs,evidence_grade,label_state,'approved'::text AS review_status,why_candidate,tradeoffs,watchouts,provenance,
      reason_flags,last_verified_at,expires_at,created_at,updated_at,updated_at::text AS updated_at_revision
      FROM relationship_candidate_labels WHERE id=ANY($1::text[]) ORDER BY id`,[decisions.slice(i,i+chunkSize).map(row=>row.id)]);
    rows.push(...result.rows);
  }
  return exportRows(decisions,rows,{runId});
}
async function main(argv=process.argv.slice(2)) {
  if (argv.includes('--help')) {console.log('Read-only batch audit. Export: --run-id ID (or --review artifact.json) --out export.json [--template labels.json]. Offline evaluation: --batch export.json [--labels independent.json] --out quality.json. No --apply supported.');return;}
  if (argv.includes('--apply')) throw new Error('This audit never applies database changes');
  const out=arg(argv,'out'); if (!out) throw new Error('--out required');
  const batchFile=arg(argv,'batch');
  if (batchFile) {
    const batch=read(batchFile); const labels=arg(argv,'labels');const report=evaluateBatch(batch,labels?read(labels):{});
    write(out,report);console.log(JSON.stringify({out,summary:report.summary,complete_batch:report.complete_batch}));
    if (!report.complete_batch) process.exitCode=2;
    return report;
  }
  const runId=arg(argv,'run-id');const reviewFile=arg(argv,'review');
  if (!!runId===!!reviewFile) throw new Error('Supply exactly one explicit --run-id or --review; no implicit latest/time-window scope');
  const {withClient,closePool}=require('../src/db');
  try {
    const batch=await withClient(async client=>{
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        await client.query("SET LOCAL statement_timeout='30s'");
        let review=reviewFile?read(reviewFile):null;
        if (runId) {
          const found=await client.query('SELECT summary FROM relationship_graph_routine_runs WHERE run_id=$1',[runId]);
          if (found.rows.length!==1) throw new Error('Requested run is missing');
          review=found.rows[0].summary;
        }
        const result=await exportBatch(client.query.bind(client),review,{runId});
        await client.query('COMMIT');return result;
      } catch(err) {await client.query('ROLLBACK');throw err;}
    });
    write(out,batch); const template=arg(argv,'template');if(template)write(template,reviewTemplate(batch));
    console.log(JSON.stringify({out,run_id:runId,batch_count:batch.batch_count,exported_count:batch.exported_count,complete:batch.complete,missing_ids:batch.missing_ids}));
    if (!batch.complete) process.exitCode=2;
    return batch;
  } finally {await closePool();}
}
if(require.main===module)main().catch(err=>{console.error(err.message);process.exitCode=1;});
module.exports={exportBatch,main};
