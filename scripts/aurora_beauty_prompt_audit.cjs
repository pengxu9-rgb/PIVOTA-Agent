#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const cp = require('node:child_process');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const cur = argv[i];
    if (!String(cur).startsWith('--')) continue;
    const key = String(cur).slice(2);
    const next = argv[i + 1];
    if (!next || String(next).startsWith('--')) {
      out[key] = 'true';
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function nowStamp() {
  return new Date().toISOString().replace(/[.:]/g, '-');
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function findLatestReport({ dir, prefix }) {
  const list = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .map((name) => ({
      name,
      full: path.join(dir, name),
      mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return list[0] || null;
}

function runNodeInline({ code, cwd, env, timeoutMs }) {
  try {
    const out = cp.execFileSync(process.execPath, ['-e', code], {
      cwd,
      env: { ...process.env, ...(env || {}) },
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout: out, stderr: '', error: null };
  } catch (err) {
    return {
      ok: false,
      stdout: err && err.stdout ? String(err.stdout) : '',
      stderr: err && err.stderr ? String(err.stderr) : '',
      error: String(err && err.message ? err.message : err),
    };
  }
}

function runOnlineExtract({ cwd, base, reportDir }) {
  const run = cp.execFileSync(process.execPath, ['scripts/aurora_reco_prompt_extract.cjs'], {
    cwd,
    env: {
      ...process.env,
      AURORA_BASE_URL: base,
      AURORA_REPORT_DIR: reportDir,
      AURORA_LANG: 'EN',
      AURORA_DEBUG: '1',
    },
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const explicitMatch = run.match(/Report saved:\s*(.+\.json)/);
  if (explicitMatch && explicitMatch[1]) {
    const p = explicitMatch[1].trim();
    if (fs.existsSync(p)) return { reportPath: p, stdout: run };
  }
  const latest = findLatestReport({ dir: reportDir, prefix: 'aurora_reco_prompt_extract_' });
  if (!latest) throw new Error('online extract finished but no report was found');
  return { reportPath: latest.full, stdout: run };
}

function parsePromptMarkers(text) {
  const raw = asString(text);
  return {
    has_SYSTEM_PROMPT: raw.includes('SYSTEM_PROMPT'),
    has_USER_PROMPT_JSON: raw.includes('USER_PROMPT_JSON'),
    has_profile_prefix: raw.includes('profile='),
    has_meta_prefix: raw.includes('meta='),
    length: raw.length,
    preview: raw.slice(0, 1500),
  };
}

function extractOnlineSummary(onlineReport) {
  const rows = asArray(onlineReport && onlineReport.prompts);
  const uniqueTemplates = Array.from(new Set(rows.map((r) => asString(r && r.template_id)).filter(Boolean)));
  const uniqueHashes = Array.from(new Set(rows.map((r) => asString(r && r.prompt_hash)).filter(Boolean)));
  const avgTokenEst = rows.length
    ? Number((rows.reduce((sum, row) => sum + (Number(row && row.token_est) || 0), 0) / rows.length).toFixed(2))
    : 0;
  return {
    prompt_count: rows.length,
    unique_templates: uniqueTemplates,
    unique_hashes: uniqueHashes,
    avg_token_est: avgTokenEst,
    samples: rows.map((row) => ({
      label: row.label || null,
      route: row.route || null,
      template_id: row.template_id || null,
      prompt_hash: row.prompt_hash || null,
      token_est: Number(row.token_est) || 0,
      llm_latency_ms: row.latency_ms_llm == null ? null : Number(row.latency_ms_llm),
      raw_chars: Number(row.prompt_raw_chars) || 0,
      prompt_preview: asString(row.prompt_preview || '').slice(0, 800) || null,
    })),
  };
}

function extractLocalFromLegacyReport(legacy) {
  const chatRecoRaw = asString(legacy?.chat_reco?.prompt_raw);
  const alternativesRaw = asString(legacy?.alternatives?.prompt_raw);
  return {
    source: 'legacy_local_prompt_raw_report',
    force_on: {
      status: chatRecoRaw || alternativesRaw ? 'fallback_loaded' : 'missing',
      reco_prompt: parsePromptMarkers(chatRecoRaw),
      alternatives_prompt: parsePromptMarkers(alternativesRaw),
      template_ids: [legacy?.chat_reco?.trace?.template_id, legacy?.alternatives?.trace?.template_id].filter(Boolean),
    },
    force_off: {
      status: 'not_available_in_legacy_report',
      reco_prompt: null,
      alternatives_prompt: null,
      template_ids: [],
    },
  };
}

function runLocalPromptProbe({ cwd, forceGemini }) {
  const inline = `
process.env.AURORA_BFF_USE_MOCK='true';
process.env.AURORA_BFF_RETENTION_DAYS='0';
process.env.AURORA_CHAT_RESPONSE_META_ENABLED='true';
process.env.AURORA_PROFILE_V2_ENABLED='true';
process.env.AURORA_QA_PLANNER_V1_ENABLED='true';
process.env.AURORA_SAFETY_ENGINE_V1_ENABLED='true';
process.env.AURORA_DIAG_FORCE_GEMINI='${forceGemini ? 'true' : 'false'}';
const express=require('express');
const supertest=require('supertest');
const clientPath=require.resolve('./src/auroraBff/auroraDecisionClient');
delete require.cache[clientPath];
const clientMod=require(clientPath);
const original=clientMod.auroraChat;
const captured=[];
clientMod.auroraChat=async (args={})=>{
  captured.push({query: String(args.query||''), llm_provider: args.llm_provider || null, llm_model: args.llm_model || null});
  return {
    answer:'ok',
    intent:'chat',
    llm_provider: args.llm_provider || null,
    llm_model: args.llm_model || null,
    cards:[{type:'recommendations',payload:{recommendations:[{sku_id:'mock_sku_1',product_id:'mock_product_1'}],recommendation_meta:{source_mode:'local_probe',llm_trace:{template_id:'local_probe',prompt_hash:'local_probe_hash',prompt_chars:String(args.query||'').length,token_est:Math.max(1,Math.round(String(args.query||'').length/4)),latency_ms:1}}}}]
  };
};
const routesPath=require.resolve('./src/auroraBff/routes');
delete require.cache[routesPath];
const {mountAuroraBffRoutes}=require(routesPath);
const app=express();
app.use(express.json({limit:'2mb'}));
mountAuroraBffRoutes(app,{logger:null});
const req=supertest(app);
(async()=>{
  const headers={
    'X-Aurora-UID':'uid_local_prompt_probe',
    'X-Trace-ID':'trace_local_prompt_probe',
    'X-Brief-ID':'brief_local_prompt_probe',
    'X-Lang':'EN',
  };
  await req.post('/v1/profile/update').set(headers).send({skinType:'oily',sensitivity:'medium',barrierStatus:'impaired',goals:['acne'],region:'US'});
  await req.post('/v1/chat').set(headers).send({
    action:{action_id:'chip.start.reco_products',kind:'chip',data:{trigger_source:'chip',reply_text:'Recommend acne-control products with low irritation.',include_alternatives:true}},
    debug:true,
    llm_provider:'openai',
    llm_model:'gpt-4o-mini'
  });
  await req.post('/v1/reco/alternatives').set(headers).send({product_input:'La Roche-Posay Effaclar Duo',max_total:4,include_debug:true});
  const reco = captured[0] || null;
  const alt = captured[1] || null;
  console.log(JSON.stringify({
    ok:true,
    captured_count: captured.length,
    reco_prompt: reco ? {length: String(reco.query||'').length, preview: String(reco.query||'').slice(0,1500)} : null,
    alt_prompt: alt ? {length: String(alt.query||'').length, preview: String(alt.query||'').slice(0,1500)} : null
  }));
})().catch((err)=>{console.error('LOCAL_PROBE_ERR', err && err.message ? err.message : String(err)); process.exitCode=1;}).finally(()=>{clientMod.auroraChat=original; delete require.cache[routesPath]; delete require.cache[clientPath];});
`;

  return runNodeInline({
    code: inline,
    cwd,
    timeoutMs: 35000,
    env: {},
  });
}

function buildMarkdown(report) {
  const lines = [];
  lines.push('# Aurora Beauty Prompt Audit');
  lines.push('');
  lines.push(`- generated_at: ${report.generated_at}`);
  lines.push(`- base: ${report.base}`);
  lines.push(`- online_report: ${report.online.report_path}`);
  lines.push(`- local_source: ${report.local.source}`);
  lines.push('');

  lines.push('## Online');
  lines.push('');
  lines.push(`- prompt_count: ${report.online.summary.prompt_count}`);
  lines.push(`- unique_templates: ${report.online.summary.unique_templates.join(', ') || '(none)'}`);
  lines.push(`- avg_token_est: ${report.online.summary.avg_token_est}`);
  lines.push('');

  lines.push('## Local');
  lines.push('');
  lines.push(`- force_on_status: ${report.local.force_on.status}`);
  lines.push(`- force_off_status: ${report.local.force_off.status}`);
  if (report.local.force_on.reco_prompt) {
    lines.push(`- force_on_reco_prompt_length: ${report.local.force_on.reco_prompt.length}`);
    lines.push(`- force_on_has_SYSTEM_PROMPT: ${String(report.local.force_on.reco_prompt.has_SYSTEM_PROMPT)}`);
    lines.push(`- force_on_has_USER_PROMPT_JSON: ${String(report.local.force_on.reco_prompt.has_USER_PROMPT_JSON)}`);
  }
  if (report.local.force_off.reco_prompt) {
    lines.push(`- force_off_reco_prompt_length: ${report.local.force_off.reco_prompt.length}`);
    lines.push(`- force_off_has_SYSTEM_PROMPT: ${String(report.local.force_off.reco_prompt.has_SYSTEM_PROMPT)}`);
    lines.push(`- force_off_has_USER_PROMPT_JSON: ${String(report.local.force_off.reco_prompt.has_USER_PROMPT_JSON)}`);
  }
  lines.push('');

  lines.push('## Coverage');
  lines.push('');
  lines.push(`- has_reco_main_template: ${String(report.coverage.has_reco_main_template)}`);
  lines.push(`- has_reco_alternatives_template: ${String(report.coverage.has_reco_alternatives_template)}`);
  lines.push(`- local_dual_baseline_ready: ${String(report.coverage.local_dual_baseline_ready)}`);
  lines.push('');

  if (asArray(report.notes).length) {
    lines.push('## Notes');
    lines.push('');
    for (const note of report.notes) lines.push(`- ${note}`);
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv);
  const cwd = process.cwd();
  const base = String(args.base || process.env.AURORA_BASE_URL || 'https://pivota-agent-production.up.railway.app').trim();
  const reportDir = path.resolve(String(args['report-dir'] || 'reports'));
  const reportPrefix = String(args['report-prefix'] || 'aurora_beauty_prompt_audit').trim();
  const legacyLocalPath = args['legacy-local'] ? path.resolve(String(args['legacy-local'])) : '';

  fs.mkdirSync(reportDir, { recursive: true });

  const onlineRun = runOnlineExtract({ cwd, base, reportDir });
  const onlineReportPath = onlineRun.reportPath;
  const onlineReport = safeJson(fs.readFileSync(onlineReportPath, 'utf8')) || {};
  const onlineSummary = extractOnlineSummary(onlineReport);

  const notes = [];
  let localSection = null;

  const localForceOn = runLocalPromptProbe({ cwd, forceGemini: true });
  const localForceOff = runLocalPromptProbe({ cwd, forceGemini: false });

  if (localForceOn.ok && localForceOff.ok) {
    const onJson = safeJson(localForceOn.stdout.trim());
    const offJson = safeJson(localForceOff.stdout.trim());
    localSection = {
      source: 'local_monkey_patch_probe',
      force_on: {
        status: onJson && onJson.ok ? 'ok' : 'parse_failed',
        reco_prompt: onJson && onJson.reco_prompt ? parsePromptMarkers(onJson.reco_prompt.preview || '') : null,
        alternatives_prompt: onJson && onJson.alt_prompt ? parsePromptMarkers(onJson.alt_prompt.preview || '') : null,
        captured_count: onJson ? Number(onJson.captured_count || 0) : 0,
      },
      force_off: {
        status: offJson && offJson.ok ? 'ok' : 'parse_failed',
        reco_prompt: offJson && offJson.reco_prompt ? parsePromptMarkers(offJson.reco_prompt.preview || '') : null,
        alternatives_prompt: offJson && offJson.alt_prompt ? parsePromptMarkers(offJson.alt_prompt.preview || '') : null,
        captured_count: offJson ? Number(offJson.captured_count || 0) : 0,
      },
    };
  } else {
    notes.push('local monkey-patch probe timed out/failed; fallback to existing local report');
    if (!localForceOn.ok) notes.push(`force-on probe error: ${localForceOn.error || localForceOn.stderr || 'unknown'}`);
    if (!localForceOff.ok) notes.push(`force-off probe error: ${localForceOff.error || localForceOff.stderr || 'unknown'}`);

    const fallbackPath =
      (legacyLocalPath && fs.existsSync(legacyLocalPath) && legacyLocalPath) ||
      (findLatestReport({ dir: reportDir, prefix: 'aurora_local_prompt_raw_' }) || {}).full ||
      (findLatestReport({ dir: reportDir, prefix: 'aurora_reco_prompt_extract_' }) || {}).full ||
      null;

    if (fallbackPath && fallbackPath.includes('aurora_local_prompt_raw_')) {
      const fallbackData = safeJson(fs.readFileSync(fallbackPath, 'utf8')) || {};
      localSection = extractLocalFromLegacyReport(fallbackData);
      localSection.source_report = fallbackPath;
    } else {
      localSection = {
        source: 'none',
        force_on: { status: 'missing', reco_prompt: null, alternatives_prompt: null, template_ids: [] },
        force_off: { status: 'missing', reco_prompt: null, alternatives_prompt: null, template_ids: [] },
      };
      if (fallbackPath) notes.push(`fallback file found but not local_prompt_raw schema: ${fallbackPath}`);
      else notes.push('no fallback local prompt report found');
    }
  }

  const templatesLower = onlineSummary.unique_templates.map((t) => String(t).toLowerCase());
  const coverage = {
    has_reco_main_template: templatesLower.some((t) => t.includes('reco_main')),
    has_reco_alternatives_template: templatesLower.some((t) => t.includes('reco_alternatives')),
    local_dual_baseline_ready: localSection.force_on.status === 'ok' && localSection.force_off.status === 'ok',
  };

  const report = {
    schema_version: 'aurora.beauty.prompt.audit.v1',
    generated_at: new Date().toISOString(),
    base,
    online: {
      report_path: onlineReportPath,
      summary: onlineSummary,
    },
    local: localSection,
    coverage,
    notes,
  };

  const stamp = nowStamp();
  const jsonPath = path.join(reportDir, `${reportPrefix}_${stamp}.json`);
  const mdPath = path.join(reportDir, `${reportPrefix}_${stamp}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(mdPath, buildMarkdown(report), 'utf8');

  process.stdout.write(`${JSON.stringify({ report_json: jsonPath, report_md: mdPath, coverage })}\n`);
}

main().catch((err) => {
  process.stderr.write(`[aurora_beauty_prompt_audit] fatal: ${String(err && err.stack ? err.stack : err)}\n`);
  process.exit(1);
});
