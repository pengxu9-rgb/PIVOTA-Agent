# Aurora Skin Analysis — Dashboard

Canonical importable dashboard JSON now lives in:

- `monitoring/dashboards/aurora_diagnosis_overview.grafana.json`

This file remains a query reference; operational dashboards should import the JSON above.

目标：给出推荐的 dashboard 面板清单与查询语句（覆盖必需指标），帮助快速定位：
- 服务是否健康（5xx / timeout / latency）
- LLM 是否“该用才用”（calls/request、timeout）
- 低质量图是否“保守不乱猜”（quality fail/degraded、retake proxy）
- 几何约束是否稳定（geometry sanitizer drop，若已接入）

> 本文以 “PromQL-ish” 形式描述查询表达式；你可以把它翻译到 Datadog / Grafana / ELK / Loki。  
> 具体 logs→metrics 的推荐映射见 `ALERTS.md`。

---

## 1) Dashboard 变量（建议）

- `env`：`prod|staging`（如有）
- `path`：默认 `/v1/analysis/skin`
- `pipeline_version`：`legacy|v2|*`
- `shadow_run`：默认排除 shadow（`shadow_run=false`）

---

## 2) 面板清单（含查询语句）

### P-001 RPS（请求速率）
用于判断流量基线与告警抖动。
```text
rps = sum(rate(pivota_http_requests_total{path="$path"}[5m]))
```

### P-002 5xx rate
```text
5xx_rate =
  sum(rate(pivota_http_requests_total{path="$path",status_class="5xx"}[5m]))
  /
  clamp_min(sum(rate(pivota_http_requests_total{path="$path"}[5m])), 1)
```

### P-003 timeout rate（408/504）
```text
timeout_rate =
  sum(rate(pivota_http_timeouts_total{path="$path"}[5m]))
  /
  clamp_min(sum(rate(pivota_http_requests_total{path="$path"}[5m])), 1)
```

### P-004 HTTP latency（p50 / p95）
如果你们有 histogram（或平台支持 distribution），建议展示 `p50/p95`。示例（histogram 形态）：
```text
p95_http_ms =
  histogram_quantile(0.95,
    sum(rate(pivota_http_request_duration_ms_bucket{path="$path"}[5m])) by (le)
  )
```
> 若目前只有 `duration_ms` 日志字段：建议在平台侧把它做成 histogram/distribution 再画分位数。

---

## 3) Skin analysis（/v1/analysis/skin 专用）

> 这些指标来自 `kind="skin_analysis_profile"`（排除 shadow），以及少量 `kind:"metric"` 指标日志。

### P-101 Skin analysis total latency（p50 / p95）
来自 `kind:"metric"` 日志：
- `name="aurora.skin_analysis.total_ms"`（非 shadow）
- `name="aurora.skin_analysis.<pipeline>.total_ms"`

如你们将其映射为 distribution 指标 `aurora_skin_analysis_total_ms{pipeline_version}`：
```text
p95_skin_total_ms = p95(aurora_skin_analysis_total_ms)
```
或直接按 pipeline 拆分：
```text
p95_skin_total_ms_by_pipeline = p95(aurora_skin_analysis_total_ms{pipeline_version="$pipeline_version"})
```

### P-102 LLM calls per request（avg + p95）
```text
llm_calls_per_request =
  sum(rate(aurora_skin_analysis_llm_calls_total{pipeline_version="$pipeline_version"}[10m]))
  /
  clamp_min(sum(rate(aurora_skin_analysis_requests_total{pipeline_version="$pipeline_version"}[10m])), 1)
```
> 建议再加一个 “calls 分布” 面板（0/1/2+）用于看策略是否误触发（取决于平台能否做分桶）。

### P-103 LLM timeout rate
```text
llm_timeout_rate =
  sum(rate(aurora_skin_analysis_llm_timeouts_total{pipeline_version="$pipeline_version"}[10m]))
  /
  clamp_min(sum(rate(aurora_skin_analysis_llm_calls_total{pipeline_version="$pipeline_version"}[10m])), 1)
```

### P-104 Photo quality grade 分布（pass/degraded/fail）
```text
quality_grade_rps =
  sum(rate(aurora_skin_analysis_requests_total{photo_quality_grade=~"pass|degraded|fail"}[30m])) by (photo_quality_grade)
```

### P-105 quality_fail_rate / degraded_rate（占比）
```text
quality_fail_rate =
  sum(rate(aurora_skin_analysis_requests_total{photo_quality_grade="fail"}[30m]))
  /
  clamp_min(sum(rate(aurora_skin_analysis_requests_total[30m])), 1)

quality_degraded_rate =
  sum(rate(aurora_skin_analysis_requests_total{photo_quality_grade="degraded"}[30m]))
  /
  clamp_min(sum(rate(aurora_skin_analysis_requests_total[30m])), 1)
```

### P-106 retake_rate_proxy（分析源为 retake 的占比）
```text
retake_rate_proxy =
  sum(rate(aurora_skin_analysis_requests_total{analysis_source="retake"}[30m]))
  /
  clamp_min(sum(rate(aurora_skin_analysis_requests_total[30m])), 1)
```
> 如果你们暂未采集 `analysis_source`：可临时用 `photo_quality_grade="fail"` 近似。

### P-107 analysis_source top-N（解释“为什么没跑 LLM / 为什么返回基线”）
```text
analysis_source_rps =
  topk(8, sum(rate(aurora_skin_analysis_requests_total[30m])) by (analysis_source))
```

### P-108 verify_budget_guard_count_15m（shadow verifier 容量护栏）
```text
verify_budget_guard_count_15m = increase(verify_budget_guard_total[15m])
```

---

## 4) Geometry（已接入）

### P-201 geometry_sanitizer_drop_rate
```text
geometry_sanitizer_drop_rate =
  sum(rate(geometry_sanitizer_drop_total[30m]))
  /
  clamp_min(sum(rate(analyze_requests_total[30m])), 1)
```
建议同时展示绝对量（drops/min）：
```text
geometry_drops_rps = sum(rate(geometry_sanitizer_drop_total[30m]))
```

---

## 5) 推荐布局（从上到下）

1. **Service health**：P-001 ~ P-004
2. **Skin analysis core**：P-101 ~ P-103
3. **Input quality & retake**：P-104 ~ P-106
4. **Explainability**：P-107（analysis_source）+ P-108（verify guard）
5. **Geometry stability**：P-201

---

## 6) Photo Modules KPI（运营最小集）

> 目标：监控 `photo_modules_v1` 是否被看到、是否有交互、是否驱动后续动作。

### P-301 `photo_modules_viewed / skin_analysis_viewed`

```text
photo_modules_view_rate =
  sum(rate(aurora_ui_events_total{event_name="aurora_photo_modules_viewed"}[30m]))
  /
  clamp_min(sum(rate(aurora_ui_events_total{event_name="skin_analysis_viewed"}[30m])), 1)
```

### P-302 module_click_rate

```text
module_click_rate =
  sum(rate(aurora_ui_events_total{event_name="aurora_photo_modules_module_tap"}[30m]))
  /
  clamp_min(sum(rate(aurora_ui_events_total{event_name="aurora_photo_modules_viewed"}[30m])), 1)
```

### P-303 action_click_rate

```text
action_click_rate =
  sum(rate(aurora_ui_events_total{event_name="aurora_photo_modules_action_tap"}[30m]))
  /
  clamp_min(sum(rate(aurora_ui_events_total{event_name="aurora_photo_modules_viewed"}[30m])), 1)
```

### P-304 retake_rate_after_modules

```text
retake_rate_after_modules =
  sum(rate(aurora_ui_events_total{event_name="photo_retry_clicked",from_card="photo_modules_v1"}[30m]))
  /
  clamp_min(sum(rate(aurora_ui_events_total{event_name="aurora_photo_modules_viewed"}[30m])), 1)
```

备注：

- 若当前尚未发 `aurora_photo_modules_viewed` 或 `from_card` 标签，先保留查询并在事件侧补充字段。
- `retake_rate_after_modules` 也可暂时用漏斗近似：`photo_retry_clicked` 在 `photo_modules_viewed` 会话后的比例。
