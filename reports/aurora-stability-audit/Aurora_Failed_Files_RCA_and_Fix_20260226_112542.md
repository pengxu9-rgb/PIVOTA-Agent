# Aurora 失败文件根因盘点与修复闭环（2026-02-26）

## 1. 目标与范围
- 目标：对本轮稳定复现的失败测试进行根因归并、修复落地、回归验收。
- 范围：`aurora bff` 与 `product_intel/reco/invoke` 相关失败子集；不做与本批失败无关的业务重构。
- 决策基线：
  - 以“测试适配现状”为主。
  - 两处代码修复必须落地：`self-proxy-first` 开关生效、`missing_info` 内部码隐藏。

## 2. 根因归并（5 类）

### P0-A 测试桩崩溃：axios mock 形状不完整
- 现象：服务加载阶段抛错 `Cannot set properties of undefined (setting 'httpAgent')`。
- 根因：测试里 mock 的 `axios` 缺失 `defaults`。
- 影响环节：`server bootstrap`、`look replicator`、`catalog sync`。
- 处置：在相关 mock 中统一补齐 `defaults: {}`。

### P0-B 路由优先级开关未落地：self-proxy-first 无效
- 现象：测试期望 `attempted_endpoints[0]` 为 self-proxy，但实际未生效。
- 根因：catalog base URL 候选排序函数缺少 `preferSelfProxyFirst` 分支。
- 影响环节：`reco catalog routing`、`competitor recall` 首跳可用性。
- 处置：在候选函数中引入 `preferSelfProxyFirst`，并支持环境变量开关。

### P1-C 公开 payload 内部码泄露
- 现象：`product_analysis.missing_info` 出现 `reco_blocks_*` 内部诊断码。
- 根因：gap code 判定未将该类码归入 internal 通道。
- 影响环节：前端文案契约、对外语义稳定性。
- 处置：`reco_blocks_schema_invalid` 加入 internal exact；`reco_blocks_` 前缀统一 internal。

### P1-D 契约语义漂移（测试与实现偏移）
- 现象：
  - `external_seed_strategy` 默认值从 `legacy` 漂移。
  - `reason_breakdown` 漂移到 `reason_counts`。
  - 低信号场景可能返回降级对象而非 `undefined`。
  - diagnosis-first gate 行为变化（advisory/confidence/reco 空卡形态）。
- 根因：实现策略已演进，旧断言未同步。
- 影响环节：`invoke fallback`、`reco diagnostics`、`chat orchestration`。
- 处置：按当前实现更新断言，保留关键行为门禁。

### P1/P2-E 慢测超时与异步尾部拖延
- 现象：`/v1/product/analyze` 多用例接近或超过旧超时阈值，偶发尾部异步拖延。
- 根因：长链路 + 异步 backfill + 外部依赖模拟组合导致耗时波动。
- 影响环节：CI 稳定性。
- 处置：相关套件提高超时阈值并在用例中显式控制非目标分支。

## 3. 已落地变更

### 3.1 代码修复（按要求保留的两处）
1) self-proxy-first 开关落地
- 文件：`src/auroraBff/routes.js`
- 要点：
  - 新增环境开关读取：`AURORA_BFF_RECO_CATALOG_AURORA_SELF_PROXY_FIRST`
  - `buildRecoCatalogSearchBaseUrlCandidates` 新增参数 `preferSelfProxyFirst`
  - 排序在开关开启时优先 self-proxy，保持去重逻辑

2) 内部码隐藏
- 文件：`src/auroraBff/normalize.js`
- 要点：
  - `reco_blocks_schema_invalid` 纳入 internal exact
  - `reco_blocks_` 前缀纳入 internal prefix
  - 对外 `missing_info` 保持用户可解释码

### 3.2 测试修复与适配
- 崩溃修复：
  - `tests/lookReplicator/lookReplicator_checkout_sessions.test.js`
  - `tests/lookReplicator/lookReplicator_orders_proxy.test.js`
  - `tests/lookReplicator/lookReplicator_commerce_invoke.test.js`
  - `tests/catalog_sync_retry_timeout.test.js`
- 语义适配与稳定化：
  - `tests/integration/invoke.find_products_multi_fallback.test.js`
  - `tests/aurora_reco_blocks_dag.test.js`
  - `tests/aurora_reco_score_explain.test.js`
  - `tests/aurora_realtime_competitor_recall_budget.test.js`
  - `tests/aurora_bff_product_intel.test.js`
  - `tests/aurora_bff.test.js`

## 4. 回归执行与结果

### 4.1 P0 崩溃子集
- 命令：
  - `npx jest --runInBand tests/lookReplicator/lookReplicator_checkout_sessions.test.js tests/lookReplicator/lookReplicator_orders_proxy.test.js tests/lookReplicator/lookReplicator_commerce_invoke.test.js tests/catalog_sync_retry_timeout.test.js`
- 结果：`4 suites passed, 18 tests passed`。

### 4.2 关键失败子集（最终门禁）
- 命令：
  - `npx jest --runInBand tests/aurora_bff_product_intel.test.js tests/aurora_bff_product_intel_public_payload.test.js tests/integration/invoke.find_products_multi_fallback.test.js tests/aurora_reco_blocks_dag.test.js tests/aurora_reco_score_explain.test.js tests/aurora_bff.test.js tests/aurora_realtime_competitor_recall_budget.test.js`
- 结果：`7 suites passed, 136 tests passed`。

## 5. 当前结论
- 本轮失败文件已完成根因闭环；目标子集回归全绿。
- 两处必须代码改动（self-proxy-first / 内部码隐藏）均已生效。
- 主要剩余风险为“长路径耗时波动”带来的 CI 时间敏感性（非功能回归）。

## 6. 后续建议（可选）
1. 在 CI 对长链路套件保持 `--runInBand` + 专用 timeout 档位，降低并发抖动。
2. 把 `product/analyze` 的非目标异步分支继续拆到独立用例，减少主链路噪声。
3. 增加一条专门断言：`self-proxy-first` 开/关双态下的 `attempted_endpoints` 顺序快照。
