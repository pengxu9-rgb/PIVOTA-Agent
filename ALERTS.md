# Aurora Skin Analysis — Alerts

目标：基于**现有日志/metrics**，定义一组可落地的告警规则（阈值可配置），覆盖：
- `5xx_rate` / `timeout_rate`
- `llm_timeout_rate`
- `llm_calls_per_request`
- `quality_fail_rate` / `degraded_rate`
- `geometry_sanitizer_drop_rate`
- `retake_rate_proxy`

> 说明：本服务当前以 **JSON 日志**为主（pino），并额外输出少量 `kind:"metric"` 的指标日志。推荐在观测平台（Datadog / Grafana Loki / ELK 等）里做 “logs → metrics” 映射后再配置告警；如暂时只看日志，也可用相同过滤条件做告警。

---

## 1) 信号来源（你可以据此做 logs→metrics）

### A. HTTP 请求日志（全局）
位置：`src/server.js` 的 request logging middleware  
字段：
- `method`, `path`, `status`, `duration_ms`

用途：
- `5xx_rate`：`status` 为 5xx 的占比
- `timeout_rate`：`status` 为 408/504 的占比（或自定义 `duration_ms` 超时预算）

### B. 皮肤分析 profiling 日志（/v1/analysis/skin）
位置：`src/auroraBff/routes.js`  
过滤：
- `kind="skin_analysis_profile"`（**排除** `skin_analysis_profile_shadow`）

关键字段：
- `pipeline_version`：`legacy|v2|...`
- `analysis_source`：`retake|vision_openai|aurora_text|rule_based|...`
- `photo_quality_grade`：`pass|degraded|fail|unknown`
- `llm_summary.calls / llm_summary.timeouts / llm_summary.failed`
- `total_ms`

用途：
- `llm_calls_per_request`
- `llm_timeout_rate`
- `quality_fail_rate` / `degraded_rate`
- `retake_rate_proxy`

### C. 指标日志（kind=metric）
位置：`src/auroraBff/routes.js`  
过滤：`kind="metric"`

目前已输出：
- `name="aurora.skin_analysis.total_ms"`（仅非 shadow）
- `name="aurora.skin_analysis.<pipeline>.total_ms"`

用途：
- 皮肤分析整体延迟分位数（若你的平台支持 distribution/percentile）

---

## 2) 建议的 logs→metrics 映射（命名可按你们规范调整）

如果你的平台支持从日志生成指标，建议最少生成这些（均不含图片/人脸数据）：

### HTTP
- `pivota_http_requests_total{path,status_class}`：从 HTTP 请求日志计数
- `pivota_http_timeouts_total{path}`：`status in (408,504)` 的计数

### Skin analysis
- `aurora_skin_analysis_requests_total{pipeline_version,analysis_source,photo_quality_grade}`：`kind="skin_analysis_profile"` 计数
- `aurora_skin_analysis_llm_calls_total{pipeline_version}`：对 `llm_summary.calls` 做求和（或用每条日志的 `llm_summary.calls` 作为 value 型指标再求和）
- `aurora_skin_analysis_llm_timeouts_total{pipeline_version}`：对 `llm_summary.timeouts` 求和
- `aurora_skin_analysis_total_ms{pipeline_version}`：来自 `kind:"metric"` 的 `name="aurora.skin_analysis.total_ms"` / `aurora.skin_analysis.<pipeline>.total_ms`（建议做成 distribution 以支持 p95/p99）

### Geometry sanitizer（待接入）
- `aurora_skin_analysis_geometry_sanitizer_checked_total`
- `aurora_skin_analysis_geometry_sanitizer_drops_total`

> 现状：仓库内暂未看到稳定的 “geometry sanitizer drop” 指标输出；当 sanitizer 落地后，请在后处理阶段补充上述两个计数器或等价指标。

---

## 3) 告警规则（PromQL-ish 表达式，可映射到各平台）

下列阈值请在告警平台用变量/环境配置注入（示例变量名仅供参考）：
- `ALERT_5XX_RATE_WARN` / `ALERT_5XX_RATE_CRIT`
- `ALERT_TIMEOUT_RATE_WARN` / `ALERT_TIMEOUT_RATE_CRIT`
- `ALERT_LLM_TIMEOUT_RATE_WARN` / `ALERT_LLM_TIMEOUT_RATE_CRIT`
- `ALERT_LLM_CALLS_PER_REQ_WARN` / `ALERT_LLM_CALLS_PER_REQ_CRIT`
- `ALERT_QUALITY_FAIL_RATE_WARN` / `ALERT_QUALITY_FAIL_RATE_CRIT`
- `ALERT_QUALITY_DEGRADED_RATE_WARN` / `ALERT_QUALITY_DEGRADED_RATE_CRIT`
- `ALERT_GEOMETRY_DROP_RATE_WARN` / `ALERT_GEOMETRY_DROP_RATE_CRIT`
- `ALERT_RETAKE_RATE_WARN` / `ALERT_RETAKE_RATE_CRIT`

并建议加最小流量门槛避免低流量误报：
- `min_rps`（例如 0.2 rps / 1 rps）

### A-001 HTTP 5xx rate（全局/按 path）
**表达式（全局）**
```text
5xx_rate =
  sum(rate(pivota_http_requests_total{status_class="5xx"}[5m]))
  /
  clamp_min(sum(rate(pivota_http_requests_total[5m])), 1)
```
**告警**
```text
5xx_rate > ALERT_5XX_RATE_CRIT for 5m
5xx_rate > ALERT_5XX_RATE_WARN for 10m
```
**建议默认值（起步）**
- warn: 0.5%
- crit: 2%

### A-002 HTTP timeout rate（408/504 或超时预算）
**表达式（按 status）**
```text
timeout_rate =
  sum(rate(pivota_http_timeouts_total[5m]))
  /
  clamp_min(sum(rate(pivota_http_requests_total[5m])), 1)
```
**告警**
```text
timeout_rate > ALERT_TIMEOUT_RATE_CRIT for 5m
timeout_rate > ALERT_TIMEOUT_RATE_WARN for 10m
```
**建议默认值（起步）**
- warn: 0.2%
- crit: 1%

> 可选：如果你们更关心 “超过预算的慢请求”，可另建 `slow_rate = duration_ms > BUDGET_MS` 的派生指标并告警。

### A-003 LLM timeout rate（仅 skin analysis）
**定义：LLM 调用中超时的占比**
```text
llm_timeout_rate =
  sum(rate(aurora_skin_analysis_llm_timeouts_total[10m]))
  /
  clamp_min(sum(rate(aurora_skin_analysis_llm_calls_total[10m])), 1)
```
**告警**
```text
llm_timeout_rate > ALERT_LLM_TIMEOUT_RATE_CRIT for 10m
llm_timeout_rate > ALERT_LLM_TIMEOUT_RATE_WARN for 20m
```
**建议默认值（起步）**
- warn: 3%
- crit: 10%

### A-004 LLM calls per request（策略回归哨兵）
**定义：每请求平均 LLM 调用数**
```text
llm_calls_per_request =
  sum(rate(aurora_skin_analysis_llm_calls_total[10m]))
  /
  clamp_min(sum(rate(aurora_skin_analysis_requests_total[10m])), 1)
```
**告警**
```text
llm_calls_per_request > ALERT_LLM_CALLS_PER_REQ_CRIT for 20m
llm_calls_per_request > ALERT_LLM_CALLS_PER_REQ_WARN for 40m
```
**建议默认值（起步）**
- warn: 1.2
- crit: 1.6

> 解释：正常情况下应尽量 0~1 次（策略生效时）。持续升高通常意味着 should_call_llm 退化/误触发。

### A-005 Photo quality fail / degraded rate（输入质量与 QC 健康度）
**fail_rate**
```text
quality_fail_rate =
  sum(rate(aurora_skin_analysis_requests_total{photo_quality_grade="fail"}[30m]))
  /
  clamp_min(sum(rate(aurora_skin_analysis_requests_total[30m])), 1)
```
**degraded_rate**
```text
quality_degraded_rate =
  sum(rate(aurora_skin_analysis_requests_total{photo_quality_grade="degraded"}[30m]))
  /
  clamp_min(sum(rate(aurora_skin_analysis_requests_total[30m])), 1)
```
**告警**
```text
quality_fail_rate > ALERT_QUALITY_FAIL_RATE_CRIT for 30m
quality_fail_rate > ALERT_QUALITY_FAIL_RATE_WARN for 60m

quality_degraded_rate > ALERT_QUALITY_DEGRADED_RATE_CRIT for 30m
quality_degraded_rate > ALERT_QUALITY_DEGRADED_RATE_WARN for 60m
```
**建议默认值（起步）**
- fail_rate warn/crit：20% / 35%
- degraded_rate warn/crit：50% / 70%

> 备注：fail/degraded 偏高不一定是 bug（可能是用户输入质量问题），但应与 `retake_rate_proxy`、`LLM calls`、以及转化漏斗联动观察。

### A-006 Geometry sanitizer drop rate（待接入）
```text
geometry_sanitizer_drop_rate =
  sum(rate(aurora_skin_analysis_geometry_sanitizer_drops_total[30m]))
  /
  clamp_min(sum(rate(aurora_skin_analysis_geometry_sanitizer_checked_total[30m])), 1)
```
**建议默认值（起步）**
- warn: 1%
- crit: 5%

### A-007 Retake rate proxy（“请重拍”触发占比）
优先建议用 `analysis_source="retake"`：
```text
retake_rate_proxy =
  sum(rate(aurora_skin_analysis_requests_total{analysis_source="retake"}[30m]))
  /
  clamp_min(sum(rate(aurora_skin_analysis_requests_total[30m])), 1)
```
备选（如果 analysis_source 没有被采集）：用 `photo_quality_grade="fail"` 近似。

**建议默认值（起步）**
- warn: 20%
- crit: 35%

---

## 4) 排查 Runbook（最短路径）

当告警触发时，建议按顺序排查：

1. **先看 HTTP 层**：`5xx_rate` / `timeout_rate` 是否先升高；按 `path` 切分确认是否集中在 `/v1/analysis/skin`。
2. **看 LLM 健康度**：`llm_timeout_rate` 是否升高；若是，优先检查上游（OpenAI/Aurora decision）连通性与限流。
3. **看策略回归**：`llm_calls_per_request` 是否异常升高（should_call_llm 误触发）；对照近期发布/feature flag。
4. **看输入质量**：`quality_fail_rate` / `retake_rate_proxy` 是否升高；若是，检查前端引导/QC（上传前压缩/过曝/低照）。
5. **如有 geometry drop**：检查 sanitizer 阈值、ROI 对齐、ref_frame 是否一致；必要时临时提高 drop 阈值避免误伤（同时降置信度）。
