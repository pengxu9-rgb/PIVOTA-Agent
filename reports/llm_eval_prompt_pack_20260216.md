# Aurora Chatbox × Pivota Agent  
## 多 LLM 评估与优化 Prompt Pack（高细节版）

> 生成日期：2026-02-16  
> 用途：把“现有回复模版 + 格式 + 上下文能力 + 实际样本”完整提供给多个 LLM，让它们输出可落地优化方案。

---

## 0) 使用方式（建议）

1. 先把 **第 1 部分《共享事实上下文》** 作为 system/context 发给每个 LLM。  
2. 再按目标选择 **第 3/4/5/6 部分的专项 prompt**。  
3. 所有 LLM 都要求按同一输出结构返回（第 7 部分）。  
4. 统一打分后做交叉对比，选“高可执行 + 低改造风险”的方案进实施。

---

## 1) 共享事实上下文（复制给所有 LLM）

你现在是一个“对话产品 + 后端编排 + 前端渲染约束”联合优化顾问。  
请基于以下**已确认的真实现状**输出方案，不能忽略任何硬约束。

### 1.1 系统目标

- 业务目标：让用户在 Aurora Chatbox 内完成“诊断 → 解释 → 推荐 → 选购/跳转 → 复盘”的闭环体验。
- 现阶段重点：  
  1) 主链路速度已修复；  
  2) 要继续提升“诊断回复质量 + 功能答疑准确率 + 用户问题闭环率”；  
  3) 不希望依赖固定写死的 `product_id + merchant_id`。

### 1.2 后端统一响应协议（硬约束）

所有 `/v1/*` 返回统一 envelope：

```json
{
  "request_id": "string",
  "trace_id": "string",
  "assistant_message": { "role": "assistant", "content": "string", "format": "text|markdown" } | null,
  "suggested_chips": [{ "chip_id": "string", "label": "string", "kind": "quick_reply|action", "data": {} }],
  "cards": [{ "card_id": "string", "type": "string", "payload": {}, "field_missing": [{ "field": "string", "reason": "string" }] }],
  "session_patch": {},
  "events": []
}
```

`field_missing` 是强约束：缺字段不能编造，必须显式标记 reason。

### 1.3 已确认路由能力（后端）

- Auth：`/v1/auth/start|verify|password/login|password/set|me|logout`
- 会话与画像：`/v1/session/bootstrap`, `/v1/profile/update`, `/v1/profile/delete`
- 聊天：`/v1/chat`
- 产品与分析：`/v1/product/parse`, `/v1/product/analyze`, `/v1/analysis/skin`
- 冲突与流程：`/v1/routine/simulate`, `/v1/dupe/suggest`, `/v1/dupe/compare`
- 推荐与交易：`/v1/reco/generate`, `/v1/offers/resolve`, `/v1/affiliate/outcome`
- 记录：`/v1/tracker/log`, `/v1/tracker/recent`
- 运维：`/v1/ops/pdp-prefetch/state`, `/v1/ops/pdp-prefetch/run`

### 1.4 前端状态机与显示约束（硬约束）

- 状态机包含：`IDLE_CHAT, DIAG_*, ROUTINE_*, PRODUCT_LINK_EVAL, RECO_*, ...`
- `recommendations` 卡片只有在 `RECO_GATE|RECO_CONSTRAINTS|RECO_RESULTS` 才允许显示（前端会过滤）。
- UI 默认隐藏卡：`gate_notice`, `budget_gate`, `session_bootstrap`（除 debug）。
- `session_patch.profile` 会被前端持续合并，作为后续会话上下文输入。

### 1.5 当前卡片主类型（需要考虑）

- 诊断/流程：`diagnosis_gate`, `analysis_summary`, `profile`, `session_bootstrap`
- 场景/冲突：`env_stress`, `routine_simulation`, `conflict_heatmap`
- 商品/推荐：`product_parse`, `product_analysis`, `recommendations`, `offers_resolved`, `affiliate_outcome`
- 其它：`dupe_suggest`, `dupe_compare`, `photo_confirm`, `photo_modules_v1`, `aurora_structured`, `aurora_debug`

### 1.6 当前上下文能力（要在方案中利用）

- 通过 `X-Aurora-UID` 维持用户长期画像与 tracker log。
- `session.profile`（前端快照）+ `bootstrap.profile` 双来源合并。
- `pending_clarification` 支持多轮追问与恢复（`flow_id`, `step_index`, `current`, `queue`, `history`）。
- 可发送 `requested_transition`（`chip|action|text_explicit`）控制状态流转。
- 支持 `anchor_product_id`、`hints.aliases`、`product_ref` 来增强产品对齐。

### 1.7 当前生产环境关键开关（2026-02-16 观测）

- `AURORA_CHAT_CLARIFICATION_FLOW_V2=true`
- `AURORA_CHAT_RESUME_PREFIX_V1=true`
- `AURORA_CHAT_RESUME_PREFIX_V2=true`
- `AURORA_BFF_RECO_CATALOG_TRANSIENT_FALLBACK=false`
- `AURORA_BFF_RECO_CATALOG_GROUNDED=false`
- `AURORA_CHAT_CATALOG_AVAIL_FAST_PATH=true`
- `AURORA_BFF_RECO_PDP_RESOLVE_ENABLED=false`

### 1.8 现存“固定映射”相关事实（必须处理）

- `productGroundingResolver` 内存在 `KNOWN_STABLE_PRODUCT_REFS`（示例包含 Winona/IPSA/The Ordinary 的固定 `product_id + merchant_id` 别名映射）。
- PDP hotset prewarm 默认也包含 Winona/IPSA 的固定 product_ref（用于性能预热）。
- 前端发起 `/agent/v1/products/resolve` 时显式 `allow_external_seed: false`。

> 目标倾向：弱化/关闭“写死商品锚点”带来的偏置，改为更通用的动态 grounding。

### 1.9 当前回复风格特征（可见模板）

- 常带情绪化前缀（按时段中英模板，如“下午好，辛苦啦，我们把重点快速理清。”）。
- 诊断类常是“先问 3~4 个关键信息”。
- 推荐类常含结构段落：目标与前提 / 最小可行清单 / 成分方向 / 引入计划 / 红旗信号。
- 天气类会给 `env_stress` 卡 + markdown 要点列表。
- 无图分析会强提示“仅基于问卷历史，不输出照片结论”。

---

## 2) 真实回复样本（复制给 LLM 做“基线行为理解”）

> 注意：以下来自生产真实返回，已做必要裁剪。

### Case A：推荐前门控（无画像）

用户意图：`给我产品推荐`

```json
{
  "assistant_message": {
    "format": "text",
    "content": "我可以帮你，但我需要先做一个极简肤况确认...1）肤质 2）敏感程度 3）屏障状态 4）目标"
  },
  "cards": [
    {
      "type": "diagnosis_gate",
      "payload": {
        "reason": "diagnosis_first",
        "missing_fields": ["skinType", "barrierStatus", "sensitivity", "goals"],
        "wants": "recommendation"
      }
    }
  ],
  "suggested_chips_count": 17,
  "session_patch": { "next_state": "S2_DIAGNOSIS" }
}
```

### Case B：品牌有货查询 fast-path

用户意图：`薇诺娜有货吗`

```json
{
  "assistant_message": {
    "format": "text",
    "content": "当前没能拉到「薇诺娜」商品列表。你想查官方旗舰/自营，还是具体单品名？"
  },
  "cards": [
    {
      "type": "product_parse",
      "payload": {
        "intent": "availability",
        "brand_id": "brand_winona",
        "product.product_id": "brand:brand_winona"
      }
    },
    {
      "type": "offers_resolved",
      "payload": {
        "items[0].offer": null,
        "items[0].pdp_open.path": "external"
      }
    }
  ]
}
```

### Case C：天气场景问答

用户意图：`下雪天怎么护肤`

```json
{
  "assistant_message": { "format": "markdown", "content": "雪天风险 + 分点建议 + 产品品类建议" },
  "cards": [
    {
      "type": "env_stress",
      "payload": {
        "schema_version": "aurora.ui.env_stress.v1",
        "ess": 53,
        "tier": "Medium",
        "radar": [{ "axis": "Barrier", "value": 40 }, { "axis": "Weather", "value": 70 }]
      }
    }
  ],
  "suggested_chips": ["生成 AM/PM 护肤流程", "推荐防护产品"]
}
```

### Case D：画像齐全后拿推荐

用户意图：`chip_get_recos`（画像已补齐）

```json
{
  "assistant_message": { "format": "text", "content": "目标与前提...最小可行清单...成分方向..." },
  "cards": [
    {
      "type": "recommendations",
      "payload": {
        "recommendations_count": 5,
        "first_item.sku.brand": "Paula's Choice",
        "first_item.pdp_open.path": "external",
        "confidence": 0.72
      }
    },
    { "type": "aurora_debug" }
  ],
  "session_patch": { "next_state": "S7_PRODUCT_RECO" }
}
```

### Case E：无照片分析降级

用户意图：`分析皮肤`（无有效图）

```json
{
  "cards": [
    {
      "type": "analysis_summary",
      "payload": {
        "low_confidence": true,
        "photos_provided": false,
        "used_photos": false,
        "analysis_source": "baseline_low_confidence",
        "quality_report.photo_quality.grade": "unknown"
      }
    }
  ],
  "session_patch": { "next_state": "S5_ANALYSIS_SUMMARY" }
}
```

### Case F：clarification pending 流（V2）

Step 1：

```json
{
  "session_patch.state.pending_clarification": {
    "v": 1,
    "flow_id": "pc_xxx",
    "step_index": 0,
    "current": { "id": "skin_type", "norm_id": "skinType" },
    "queue": [{ "id": "barrier_status" }, { "id": "goals" }],
    "history": []
  }
}
```

Step 2：

```json
{
  "session_patch.state.pending_clarification.step_index": 1,
  "session_patch.profile.skinType": "oily"
}
```

结束：

```json
{
  "session_patch.state.pending_clarification": null,
  "session_patch.profile.goals": ["dark_spots"]
}
```

---

## 3) Prompt A（总方案架构优化）

把下面整段发给 LLM：

```text
你是“对话系统总架构 + 诊断/推荐业务专家”。
我给你的是 Aurora Chatbox × Pivota Agent 现网真实约束（含协议、状态机、卡片、样本）。

目标：
1) 让系统在“皮肤诊断 + 护肤答疑 + 商品推荐”上明显优于普通通用聊天LLM；
2) 降低误导、重复追问、空洞回答、状态错乱；
3) 弱化对固定 product_id+merchant_id 的依赖，增强动态产品 grounding 的鲁棒性；
4) 输出可落地到现有代码结构（Node BFF + React Chatbox）的方案。

请输出：
1. 现状问题树（按严重级别P0/P1/P2，必须引用我给的事实）
2. 目标系统蓝图（意图路由、状态转移、上下文读写、回复生成、卡片生成、异常降级）
3. 核心策略：
   - 诊断问答策略（最小问询 + 不重复 + 证据闭环）
   - 答疑策略（FAQ/场景问答要“先结论后依据后行动”）
   - 推荐策略（仅在 gate 通过后，且给出可解释理由 + 证据 + 下一步）
4. 去固定锚点策略（stable alias mapping / prewarm 默认商品）：
   - 关闭或降级路径
   - 替代机制（动态检索、可信度阈值、失败回退）
   - 风险与监控
5. 分阶段实施计划（1周/2周/4周），每阶段包含：
   - 改动点
   - 依赖
   - 风险
   - 验收指标

输出要严格结构化，且每条建议都要对应“现有约束是否兼容”。
```

---

## 4) Prompt B（回复模板与格式体系重构）

```text
你是“对话内容设计 + 工程可执行模板系统”专家。
请基于现有 Aurora envelope/card 协议设计一套“可程序化落地”的回复模板体系。

输入事实：
- assistant_message 支持 text|markdown
- cards 是前端主渲染对象；某些卡片会被状态机过滤
- 现有回复有明显模板痕迹（情绪前缀 + 长段落）
- 我们希望回复更精准、更短、更有任务推进性

请输出：
1) 模板总规范（全局）：
   - 语气
   - 长度上限
   - 段落顺序
   - 何时必须给 chips / 何时不能给 chips
2) 按模块给模板（每类至少给“标准版 + 降级版”）：
   - 诊断追问（diagnosis_gate / pending_clarification）
   - 场景问答（weather/env_stress）
   - 产品评估（product_parse / product_analysis）
   - 推荐输出（recommendations）
   - 无图降级（analysis_summary used_photos=false）
3) 每个模板必须给：
   - 触发条件
   - assistant_message 示例（中英文）
   - 建议 cards 组合
   - session_patch 预期
   - field_missing 填写规则
4) 输出“模板参数字典”（可直接供工程落地）：
   - 参数名
   - 类型
   - 必填/选填
   - 默认值
5) 输出“反模板清单”（禁止出现）：
   - 重复开场白
   - 与卡片重复叙述
   - 无行动指令的空泛解释

要求：方案必须兼容当前前后端协议，不可假设大规模重写。
```

---

## 5) Prompt C（诊断回复与答疑精确化）

```text
你是“医疗非诊断场景下的高精度护肤顾问对话设计师（非医疗建议）”。
目标是把 Aurora 的诊断回复和答疑能力做成“更可靠、更可执行、更少误导”。

请完成：
1. 定义“高质量诊断回复”的判定标准（至少10条，可量化）
2. 定义“高质量答疑回复”的判定标准（至少10条，可量化）
3. 设计一套诊断问答策略：
   - 最少问题拿到足够信息
   - 如何避免重复问 skinType/sensitivity/barrier/goals
   - 如何在 pending_clarification 里进行增量追问与恢复
4. 设计一套答疑策略：
   - 用户问“有没有某品牌/某成分/某风险”时的标准答法
   - “结论-依据-可执行动作-边界说明”模板
5. 设计失败与降级策略：
   - 无图、低置信、上游超时、卡片缺字段
   - 每种情况如何明确告知且保持可行动
6. 给出 12 组“坏例子→好例子”对照（中英文混合）
7. 给出一份可直接接入自动评测的评分 rubric（JSON）
```

---

## 6) Prompt D（实验设计与指标）

```text
你是对话系统实验科学家。请为 Aurora 设计“模板与策略优化”的A/B评估框架。

约束：
- 现有系统有 cards + envelope + state machine
- 线上已在跑真实流量
- 我们要优先评估：诊断质量、答疑有效性、推荐可信度、任务完成率

请输出：
1) 指标体系（主指标/护栏指标/反指标）
2) 日志埋点建议（按 request_id/trace_id/state/card_type）
3) 最小可运行实验方案（2周）
4) 离线评测集构建方案（需要哪些样本字段）
5) 在线回滚规则（触发阈值）
6) 风险清单（误导、过度推荐、状态错转、卡片空洞）
```

---

## 7) 统一要求 LLM 的输出格式（强制）

让每个 LLM 严格返回以下结构：

```json
{
  "problem_tree": [
    {
      "id": "PT1",
      "symptom": "A/B判定阶段高比例both_bad拦截，导致无可用结果",
      "root_causes": [
        "third-gate把软失败与硬失败混合拦截",
        "score阈值与当前数据分布不匹配",
        "winner_not_clean规则过于激进"
      ],
      "impact": "无法进入人工复核与线上放量，召回几乎为0"
    },
    {
      "id": "PT2",
      "symptom": "框漂移问题未被稳定识别",
      "root_causes": [
        "评估侧过度依赖单轮LLM文本决策",
        "缺乏hard-signal优先级与规则分层",
        "缺少对高风险样本的二次复核闭环"
      ],
      "impact": "用户可见质量波动，人工复核负担高"
    },
    {
      "id": "PT3",
      "symptom": "模型升级收益不稳定",
      "root_causes": [
        "未定义challenger模式与统一打分协议",
        "不同模型输出未标准化对齐",
        "缺少离线回放与阈值校准流程"
      ],
      "impact": "换模型成本高且风险不可控"
    }
  ],
  "target_architecture": {
    "gate_layers": [
      {
        "name": "L1-PrimaryQC",
        "purpose": "快速质量判断",
        "default_model": "gemini-2.5-flash"
      },
      {
        "name": "L2-EscalationQC",
        "purpose": "低置信/高风险样本复核",
        "default_model": "gemini-2.5-pro",
        "trigger": "confidence低于阈值 或 risk_reasons命中"
      },
      {
        "name": "L3-DecisionGate",
        "purpose": "A/B最终判定",
        "policy": "consumer模式仅拦截hard-failure，soft-failure降级为weak_preference"
      }
    ],
    "hard_failure_definition": [
      "critical_violation（cross/multi_face/another person）",
      "A/B双reject",
      "A/B双侧极低分"
    ],
    "output_contract": [
      "decision_class in {a_win,b_win,both_bad}",
      "blocked_before_manual仅由hard-failure触发",
      "输出both_bad_triggered/hard_failure_signals用于审计"
    ]
  },
  "template_system": {
    "ab_label_policy_modes": [
      {
        "mode": "qa",
        "rule": "保守策略，soft和hard均可进入both_bad"
      },
      {
        "mode": "consumer",
        "rule": "仅hard-failure拦截；soft-failure强制weak_preference放行"
      }
    ],
    "review_reports": [
      "review_all_with_images.html",
      "review_manual_with_images.html",
      "review_blocked_with_images.html"
    ]
  },
  "state_and_context_policy": {
    "required_context_fields": [
      "sample_hash",
      "source",
      "side",
      "decision",
      "confidence",
      "corrected_modules_count",
      "mean_delta_l1",
      "violations",
      "risk_reasons"
    ],
    "escalation_rules": {
      "min_confidence": 0.78,
      "min_risk_reasons": 1,
      "on_decisions": [
        "revise",
        "reject"
      ],
      "if_error": true
    },
    "auditability": [
      "保留primary/secondary decision",
      "记录escalation_applied与selected_secondary",
      "summary.json保留decision_policy和counts"
    ]
  },
  "de_fixed_anchor_plan": {
    "objective": "去固定锚点，转向候选集排序+风险约束",
    "phases": [
      {
        "phase": "Phase1",
        "scope": "先稳定门控与A/B输出，不改推荐主干",
        "success_metric": "blocked_total比例下降且人工抽检通过率不降"
      },
      {
        "phase": "Phase2",
        "scope": "接入开源模型作为challenger reranker",
        "success_metric": "同成本下bad-case率继续下降"
      },
      {
        "phase": "Phase3",
        "scope": "将challenger胜出策略灰度到线上",
        "success_metric": "线上任务完成率与满意度提升"
      }
    ]
  },
  "ab_experiment_plan": {
    "offline_replay": {
      "dataset": "最近7-14天高风险样本+人工复核错例",
      "primary_metrics": [
        "both_bad_rate",
        "hard_block_precision",
        "a_or_b_select_rate"
      ],
      "guardrail_metrics": [
        "severe_misalignment_rate",
        "manual_overload_rate"
      ]
    },
    "online_rollout": {
      "stages": [
        "1% shadow",
        "5% gated",
        "20% gradual",
        "50%+ after guardrail pass"
      ],
      "rollback_triggers": [
        "severe_misalignment_rate超过基线+20%",
        "hard_block_precision低于目标阈值",
        "consumer投诉率异常上升"
      ]
    }
  },
  "implementation_backlog": [
    {
      "priority": "P0",
      "task": "在ab_label实现decision_mode+hard_block_only真实策略，soft both_bad降级放行",
      "owner": "backend",
      "eta_days": 1
    },
    {
      "priority": "P0",
      "task": "triple_gate透传decision_mode/hard_block_only并默认consumer",
      "owner": "backend",
      "eta_days": 1
    },
    {
      "priority": "P0",
      "task": "构建hard-failure标注审计看板（blocked样本可视化）",
      "owner": "data",
      "eta_days": 2
    },
    {
      "priority": "P1",
      "task": "接入gemini-2.5-pro作为升级复核默认二道门",
      "owner": "prompt",
      "eta_days": 2
    },
    {
      "priority": "P1",
      "task": "引入开源模型challenger（仅离线打分，不直接拦截）",
      "owner": "backend",
      "eta_days": 4
    },
    {
      "priority": "P1",
      "task": "统一模型输出schema，建立跨模型阈值校准脚本",
      "owner": "data",
      "eta_days": 3
    },
    {
      "priority": "P2",
      "task": "将challenger策略纳入线上灰度A/B并自动回滚",
      "owner": "backend",
      "eta_days": 5
    }
  ],
  "risks": [
    "soft-failure放行后可能引入轻度质量回退",
    "不同数据源(internal/lapa/celebamaskhq)分布差异导致阈值漂移",
    "模型成本上升（2.5-pro升级链路）影响吞吐",
    "开源模型接入初期输出不稳定增加调参复杂度"
  ],
  "open_questions": [
    "hard-failure目标precision阈值定为多少（建议>=0.9）",
    "consumer模式是否允许weak_preference直接落地，还是先进入轻量人工抽检",
    "开源challenger首选模型是按精度优先还是成本优先",
    "线上灰度阶段的最小可接受回滚窗口（小时级/天级）"
  ],
  "human_readable_summary": "先不等待全部开源模型集成，先把third-gate从“全拦截”重构为“硬失败拦截、软失败放行”，恢复可用召回；并把gemini-2.5-pro作为稳定的二道复核。开源模型以challenger形式并行接入，先离线回放再灰度上线，避免直接替换造成生产风险。"
}
```

并补充一版“人类可读摘要”（不超过 800 字）。

---

## 8) 给评审人的注意事项

- 若方案违反以下任一项，直接降级：  
  1) 忽略 envelope/card/state 约束；  
  2) 继续依赖固定商品锚点且无风险隔离；  
  3) 只谈原则不落到工程动作；  
  4) 没有可量化验收指标。  
- 优先选择“改造成本低 + 回报快 + 可回滚”的方案。

---

## 9) Aurora 模板系统（兼容协议）实施规范（2026-02-16）

> 状态：已形成“规范真源 + 代码入口 + 验证矩阵 + 灰度回滚”完整包。  
> 协议约束：不改 envelope 字段结构；仅增强已有字段值与填充规则。

### 9.1 规范真源（template_system）

```json
{
  "template_system": {
    "global_spec": {
      "compatibility": {
        "envelope_protocol": "compatible",
        "front_end_state_filter": "compatible",
        "cards_primary_render": "compatible"
      },
      "tone": "专业、克制、任务导向",
      "length_limits": {
        "assistant_message_text_max_chars": 280,
        "assistant_message_markdown_max_chars": 520,
        "assistant_message_text_max_sentences": 5,
        "assistant_message_markdown_max_bullets": 6
      },
      "paragraph_order": [
        "一句结论/当前能做什么",
        "一句依据/限制",
        "一句下一步动作"
      ],
      "chips_policy": {
        "must_provide_when": [
          "pending_clarification.current exists",
          "need user choice to continue",
          "recommendation result needs next-step action chips"
        ],
        "must_not_provide_when": [
          "SAFETY_TRIAGE active",
          "pure informational explanation with no decision required"
        ],
        "max_chips": 10,
        "preferred_range": [4, 8],
        "priority_order": [
          "advance_current_step",
          "narrow_scope",
          "next_action",
          "low_priority_extension"
        ]
      },
      "field_missing_reason_enum": [
        "not_provided_by_user",
        "parse_failed",
        "needs_disambiguation",
        "catalog_not_available",
        "feature_flag_disabled",
        "low_confidence",
        "frontend_disallows_external_seed",
        "upstream_timeout"
      ],
      "anti_template_rules": [
        "duplicate_prefix",
        "card_duplicate_env",
        "card_duplicate_recommendations",
        "missing_action"
      ]
    },
    "module_templates": {
      "diagnosis_clarification": ["standard", "degraded"],
      "env_weather_qa": ["standard", "degraded"],
      "product_evaluation": ["standard", "degraded"],
      "recommendations_output": ["standard", "degraded"],
      "no_photo_analysis_degrade": ["standard", "degraded"]
    },
    "default_assumptions": {
      "lang": "zh-CN",
      "message_format": "text",
      "chips_max": 10,
      "enforcement": "warn_only",
      "recommendations_visible_states": ["RECO_GATE", "RECO_CONSTRAINTS", "RECO_RESULTS"],
      "external_seed_dependency": false,
      "pdp_resolve_dependency": false
    }
  }
}
```

### 9.2 实现映射（规则 -> 代码入口）

| 规则/能力 | 代码入口 | 说明 |
|---|---|---|
| 模板选择 `selectTemplate(context)` | `src/auroraBff/templateSystem.js` | 基于 cards/state/pending_clarification 选择模块与标准/降级版本 |
| 文案渲染 `renderAssistantMessage(decision, context)` | `src/auroraBff/templateSystem.js` | 保留“非泛化已有文案”，仅在泛化/缺失场景替换为模板文案 |
| chips 兼容适配 `adaptChips(...)` | `src/auroraBff/templateSystem.js` + `src/auroraBff/routes.js` | canonical/existing chips 统一为旧前端可消费结构，并按优先级裁剪 |
| 出口规范化（state/chips/field_missing） | `src/auroraBff/envelope.js` | `normalizeNextState` + `FieldMissingEnforcer` + `chips<=10` |
| 反模板与行动性校验（warn-only） | `src/auroraBff/templateSystem.js` + `src/auroraBff/envelope.js` | `validateTemplateOutput` 只记指标，不阻断响应 |
| 推荐 gate 单步推进 + pending_clarification | `src/auroraBff/gating.js` + `src/auroraBff/routes.js` | 当前只问一个问题，支持 `current.norm_id` 与增量恢复 |
| 后端续跑 internal state 优先 | `src/auroraBff/memoryStore.js` | `resolveNextStateFromSessionPatch` 优先 `state._internal_next_state` |
| 模板监控指标 | `src/auroraBff/visionMetrics.js` | applied/fallback、chips截断、field_missing补齐、反模板违规、actionable rate |

### 9.3 验证矩阵（最小必测 12 项）

| # | 场景 | 断言 |
|---|---|---|
| 1 | diagnosis_gate / pending_clarification 标准版 | 每轮只追问 1 个问题；quick_reply chips；chips<=6 |
| 2 | diagnosis 连续 unknown 降级 | 不编造 profile；history 保留 unknown；可继续追问 |
| 3 | 天气标准版 | 有 `env_stress` 卡；正文不重复 ESS/tier/radar 细节 |
| 4 | 天气降级版 | 无 `env_stress` 时明确“当前数据不可得”，仍给下一步 |
| 5 | 产品评估标准版 | `product_parse` / `product_analysis` 联动；可按目标 chips 继续 |
| 6 | 产品评估降级版 | 缺 `payload.product_ref` 必写 `field_missing` + parse_failed/needs_disambiguation |
| 7 | 推荐标准版 | 仅 `RECO_RESULTS` 输出 `recommendations`，含下一步 action chips |
| 8 | 推荐降级版 | HardRequired 不齐留在 `RECO_GATE/RECO_CONSTRAINTS`，不伪造 recommendations |
| 9 | 无图降级标准版 | `analysis_summary.used_photos=false` 时明确低置信 + 可执行动作 |
| 10 | 反模板规则 | 无重复前缀；无结构化字段复述；非纯知识回复必须可行动 |
| 11 | 全局预算 | `assistant_message` 长度限制生效；`suggested_chips<=10` |
| 12 | 全局缺字段 | 关键缺失都可在 card 上看到 `field_missing.reason` 且 reason 在枚举内 |

### 9.4 灰度与回滚

- 默认策略：`warn-only`（仅记录 `ValidationReport` + metrics，不阻断响应）。
- 灰度阶段：
  1. `Stage A`（0%替换）：旁路验证模板选择与校验覆盖率。
  2. `Stage B`（10%）：启用模板渲染与 chips 适配。
  3. `Stage C`（全量）：保留严格模式开关，按监控阈值观察。
- 回滚机制：关闭模板相关开关后回退到原有文案路径；协议无迁移。

### 9.5 指标定义（Prometheus）

- `template_applied_total` + `template_applied_rate`
- `template_fallback_total` + `template_fallback_rate`
- `chips_truncated_count`
- `field_missing_added_count`
- `anti_template_violation_count`
- `actionable_reply_total` + `actionable_reply_rate`

### 9.6 本轮实现默认值（锁定）

- 默认语言：`zh-CN`，可按会话切 `en-US`。
- 默认格式：`text`；行动清单/风险提示可用 `markdown`。
- 默认 chips 上限：`10`。
- 默认 enforcement：`warn_only`。
- 推荐可见约束：`recommendations` 仅在 `RECO_*`。
- 依赖约束：不依赖 `external_seed`，不依赖 PDP resolve。

