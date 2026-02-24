#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_DATASET = path.join(ROOT, 'datasets', 'routine_expert_multiturn_seed.json');
const DEFAULT_OUT_DIR = path.join(ROOT, 'reports', 'routine-expert-multiturn', 'runs');
const DEFAULT_BASE_URL = process.env.BASE_URL || 'https://pivota-agent-production.up.railway.app';
const DEFAULT_TIMEOUT_MS = Number(process.env.ROUTINE_MULTITURN_TIMEOUT_MS || 30000);
const DEFAULT_DELAY_MS = Number(process.env.ROUTINE_MULTITURN_DELAY_MS || 250);
const DEFAULT_CHAT_RETRIES = Number(process.env.ROUTINE_MULTITURN_CHAT_RETRIES || 1);
const DEFAULT_RETRY_BACKOFF_MS = Number(process.env.ROUTINE_MULTITURN_RETRY_BACKOFF_MS || 800);

const STALL_PATTERNS = [
  /please\s+retry/i,
  /retry\s+shortly/i,
  /i\s+need\s+a\s+diagnosis\s+result\s+first/i,
  /upload\s+(a\s+)?photo/i,
  /select\s+one\s+direction/i,
  /one\s+quick\s+(travel\s+)?detail\s+before\s+i\s+continue/i,
  /请重试/,
  /稍后重试/,
  /先上传照片/,
  /先给(我)?(目的地|日期)/,
  /先选方向/,
];

const PREGNANCY_USER_SIGNAL = /(怀孕|孕\s*\d+\s*周|pregnan|expecting|trimester)/i;
const PREGNANCY_ASK_SIGNAL = /(pregnancy\s+status|are\s+you\s+pregnant|确认是否怀孕|先确认.*怀孕|if\s+.*pregnan)/i;
const TRAVEL_USER_SIGNAL = /(出差|旅行|飞行|trip|travel|flight|weather|天气|气候|下周|next\s+week|weekend|哈尔滨|tokyo|san\s+francisco|colorado)/i;
const TRAVEL_ASK_SIGNAL = /(destination.*travel\s+dates|travel\s+dates|目的地\s*\+?\s*出行日期|请先告诉我目的地|请先告诉我出行日期)/i;
const CATALOG_POISON_SIGNAL = /(makeup\s+brush|blush\s+brush|foundation\s+brush|化妆刷|彩妆刷)/i;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'at', 'is', 'are', 'be', 'as', 'by',
  'this', 'that', 'it', 'its', 'from', 'your', 'you', 'we', 'our', 'can', 'should', 'will', 'then', 'than',
  'please', 'about', 'into', 'after', 'before', 'over', 'under', 'more', 'less', 'very', 'just', 'now',
  '用户', '需要', '建议', '然后', '可以', '应该', '当前', '继续', '进行', '一个', '这个', '那个', '问题', '方案',
]);

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function mkId(prefix, caseId) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${caseId}_${Date.now()}_${rand}`.slice(0, 120);
}

function safeJsonParse(text) {
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: false, data: null };
  }
}

function safeText(value) {
  return typeof value === 'string' ? value : '';
}

function cloneJsonSafe(value) {
  if (value == null) return value;
  if (typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function relativeToRoot(absPath) {
  const rel = path.relative(ROOT, absPath);
  return rel && !rel.startsWith('..') ? rel : absPath;
}

function sha256File(absPath) {
  const bytes = fs.readFileSync(absPath);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function extractAssistantMessage(response) {
  if (!response || typeof response !== 'object') return '';
  const msg = response.assistant_message;
  if (msg && typeof msg === 'object' && typeof msg.content === 'string') return msg.content;
  if (typeof response.answer === 'string') return response.answer;
  return '';
}

function extractCards(response) {
  return Array.isArray(response && response.cards) ? response.cards : [];
}

function stringifyCards(cards) {
  const rows = Array.isArray(cards) ? cards : [];
  const slices = [];
  for (const card of rows) {
    if (!card || typeof card !== 'object') continue;
    slices.push(String(card.type || ''));
    if (card.title) slices.push(String(card.title));
    if (card.text) slices.push(String(card.text));
    if (card.payload && typeof card.payload === 'object') slices.push(JSON.stringify(card.payload));
  }
  return slices.join(' ');
}

function tokenize(text) {
  const raw = String(text || '')
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
    .replace(/[^a-z0-9\u4e00-\u9fff_]+/g, ' ')
    .trim();
  if (!raw) return [];
  return raw
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

function overlapScore(expected, actual) {
  const expectedTokens = tokenize(expected);
  const actualSet = new Set(tokenize(actual));
  if (!expectedTokens.length) return { pass: true, hit: 0, need: 0 };
  let hit = 0;
  for (const token of expectedTokens) {
    if (actualSet.has(token)) hit += 1;
  }
  const need = Math.min(4, Math.max(1, Math.ceil(expectedTokens.length * 0.3)));
  return { pass: hit >= need, hit, need };
}

function hasAnyRegex(text, regexList) {
  const value = String(text || '');
  return (Array.isArray(regexList) ? regexList : []).some((re) => re && re.test && re.test(value));
}

const CLAUSE_SEMANTIC_RULES = [
  {
    clause: /(male|man|gender).*(simplicity|minimal|simple)/i,
    groups: [[/(男|male|man|beard|胡子)/i], [/(简|极简|minimal|simple)/i]],
  },
  {
    clause: /(oily).*(tight|peel|barrier|over-?cleansing)/i,
    groups: [[/(油|oily)/i], [/(紧绷|起皮|peel|屏障|barrier|过度清洁|over-?cleans)/i]],
  },
  {
    clause: /(2-step|two-step).*(gentle cleanse).*(hydration|moistur)/i,
    groups: [[/(2-step|two-step|两步)/i], [/(gentle cleanse|温和洁面)/i], [/(hydration|moistur|保湿)/i]],
  },
  {
    clause: /(stop.*scrub|scrub cleanser immediately)/i,
    groups: [[/(停用|立即停|stop)/i], [/(scrub|磨砂|颗粒|micro-?particles)/i]],
  },
  {
    clause: /(1-2 times|reduce cleansing)/i,
    groups: [[/(1-2|1\/2|一到两次|每天 1-2)/i]],
  },
  {
    clause: /(shaving|post-shave).*(centella|allantoin|soothing)/i,
    groups: [[/(shav|刮胡|剃须|beard|chin)/i], [/(centella|allantoin|soothing|舒缓|泛醇|panthenol)/i]],
  },
  {
    clause: /(full-face).*(2% BHA|barrier)/i,
    groups: [[/(2%.*(bha|水杨酸)|bha.*2%)/i], [/(full-face|全脸|屏障|barrier|高风险|risk)/i]],
  },
  {
    clause: /(chin).*(irritation|exacerbation)/i,
    groups: [[/(chin|下巴|下颌|beard)/i], [/(刺激|irrit|刺痛|泛红|red)/i]],
  },
  {
    clause: /(spot treatment|washing off|wash off)/i,
    groups: [[/(spot|局部|t区|nose|forehead)/i], [/(wash off|洗掉|冲洗|if irritation occurs|刺激时)/i]],
  },
  {
    clause: /(acute barrier damage|severe barrier)/i,
    groups: [[/(acute|急性|严重|severe)/i], [/(barrier|屏障)/i]],
  },
  {
    clause: /(immediate cessation).*(BHA).*(lower third|lower face)/i,
    groups: [[/(stop|halt|停用|暂停)/i], [/(bha|水杨酸)/i], [/(lower face|下半脸|下颌|beard|chin)/i]],
  },
  {
    clause: /(barrier repair cream|peeling area)/i,
    groups: [[/(repair cream|修护|ceramide|神经酰胺|凡士林|petrolatum)/i]],
  },
  {
    clause: /(goal shift).*(barrier health)/i,
    groups: [[/(优先|先把|priorit|goal shift|屏障)/i]],
  },
  {
    clause: /(phase 1).*(phase 2|reintroduction)/i,
    groups: [[/(phase 1|第 1|7 days|7天|recovery)/i], [/(phase 2|第 2|reintro|回归)/i]],
  },
  {
    clause: /(nose|forehead).*(avoid.*beard|beard area)/i,
    groups: [[/(nose|forehead|t区|鼻|额头)/i], [/(avoid|避开|beard|胡子区|下巴)/i]],
  },
  {
    clause: /(extreme weather).*(cold|dry|wind)/i,
    groups: [[/(cold|dry|wind|零下|寒冷|干燥|大风|harbin|哈尔滨|ski|snow)/i]],
  },
  {
    clause: /(heavier occlusive|ceramides|panthenol)/i,
    groups: [[/(occlusive|封闭|厚涂|ceramide|神经酰胺|panthenol|b5)/i]],
  },
  {
    clause: /(scarf|mask|windburn)/i,
    groups: [[/(scarf|mask|口罩|围巾|windburn|风吹)/i]],
  },
  {
    clause: /(retinol).*(gradual titration|jumping straight|0.3)/i,
    groups: [[/(retinol|a醇|维a)/i], [/(gradual|渐进|titration|不要直接|别直接|0.3)/i]],
  },
  {
    clause: /(other active ingredients|other actives)/i,
    groups: [[/(other active|其他活性|还在用什么)/i]],
  },
  {
    clause: /(retinol).*(BPO|benzoyl).*(conflict|irritation|degrade)/i,
    groups: [[/(retinol|a醇|维a)/i], [/(bpo|过氧化苯甲酰)/i], [/(冲突|conflict|degrade|刺激|irrit)/i]],
  },
  {
    clause: /(AM|PM).*(alternating nights|split usage)/i,
    groups: [[/(am|pm|早晚|隔天|alternating|split)/i]],
  },
  {
    clause: /(acute chemical burn|severe barrier damage)/i,
    groups: [[/(chemical burn|灼伤|急性|severe)/i], [/(barrier|屏障)/i]],
  },
  {
    clause: /(halt).*(BPO).*(Retinol)/i,
    groups: [[/(stop|halt|停用|暂停)/i], [/(bpo|过氧化苯甲酰)/i], [/(retinol|a醇|维a)/i]],
  },
  {
    clause: /(cool compress|sterile saline|petrolatum|ceramide)/i,
    groups: [[/(cool compress|冷敷|saline|生理盐水|petrolatum|凡士林|ceramide|神经酰胺)/i]],
  },
  {
    clause: /(pregnancy).*(OB-GYN|consult)/i,
    groups: [[/(pregnan|怀孕)/i], [/(ob-gyn|产科|咨询医生|consult)/i]],
  },
  {
    clause: /(ban all retinoids|retinoids)/i,
    groups: [[/(retinoid|retinol|维a|a醇)/i], [/(ban|禁用|停用|avoid)/i]],
  },
  {
    clause: /(pregnancy-safe).*(soothing|routine)/i,
    groups: [[/(pregnancy-safe|孕期安全|保守修护|soothing)/i]],
  },
  {
    clause: /(Azelaic Acid|10-15%)/i,
    groups: [[/(azelaic|壬二酸|10-15%|15%)/i]],
  },
  {
    clause: /(patch|patching|patch test).*(Azelaic|15%)/i,
    groups: [[/(patch|斑贴|局部试用)/i], [/(azelaic|壬二酸|15%)/i]],
  },
  {
    clause: /(sunscreen necessity|sunscreen)/i,
    groups: [[/(sunscreen|spf|防晒)/i]],
  },
  {
    clause: /(Vit C).*(AHA).*(AM|PM split)/i,
    groups: [[/(vit c|维c)/i], [/(aha|glycolic|果酸)/i], [/(am|pm|早晚)/i]],
  },
  {
    clause: /(missing moisturizer and SPF)/i,
    groups: [[/(moistur|保湿)/i], [/(spf|sunscreen|防晒)/i]],
  },
  {
    clause: /(UVA).*(windows|WFH)/i,
    groups: [[/(uva|window|窗|居家|wfh)/i]],
  },
  {
    clause: /(non-photosensitizing).*(Niacinamide|Alpha Arbutin)/i,
    groups: [[/(niacinamide|烟酰胺|arbutin|熊果苷|non-photosensitizing)/i]],
  },
  {
    clause: /(suspension).*(Glycolic).*(Vitamin C)/i,
    groups: [[/(stop|暂停|停用)/i], [/(glycolic|aha|果酸)/i], [/(vit c|维c)/i]],
  },
  {
    clause: /(cooling the skin|aloe|gel moisturizers)/i,
    groups: [[/(aloe|舒缓|gel|凝胶|cooling|降温)/i]],
  },
  {
    clause: /(chemical sunscreen).*(clear).*(stubble|facial hair)/i,
    groups: [[/(chemical|化学防晒|clear|透明|watery|gel)/i], [/(stubble|facial hair|胡茬|beard)/i]],
  },
  {
    clause: /(application amount|proper application)/i,
    groups: [[/(application amount|足量|两指|2 fingers|1\/4 tsp)/i]],
  },
  {
    clause: /(warmth and redness).*(fully subsided)/i,
    groups: [[/(warmth|redness|热感|泛红|是否完全消退|100%)/i]],
  },
  {
    clause: /(restart AHA slowly).*(2x a week)/i,
    groups: [[/(restart|重启|回归)/i], [/(2x|每周 2 次|twice a week)/i], [/(aha|glycolic|果酸)/i]],
  },
  {
    clause: /(wait).*(few more days).*(reintroducing actives)/i,
    groups: [[/(wait|再等|几天|3-5 天)/i], [/(reintroduc|回归活性|actives)/i]],
  },
  {
    clause: /(stacking 3 potent actives|dry\/sensitive|barrier impairment)/i,
    groups: [[/(stack|叠加|同晚)/i], [/(bha|lactic|retinol|三种活性)/i], [/(dry|sensitive|干敏|屏障)/i]],
  },
  {
    clause: /(cellular turnover overload|overload)/i,
    groups: [[/(turnover|overload|代谢过载|刺激过载)/i]],
  },
  {
    clause: /(skin cycling|dropping at least 2 actives)/i,
    groups: [[/(skin cycling|隔晚|停掉|drop|至少两种活性)/i]],
  },
  {
    clause: /(glow).*(inflammation|edema)/i,
    groups: [[/(glow|发亮|炎症|edema|水肿)/i]],
  },
  {
    clause: /(48-72).*(compromised barrier|delayed reaction)/i,
    groups: [[/(48-72|48|72)/i], [/(delayed|延迟反应|屏障受损|compromised barrier)/i]],
  },
  {
    clause: /(stop all actives).*(ceramides|cica|water only|gentle milk cleanser)/i,
    groups: [[/(stop all actives|停用所有活性)/i], [/(ceramide|神经酰胺|cica|gentle cleanser|温和洁面|water only)/i]],
  },
  {
    clause: /(recovery takes 2-4 weeks)/i,
    groups: [[/(2-4 weeks|2 到 4 周|两到四周)/i]],
  },
  {
    clause: /(cabin air|alpine climate|ski).*(broken barrier)/i,
    groups: [[/(cabin|flight|alpine|ski|高海拔|滑雪|干冷)/i], [/(barrier|屏障)/i]],
  },
  {
    clause: /(slugging|petrolatum|Vaseline|Aquaphor)/i,
    groups: [[/(slugging|petrolatum|凡士林|vaseline|aquaphor)/i]],
  },
  {
    clause: /(UV reflection on snow).*(mineral sunscreen)/i,
    groups: [[/(snow|雪地|反射|uv)/i], [/(mineral sunscreen|物理防晒|矿物防晒)/i]],
  },
  {
    clause: /(sheet masks).*(lack occlusion).*(dry alpine air)/i,
    groups: [[/(sheet mask|贴片面膜)/i], [/(occlusion|封闭|锁水)/i], [/(dry|alpine|干冷|高海拔)/i]],
  },
  {
    clause: /(ceramide cream).*(facial oil|squalane|rosehip)/i,
    groups: [[/(ceramide|神经酰胺)/i], [/(oil|squalane|rosehip|角鲨烷|油)/i]],
  },
  {
    clause: /(final travel routine).*(AM\/PM)/i,
    groups: [[/(travel routine|旅行方案|am|pm|早晚)/i]],
  },
  {
    clause: /(zero actives)/i,
    groups: [[/(zero actives|0 活性|停用活性|no actives)/i]],
  },
  {
    clause: /(gentle cleansing).*(heavy moisturization).*(oil mixing).*(mineral SPF)/i,
    groups: [[/(gentle cleansing|温和洁面)/i], [/(heavy moistur|厚保湿|rich cream)/i], [/(oil|混油|squalane)/i], [/(mineral spf|物理防晒|矿物防晒)/i]],
  },
];

function semanticClausePass(expectedClause, actualComposite) {
  const clause = String(expectedClause || '').trim();
  if (!clause) return true;
  const composite = String(actualComposite || '');
  for (const rule of CLAUSE_SEMANTIC_RULES) {
    if (!rule || !rule.clause || !rule.clause.test(clause)) continue;
    const groups = Array.isArray(rule.groups) ? rule.groups : [];
    if (!groups.length) return false;
    return groups.every((group) => hasAnyRegex(composite, group));
  }
  return false;
}

function findRoutineExpertFromCards(cards) {
  const rows = Array.isArray(cards) ? cards : [];
  for (const card of rows) {
    if (!card || typeof card !== 'object') continue;
    if (String(card.type || '').trim().toLowerCase() !== 'analysis_summary') continue;
    const payload = card.payload && typeof card.payload === 'object' && !Array.isArray(card.payload) ? card.payload : {};
    const analysis = payload.analysis && typeof payload.analysis === 'object' && !Array.isArray(payload.analysis)
      ? payload.analysis
      : {};
    const expert = analysis.routine_expert && typeof analysis.routine_expert === 'object' && !Array.isArray(analysis.routine_expert)
      ? analysis.routine_expert
      : null;
    if (expert) return expert;
  }
  return null;
}

function hasRoutineRequiredModules(cards) {
  const expert = findRoutineExpertFromCards(cards);
  if (!expert) return false;
  const hasSnapshot = expert.snapshot && typeof expert.snapshot === 'object' && !Array.isArray(expert.snapshot);
  const hasIssues = Array.isArray(expert.key_issues) && expert.key_issues.length > 0;
  const hasPhasePlan = expert.phase_plan && typeof expert.phase_plan === 'object' && !Array.isArray(expert.phase_plan);
  const hasPlan7d = expert.plan_7d && typeof expert.plan_7d === 'object' && !Array.isArray(expert.plan_7d);
  const hasPrimaryQuestion = typeof expert.primary_question === 'string' && expert.primary_question.trim().length > 0;
  return hasSnapshot && hasIssues && hasPhasePlan && hasPlan7d && hasPrimaryQuestion;
}

function detectStallHit(assistantText, cards) {
  const text = String(assistantText || '');
  const hasPattern = STALL_PATTERNS.some((re) => re.test(text));
  if (!hasPattern) return false;
  const rows = Array.isArray(cards) ? cards : [];
  if (rows.length === 0) return true;
  return !hasRoutineRequiredModules(rows);
}

function detectCatalogPoison(cards) {
  const rows = Array.isArray(cards) ? cards : [];
  for (const card of rows) {
    if (!card || typeof card !== 'object') continue;
    const type = String(card.type || '').trim().toLowerCase();
    if (type !== 'product_parse' && type !== 'offers_resolved') continue;
    const serialized = JSON.stringify(card.payload || card);
    if (CATALOG_POISON_SIGNAL.test(serialized)) return true;
  }
  return false;
}

function detectEntityMiss(userText, assistantText) {
  const u = String(userText || '');
  const a = String(assistantText || '');
  const reasons = [];
  if (PREGNANCY_USER_SIGNAL.test(u) && PREGNANCY_ASK_SIGNAL.test(a)) reasons.push('entity_miss_fail_pregnancy');
  if (TRAVEL_USER_SIGNAL.test(u) && TRAVEL_ASK_SIGNAL.test(a)) reasons.push('entity_miss_fail_travel');
  return reasons;
}

function evaluateTurnContract({ runTurn, datasetTurn, isFinalTurn, finalExpectations }) {
  const response = runTurn && typeof runTurn.response === 'object' ? runTurn.response : null;
  const cards = extractCards(response);
  const assistantText = extractAssistantMessage(response);
  const composite = `${assistantText}\n${stringifyCards(cards)}`;
  const expectedClauses = Array.isArray(datasetTurn && datasetTurn.expected_agent_contract)
    ? datasetTurn.expected_agent_contract
    : [];

  const clauseChecks = expectedClauses.map((clause) => {
    const score = overlapScore(clause, composite);
    const semanticPass = semanticClausePass(clause, composite);
    const pass = score.pass || semanticPass;
    return {
      clause,
      pass,
      hit: score.hit,
      need: score.need,
      lexical_pass: score.pass,
      semantic_pass: semanticPass,
      pass_source: score.pass ? 'lexical' : (semanticPass ? 'semantic' : 'none'),
    };
  });
  const clauseHitCount = clauseChecks.filter((row) => row.pass).length;
  const clauseTotal = clauseChecks.length;
  const minClausePass = clauseTotal === 0 ? 0 : Math.max(1, Math.ceil(clauseTotal * 0.6));
  const clausePass = clauseTotal === 0 ? true : clauseHitCount >= minClausePass;

  const stallHit = detectStallHit(assistantText, cards);
  const catalogPoison = detectCatalogPoison(cards);
  const entityMissReasons = detectEntityMiss(runTurn && runTurn.user, assistantText);

  const missingModules = [];
  if (isFinalTurn && finalExpectations && Array.isArray(finalExpectations.must_output_modules)) {
    const required = finalExpectations.must_output_modules;
    const expert = findRoutineExpertFromCards(cards);
    const hasExpert = Boolean(expert);
    for (const moduleName of required) {
      const key = String(moduleName || '').trim();
      if (!key) continue;
      if (!hasExpert) {
        missingModules.push(key);
        continue;
      }
      if (key === 'snapshot' && !(expert.snapshot && typeof expert.snapshot === 'object')) missingModules.push(key);
      if (key === 'key_issues' && !(Array.isArray(expert.key_issues) && expert.key_issues.length > 0)) missingModules.push(key);
      if (key === 'phase_plan' && !(expert.phase_plan && typeof expert.phase_plan === 'object')) missingModules.push(key);
      if (key === 'plan_7d' && !(expert.plan_7d && typeof expert.plan_7d === 'object')) missingModules.push(key);
      if (key === 'primary_question' && !(typeof expert.primary_question === 'string' && expert.primary_question.trim())) {
        missingModules.push(key);
      }
    }
  }

  const criticalFailReasons = [];
  if (stallHit) criticalFailReasons.push('stall_fail');
  if (catalogPoison) criticalFailReasons.push('catalog_poison_fail');
  for (const reason of entityMissReasons) criticalFailReasons.push(reason);
  if (missingModules.length > 0) criticalFailReasons.push('module_fail');

  const transportOk = Boolean(runTurn && runTurn.ok);
  const contractPass = transportOk && clausePass && criticalFailReasons.length === 0;

  return {
    transport_ok: transportOk,
    clause_total: clauseTotal,
    clause_hit_count: clauseHitCount,
    clause_min_pass: minClausePass,
    clause_hit_rate: clauseTotal > 0 ? Number((clauseHitCount / clauseTotal).toFixed(4)) : 1,
    clause_checks: clauseChecks,
    contract_pass: contractPass,
    stall_hit: stallHit,
    missing_modules: missingModules,
    critical_fail_reasons: Array.from(new Set(criticalFailReasons)),
  };
}

async function postJson({ baseUrl, route, headers, body, timeoutMs }) {
  const url = `${String(baseUrl || '').replace(/\/$/, '')}${route}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await resp.text();
    const parsed = safeJsonParse(raw);
    return {
      ok: resp.ok,
      status: resp.status,
      latency_ms: Date.now() - t0,
      body: parsed.ok ? parsed.data : raw,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      latency_ms: Date.now() - t0,
      error: err && err.name === 'AbortError' ? 'timeout' : String(err && err.message ? err.message : err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function loadDataset(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) throw new Error(`dataset not found: ${abs}`);
  const raw = fs.readFileSync(abs, 'utf8');
  const parsed = JSON.parse(raw);
  const cases = Array.isArray(parsed && parsed.cases) ? parsed.cases : [];
  if (!cases.length) throw new Error(`dataset has no cases: ${abs}`);
  return {
    abs,
    schema_version: String(parsed && parsed.schema_version ? parsed.schema_version : '').trim() || null,
    totals: parsed && parsed.totals ? parsed.totals : null,
    rubric_dimensions: Array.isArray(parsed && parsed.rubric_dimensions) ? parsed.rubric_dimensions : [],
    cases,
  };
}

function buildProfilePayload(caseItem) {
  const profile = caseItem && caseItem.seed_profile && typeof caseItem.seed_profile === 'object' ? caseItem.seed_profile : {};
  const goals = Array.isArray(profile.goals) ? profile.goals.map((x) => String(x || '').trim()).filter(Boolean) : [];
  return {
    skinType: String(profile.skinType || '').trim() || undefined,
    sensitivity: String(profile.sensitivity || '').trim() || undefined,
    barrierStatus: String(profile.barrierStatus || '').trim() || undefined,
    goals,
  };
}

async function runCase({
  caseItem,
  baseUrl,
  timeoutMs,
  delayMs,
  chatRetries,
  retryBackoffMs,
  uidPrefix,
  tracePrefix,
  briefPrefix,
}) {
  const caseId = String(caseItem && caseItem.id ? caseItem.id : '').trim();
  const language = String(caseItem && caseItem.language ? caseItem.language : 'EN').toUpperCase() === 'CN' ? 'CN' : 'EN';
  const uid = mkId(uidPrefix, caseId || 'case');
  const traceId = mkId(tracePrefix, caseId || 'case');
  const briefId = mkId(briefPrefix, caseId || 'case');
  let state = 'idle';

  const commonHeaders = {
    'X-Aurora-UID': uid,
    'X-Trace-ID': traceId,
    'X-Brief-ID': briefId,
    'X-Lang': language,
  };

  const profilePayload = buildProfilePayload(caseItem);
  const initResult = await postJson({
    baseUrl,
    route: '/v1/profile/update',
    headers: commonHeaders,
    body: profilePayload,
    timeoutMs,
  });

  const turns = Array.isArray(caseItem && caseItem.conversation) ? caseItem.conversation : [];
  const turnResults = [];
  let okTurns = 0;
  let contractPassTurns = 0;

  for (let idx = 0; idx < turns.length; idx += 1) {
    const t = turns[idx];
    const turnId = Number(t && t.turn_id);
    const user = String(t && t.user ? t.user : '').trim();
    if (!user) continue;
    const reqBody = {
      message: user,
      session: { state },
      language,
    };
    let result = null;
    let attempts = 0;
    while (attempts <= chatRetries) {
      attempts += 1;
      result = await postJson({
        baseUrl,
        route: '/v1/chat',
        headers: commonHeaders,
        body: reqBody,
        timeoutMs,
      });
      const shouldRetry =
        !result.ok &&
        attempts <= chatRetries &&
        (result.status >= 500 || result.status === 0 || String(result.error || '').toLowerCase() === 'timeout');
      if (!shouldRetry) break;
      if (retryBackoffMs > 0) await sleep(retryBackoffMs * attempts);
    }
    const finalResult = result || { ok: false, status: 0, latency_ms: 0, error: 'empty_result' };

    let nextState = state;
    let cardsCount = 0;
    if (finalResult.ok && finalResult.body && typeof finalResult.body === 'object') {
      const env = finalResult.body;
      cardsCount = Array.isArray(env.cards) ? env.cards.length : 0;
      const patch = env.session_patch && typeof env.session_patch === 'object' ? env.session_patch : null;
      if (patch && typeof patch.next_state === 'string' && patch.next_state.trim()) nextState = patch.next_state.trim();
      okTurns += 1;
    }

    const responseSnapshot = cloneJsonSafe(finalResult.body);
    const contract = evaluateTurnContract({
      runTurn: { ...finalResult, user, ok: finalResult.ok, response: responseSnapshot },
      datasetTurn: t,
      isFinalTurn: idx === turns.length - 1,
      finalExpectations: caseItem && caseItem.final_expectations ? caseItem.final_expectations : null,
    });
    if (contract.contract_pass) contractPassTurns += 1;

    turnResults.push({
      turn_id: Number.isFinite(turnId) ? turnId : null,
      user,
      request_state: state,
      response_state: nextState,
      attempts,
      status: finalResult.status,
      ok: finalResult.ok,
      latency_ms: finalResult.latency_ms,
      cards_count: cardsCount,
      error: finalResult.error || null,
      response: responseSnapshot,
      contract_pass: contract.contract_pass,
      stall_hit: contract.stall_hit,
      missing_modules: contract.missing_modules,
      critical_fail_reasons: contract.critical_fail_reasons,
      contract_clause_total: contract.clause_total,
      contract_clause_hit_count: contract.clause_hit_count,
      contract_clause_hit_rate: contract.clause_hit_rate,
      contract_clause_min_pass: contract.clause_min_pass,
      contract_clause_checks: contract.clause_checks,
    });
    state = nextState;
    if (delayMs > 0) await sleep(delayMs);
  }

  const turnCriticalReasons = new Set();
  let stallTurns = 0;
  let missingModulesTurns = 0;
  for (const turn of turnResults) {
    if (turn.stall_hit) stallTurns += 1;
    if (Array.isArray(turn.missing_modules) && turn.missing_modules.length > 0) missingModulesTurns += 1;
    for (const reason of Array.isArray(turn.critical_fail_reasons) ? turn.critical_fail_reasons : []) {
      turnCriticalReasons.add(String(reason || 'unknown'));
    }
  }

  const caseContractPass = turnResults.length > 0 && turnResults.every((row) => row && row.contract_pass === true);

  return {
    id: caseId,
    language,
    scenario_key: String(caseItem && caseItem.scenario_key ? caseItem.scenario_key : '').trim() || null,
    uid,
    trace_id: traceId,
    brief_id: briefId,
    profile_update: initResult,
    total_turns: turns.length,
    ok_turns: okTurns,
    contract_pass_turns: contractPassTurns,
    stall_turns: stallTurns,
    missing_modules_turns: missingModulesTurns,
    critical_fail_reasons: Array.from(turnCriticalReasons),
    case_contract_pass: caseContractPass,
    final_state: state,
    turns: turnResults,
  };
}

function summarize(caseResults) {
  const rows = Array.isArray(caseResults) ? caseResults : [];
  const caseCount = rows.length;
  const turnCount = rows.reduce((sum, row) => sum + Number(row && row.total_turns ? row.total_turns : 0), 0);
  const transportOkTurns = rows.reduce((sum, row) => sum + Number(row && row.ok_turns ? row.ok_turns : 0), 0);
  const contractPassTurns = rows.reduce((sum, row) => sum + Number(row && row.contract_pass_turns ? row.contract_pass_turns : 0), 0);
  const stallTurns = rows.reduce((sum, row) => sum + Number(row && row.stall_turns ? row.stall_turns : 0), 0);
  const missingModulesTurns = rows.reduce((sum, row) => sum + Number(row && row.missing_modules_turns ? row.missing_modules_turns : 0), 0);
  const profileOk = rows.filter((row) => row && row.profile_update && row.profile_update.ok).length;

  const failedCaseIds = rows
    .filter((row) => Number(row && row.ok_turns ? row.ok_turns : 0) < Number(row && row.total_turns ? row.total_turns : 0))
    .map((row) => row.id);

  const criticalFailCaseIds = rows
    .filter((row) => Array.isArray(row && row.critical_fail_reasons) && row.critical_fail_reasons.length > 0)
    .map((row) => row.id);

  const latencies = [];
  for (const row of rows) {
    for (const t of Array.isArray(row && row.turns) ? row.turns : []) {
      if (Number.isFinite(Number(t && t.latency_ms))) latencies.push(Number(t.latency_ms));
    }
  }
  const avgLatency = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;

  return {
    case_count: caseCount,
    turns_total: turnCount,
    turns_ok: transportOkTurns,
    turn_success_rate: turnCount > 0 ? transportOkTurns / turnCount : 0,
    transport_success_rate: turnCount > 0 ? transportOkTurns / turnCount : 0,
    contract_pass_turns: contractPassTurns,
    contract_pass_rate: turnCount > 0 ? contractPassTurns / turnCount : 0,
    stall_turns: stallTurns,
    stall_rate: turnCount > 0 ? stallTurns / turnCount : 0,
    missing_modules_turns: missingModulesTurns,
    missing_modules_rate: turnCount > 0 ? missingModulesTurns / turnCount : 0,
    critical_fail_rate: turnCount > 0 ? (rows.reduce((sum, row) => {
      const turns = Array.isArray(row && row.turns) ? row.turns : [];
      return sum + turns.filter((t) => Array.isArray(t && t.critical_fail_reasons) && t.critical_fail_reasons.length > 0).length;
    }, 0) / turnCount) : 0,
    profile_update_success_rate: caseCount > 0 ? profileOk / caseCount : 0,
    avg_turn_latency_ms: Number(avgLatency.toFixed(2)),
    failed_case_ids: failedCaseIds,
    critical_fail_case_ids: criticalFailCaseIds,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const datasetPath = args.dataset || DEFAULT_DATASET;
  const baseUrl = String(args['base-url'] || DEFAULT_BASE_URL).trim();
  const outDir = path.resolve(args['out-dir'] || DEFAULT_OUT_DIR);
  const timeoutMs = Number(args['timeout-ms'] || DEFAULT_TIMEOUT_MS);
  const delayMs = Number(args['delay-ms'] || DEFAULT_DELAY_MS);
  const chatRetriesRaw = Number(args['chat-retries'] || DEFAULT_CHAT_RETRIES);
  const chatRetries = Number.isFinite(chatRetriesRaw) && chatRetriesRaw >= 0 ? Math.trunc(chatRetriesRaw) : 0;
  const retryBackoffRaw = Number(args['retry-backoff-ms'] || DEFAULT_RETRY_BACKOFF_MS);
  const retryBackoffMs = Number.isFinite(retryBackoffRaw) && retryBackoffRaw >= 0 ? Math.trunc(retryBackoffRaw) : 0;
  const maxCasesRaw = Number(args['max-cases'] || 0);
  const maxCases = Number.isFinite(maxCasesRaw) && maxCasesRaw > 0 ? Math.trunc(maxCasesRaw) : null;
  const uidPrefix = String(args['uid-prefix'] || 'routine_mt').trim();
  const tracePrefix = String(args['trace-prefix'] || 'routine_mt_trace').trim();
  const briefPrefix = String(args['brief-prefix'] || 'routine_mt_brief').trim();

  const dataset = loadDataset(datasetPath);
  const datasetSha256 = sha256File(dataset.abs);
  const selectedCases = maxCases ? dataset.cases.slice(0, maxCases) : dataset.cases.slice();
  const startedAt = nowIso();

  console.log(`[multiturn-run] dataset=${dataset.abs}`);
  console.log(`[multiturn-run] schema=${dataset.schema_version || 'unknown'}`);
  console.log(`[multiturn-run] base_url=${baseUrl}`);
  console.log(`[multiturn-run] cases=${selectedCases.length}`);
  console.log(`[multiturn-run] timeout_ms=${timeoutMs} delay_ms=${delayMs} chat_retries=${chatRetries} retry_backoff_ms=${retryBackoffMs}`);

  const caseResults = [];
  for (const c of selectedCases) {
    const caseId = String(c && c.id ? c.id : '').trim() || 'unknown_case';
    console.log(`[multiturn-run] case_start=${caseId}`);
    const result = await runCase({
      caseItem: c,
      baseUrl,
      timeoutMs,
      delayMs,
      chatRetries,
      retryBackoffMs,
      uidPrefix,
      tracePrefix,
      briefPrefix,
    });
    caseResults.push(result);
    console.log(
      `[multiturn-run] case_done=${caseId} transport=${result.ok_turns}/${result.total_turns} contract=${result.contract_pass_turns}/${result.total_turns}`,
    );
  }

  const summary = summarize(caseResults);
  const endedAt = nowIso();
  const payload = {
    schema_version: 'routine_expert_multiturn_run.v2',
    compat: { v1_fields_present: true },
    started_at: startedAt,
    ended_at: endedAt,
    dataset: dataset.abs,
    dataset_relative: relativeToRoot(dataset.abs),
    dataset_sha256: datasetSha256,
    dataset_schema_version: dataset.schema_version,
    base_url: baseUrl,
    timeout_ms: timeoutMs,
    delay_ms: delayMs,
    summary,
    rubric_dimensions: dataset.rubric_dimensions,
    cases: caseResults,
  };

  fs.mkdirSync(outDir, { recursive: true });
  const stamp = endedAt.replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_').replace('Z', '');
  const outPath = path.join(outDir, `multiturn-run-${stamp}.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  console.log(`[multiturn-run] report=${outPath}`);
  console.log(
    `[multiturn-run] transport_ok=${summary.turns_ok}/${summary.turns_total} contract_pass_rate=${summary.contract_pass_rate.toFixed(4)} stall_rate=${summary.stall_rate.toFixed(4)}`,
  );
  if (summary.failed_case_ids.length) {
    console.log(`[multiturn-run] failed_case_ids=${summary.failed_case_ids.join(',')}`);
  }
  if (summary.critical_fail_case_ids.length) {
    console.log(`[multiturn-run] critical_fail_case_ids=${summary.critical_fail_case_ids.join(',')}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[multiturn-run] fatal=${err && err.message ? err.message : err}`);
    process.exit(1);
  });
}

module.exports = {
  __internal: {
    tokenize,
    overlapScore,
    evaluateTurnContract,
    hasRoutineRequiredModules,
    detectStallHit,
    detectCatalogPoison,
    detectEntityMiss,
    summarize,
    relativeToRoot,
    sha256File,
  },
};
