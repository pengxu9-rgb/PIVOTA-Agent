# Verify Failure Action Plan (2026-02-09)

Generated at (UTC): 2026-02-09T09:01:42.951275Z

## Baseline
- verify_calls_total: 211
- verify_fail_total: 163
- fail_rate: 0.773
- average_agreement: 0.445

## Priority Queue (High -> Low Impact)

| Priority | Reason | Fail Count | Share of Fails | Top Status Pair | Action |
| --- | --- | --- | --- | --- | --- |
| P1 | UPSTREAM_5XX | 43 | 0.264 | UPSTREAM_5XX|503 (25) | 检查 Gemini 上游可用性与区域路由，补充 provider 级 circuit-breaker（5xx 连续阈值后短暂熔断），并记录 upstream request id。 |
| P2 | TIMEOUT | 27 | 0.166 | TIMEOUT|504 (20) | 提高 verifier 超时上限并拆分 connect/read timeout；保留 2 次指数退避重试，超时后降级为 skip+可追踪 reason。 |
| P3 | IMAGE_FETCH_FAILED | 23 | 0.141 | IMAGE_FETCH_FAILED|400 (23) | 修复影像下载链路：补充 signed URL 过期检测、content-type/size 校验、重签 URL 一次重试。 |
| P4 | SCHEMA_INVALID | 23 | 0.141 | SCHEMA_INVALID|200 (23) | 收紧 Gemini 输出契约：强制 JSON schema、字段白名单、温度下调；解析失败时记录原始响应片段用于回放。 |
| P5 | QUOTA | 18 | 0.11 | QUOTA|402 (13) | 增加 quota 预算保护：高峰时动态降采样 verify；按日配额和分钟配额双阈值告警。 |
| P6 | NETWORK_ERROR | 10 | 0.061 | NETWORK_ERROR|0 (10) | 网络层增加 DNS/连接错误重试（短退避）并上报错误类分桶，排查 egress/DNS 抖动。 |
| P7 | UPSTREAM_4XX | 10 | 0.061 | UPSTREAM_4XX|401 (5) | 排查 API key / project / model 权限，特别是 401/403；增加启动时凭证自检与过期告警。 |
| P8 | RATE_LIMIT | 9 | 0.055 | RATE_LIMIT|429 (9) | 为 429 增加 per-provider 限流器和令牌桶，减少并发尖峰。 |

## 24h Execution Checklist

- P1 `UPSTREAM_5XX`: 抓取近 50 条失败样本，确认是否集中在单一 provider/region。
- P2 `TIMEOUT`: 将 verify timeout 配置提升并做 30 次压测，目标将 TIMEOUT 降低 30% 以上。
- P3 `IMAGE_FETCH_FAILED`: 对失败样本做 URL 可用性复核，确认是过期/鉴权/格式哪一类。
- P4 `SCHEMA_INVALID`: 对 schema fail 响应建立回放集合，调整 prompt+parser 后回放通过率目标 >95%。
- 配额类（`QUOTA` + `RATE_LIMIT`）: 根据调用峰值调整并发与预算守卫阈值。

## Exit Criteria (Next Report)

- verify_fail_total / verify_calls_total <= 0.45
- `UPSTREAM_5XX` + `TIMEOUT` 合计占比 <= 0.25
- `SCHEMA_INVALID` 占比 <= 0.05
- `IMAGE_FETCH_FAILED` 占比 <= 0.05
