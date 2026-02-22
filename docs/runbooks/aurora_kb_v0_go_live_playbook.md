# Aurora KB v0 生产全量上线执行指令清单（Oncall Playbook）

## Oncall 超短执行版（可直接贴值班群）

- 目标 SHA:
- Railway deploy time:
- 合成用例 request IDs / trace IDs:
- Grafana 快照链接:

- Railway(prod) env: `AURORA_KB_V0_DISABLE=0`、`AURORA_KB_FAIL_MODE=closed`（`open` 仅应急）
- Deploy 最新 main/目标 SHA，确认服务 `Healthy`
- 跑 6 条合成验收（全通过才继续）:
- `preg unknown + retinoid -> REQUIRE_INFO(pregnancy_status)`
- `pregnant + retinoid -> BLOCK`（`rule_id=kb_v0:*`，无推荐）
- `isotretinoin + (AHA/BHA/BPO/RETINOID) -> BLOCK`（`decision_source=kb_v0`，`triggered_by` 含 `medications`）
- `age unknown + strong actives/procedure -> REQUIRE_INFO(age_band)`
- `infant/toddler + fragrance/essential_oil -> BLOCK`
- `travel intent + no destination -> source=climate_fallback + raw.climate_profile + archetype_selected_by`
- 观测 15 分钟:
- Grafana: `monitoring/dashboards/aurora_kb_v0_overview.grafana.json`
- Alerts: `monitoring/alerts/aurora_kb_v0_rules.yml`
- `aurora_kb_v0_loader_error_total` 不增长（红线：增长即回滚）
- legacy fallback ratio 不触发 page（`>5% for 10m`）
- `climate_fallback` 仅 travel 用例触发
- 失败/红线回滚:
- 首选: `AURORA_KB_V0_DISABLE=1`（全回 legacy）
- 临时止血: `AURORA_KB_FAIL_MODE=open`（仅应急）
- 详细步骤: `docs/runbooks/aurora_kb_v0_go_live_playbook.md`（主入口：`docs/runbooks/aurora_kb_v0.md`）

## 0) 前置确认（上线前 5 分钟）

1. 确认目标变更和 commit
- PR: `chore(aurora-bff): production readiness for KB v0 rollout`
- 记录 main/head commit SHA 到工单。

2. 确认 Railway Production 环境变量
- `AURORA_KB_V0_DISABLE=0`
- `AURORA_KB_FAIL_MODE=closed`
- 同步确认 `DATABASE_URL` 与外部依赖已就绪。

说明:
- `AURORA_KB_FAIL_MODE=open` 仅应急临时使用，不作为常态。

## 1) 部署执行（Railway）

1. Railway Production Service 部署最新 main（或指定 commit）。
2. 等待 deploy 完成，确认服务状态 `Healthy/Running`。
3. 如启动失败:
- 优先检查日志是否为 KB loader fail-closed。
- 先确认 KB 文件/manifest 部署正确，不要默认切 `open`。

## 2) 上线后合成 6 条用例（必做）

目标: 在无真实用户下覆盖 safety gate、climate fallback、决策路径稳定性。

执行要求:
- 每条用例记录请求 ID 与关键返回字段（如 `block_level`、`required_fields`、`decision_source`、`triggered_by`、`source`）。

用例 1: pregnancy unknown + retinoid
- 输入: 提到 `retinol/tretinoin/维A/视黄醇`，不声明是否怀孕。
- 期望:
- `block_level=REQUIRE_INFO`
- `required_fields` 包含 `pregnancy_status`

用例 2: pregnant + retinoid
- 输入: 明确 `pregnant/怀孕/孕期` + 任一 retinoid。
- 期望:
- `block_level=BLOCK`
- `matched_rules` 中存在 `kb_v0:*`
- 不出现带 recommendation 的安全违例路径（保持 `safety_with_recommendations=0`）

用例 3: isotretinoin + AHA/BHA/BPO/RETINOID
- 输入: `isotretinoin/异维A酸/泰尔丝` + 任一强活性。
- 期望:
- `block_level=BLOCK`
- `decision_source=kb_v0`
- `triggered_by` 包含 `medications`

用例 4: age unknown + strong actives/procedure
- 输入: 不给年龄，提到 `peel/换肤/激光/微针/水杨酸/过氧化苯甲酰` 等。
- 期望:
- `block_level=REQUIRE_INFO`
- `required_fields` 包含 `age_band`

用例 5: infant/toddler + fragrance/essential_oil
- 输入: `infant/toddler/婴儿/幼儿` + `fragrance/香精/精油`。
- 期望:
- `block_level=BLOCK`
- 命中 `kb_v0:*` 规则

用例 6: travel intent + destination missing
- 输入: 旅行意图但不提供目的地。
- 期望:
- 返回 `source=climate_fallback`
- 存在 `raw.climate_profile`
- `raw.climate_profile.archetype_selected_by` 为 `user_locale|month|default` 之一

失败处理:
- 任一用例失败，直接执行第 5 节回滚。

## 3) 部署后 15 分钟观测（必做）

监控入口:
- Dashboard: `monitoring/dashboards/aurora_kb_v0_overview.grafana.json`
- Alerts: `monitoring/alerts/aurora_kb_v0_rules.yml`

必查指标:
1. `aurora_kb_v0_loader_error_total`
- 期望: 不增长
- 增长: 高优先级处理

2. `aurora_kb_v0_rule_match_total`
- 期望: 合成流量后有增长/有 rate
- 若持续为 0: 排查流量路径或 metrics 抓取

3. `aurora_kb_v0_legacy_fallback_total` 与 ratio
- 期望: 0 或低值
- ratio > 5% 持续 10m: 触发回滚策略

4. `aurora_kb_v0_climate_fallback_total`
- 期望: 仅 travel + destination missing 用例触发增长
- 非预期增长: 排查 weather/geocode/destination parse

建议同步确认:
- Page 级告警不触发:
- `AuroraKbV0LoaderErrorDetected`
- `AuroraKbV0LegacyFallbackRatioHigh`

## 4) 成功标准（宣布上线完成）

需同时满足:
- 合成 6 条用例全部通过
- 15 分钟内 `aurora_kb_v0_loader_error_total` 不增长
- 无 page 级告警触发
- 服务健康，无异常 5xx

可附加基线指标:
- `http_5xx=0`
- `schema_violations=0`
- `validator_errors=0`
- `safety_with_recommendations=0`

## 5) 回滚策略（红线触发立即执行）

红线条件（任一）:
- `aurora_kb_v0_loader_error_total` 增长
- fallback ratio 告警触发（>5% for 10m）
- 合成 6 条用例任一失败
- 服务不可用或连续 5xx

回滚动作:
1. 快速回到 legacy（首选）
```bash
AURORA_KB_V0_DISABLE=1
```
- 应用配置并重启/重部署，确认功能恢复。

2. 临时 fail-open（只用于应急止血）
```bash
AURORA_KB_FAIL_MODE=open
```
- 仅临时使用，故障修复后恢复 `closed`。

3. 故障修复后恢复稳态
```bash
AURORA_KB_V0_DISABLE=0
AURORA_KB_FAIL_MODE=closed
```
- 重新执行“合成 6 条 + 15 分钟观测”。

## 6) 事件记录模板

- 上线时间:
- 部署 commit SHA:
- 环境变量确认结果:
- 合成用例结果（6 条逐条）:
- 15 分钟观测截图/链接:
- 告警触发情况:
- 是否回滚（原因/动作/恢复时间）:

## 7) 直接可用命令（建议）

本地校验:
```bash
npm run test:aurora-bff:unit
make monitoring-validate
bash scripts/kb_v0_synthetic_checks.sh
```

说明:
- `kb_v0_synthetic_checks.sh` 是离线策略核验入口（直接调用现有 safety/weather 模块，不依赖线上 token）。

最小 one-shot soak:
```bash
BASE='https://pivota-agent-production.up.railway.app' \
DURATION_SECONDS=60 \
BASE_RPS=1 CHAOS_RPS=1 SPIKE_RPS=2 \
TOXIPROXY_ENABLED=false \
bash scripts/smoke_chaos_soak_aurora_skin.sh --once --scenario use_photo_false --lang EN
```
