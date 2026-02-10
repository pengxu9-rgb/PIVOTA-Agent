# Internal Photo Batch Report (internal_batch_20260210_0321)

- started_at_utc: 2026-02-10T03:21:50.165Z
- finished_at_utc: 2026-02-10T03:23:21.648Z
- run_id: internal_batch_20260210_0321
- processed_count: 14
- discovered_count: 14
- selected_count: 14
- aborted_early: false

## 1) 总览

- 成功率: 1 (14/14)
- used_photos 率: 1 (14/14)
- photo_modules_v1 有卡比例: 0.8571 (12/14)

| quality_grade | count | ratio |
| --- | --- | --- |
| degraded | 12 | 0.8571 |
| fail | 2 | 0.1429 |

## 2) photo_modules_v1 覆盖

- regions_count 均值: 6.8571
- modules_count 均值: 6
- actions_count 均值: 56.3571
- products_count 均值: 0

| metric | distribution |
| --- | --- |
| regions_count | {"0":2,"8":12} |
| modules_count | {"0":2,"7":12} |
| actions_count | {"0":2,"60":2,"63":4,"66":2,"69":1,"72":3} |
| products_count | {"0":14} |

| evidence_metric | distribution |
| --- | --- |
| evidence_grade_distribution | {"C":789} |
| citations_count_distribution | {"0":789} |

## 3) claims/模板

- claims_violation_detected=true 数量: 0
- claims_violation_detected=unknown 数量: 2
- claims_template_fallback 均值(仅已知样本): 65.75
- claims_template_fallback 已知样本数: 12

| fallback_reason | count |
| --- | --- |
| ok | 789 |

_No violation reasons observed._

## 4) Product Rec

- product_rec_enabled(推断): false
- emitted(每图 products_count>0): 0
- suppressed(每图 products_count=0): 14

_Suppression reason unavailable (likely INTERNAL_TEST_MODE off)._

## 5) Top 20 需要人工复核样本

| photo_hash | reasons | quality_grade | error_kind | actions_count | products_count | claims_fallback |
| --- | --- | --- | --- | --- | --- | --- |
| 2be889b510c1a38033bae360db000cbc1a17266fb34b595b9a588042d4fcc356 | NO_CARD,QUALITY_FAIL,REGIONS_ZERO,ACTIONS_ZERO | fail | NO_CARD | 0 | 0 | unknown |
| db9c9a65ca745d0465847cb6cb4aaa20fc41456d567629cce5743f52764486ae | NO_CARD,QUALITY_FAIL,REGIONS_ZERO,ACTIONS_ZERO | fail | NO_CARD | 0 | 0 | unknown |
| 08345d3670efbb54853a472e8cebb79d383487078aad1418e8cc4d9ca3fca442 | QUALITY_DEGRADED,CLAIMS_FALLBACK_HIGH | degraded |  | 69 | 0 | 69 |
| 1a421d3b67d230413d7d12fc71f10b7c354e65dfabf2040526882ae4fb930611 | QUALITY_DEGRADED,CLAIMS_FALLBACK_HIGH | degraded |  | 63 | 0 | 63 |
| 2cde5c68a939ead990c96fcc13920cf9cf09922eaeca1700ca92777bd37e26c0 | QUALITY_DEGRADED,CLAIMS_FALLBACK_HIGH | degraded |  | 60 | 0 | 60 |
| 370608993748ebd4eb84fbad23b93fc4efe7cdb554a51a018720fb39fac04f77 | QUALITY_DEGRADED,CLAIMS_FALLBACK_HIGH | degraded |  | 63 | 0 | 63 |
| 7d3afb114bf090b5b9caa72148dd872e16829c4d9a99c46d2c3806dda4e3756d | QUALITY_DEGRADED,CLAIMS_FALLBACK_HIGH | degraded |  | 60 | 0 | 60 |
| 81001ae2d5107a11d62a57eed0b65dbed5b28982a55cca6cabdf00797a3e566d | QUALITY_DEGRADED,CLAIMS_FALLBACK_HIGH | degraded |  | 63 | 0 | 63 |
| 97b6ca57da0455f72b7af54f774c52199d9f5addcdd4363965a1c2da608b7a70 | QUALITY_DEGRADED,CLAIMS_FALLBACK_HIGH | degraded |  | 72 | 0 | 72 |
| 97c18f872fe4d7901413702726ab2e1143f2e61470369793bea45ad9e445cb56 | QUALITY_DEGRADED,CLAIMS_FALLBACK_HIGH | degraded |  | 72 | 0 | 72 |
| c1c8d71be8c35385c9eb6aea40863e474ddbe07ec321daafd1bbe64b9c199dc2 | QUALITY_DEGRADED,CLAIMS_FALLBACK_HIGH | degraded |  | 66 | 0 | 66 |
| d5028a5fda1c616936a9fff99c7c484d402b967aa0627289dd9295d9539e9f1a | QUALITY_DEGRADED,CLAIMS_FALLBACK_HIGH | degraded |  | 66 | 0 | 66 |
| db096233b1a2b8103ace5b271a37f283d09a698e15da2771cbeb1ac44d521ed5 | QUALITY_DEGRADED,CLAIMS_FALLBACK_HIGH | degraded |  | 72 | 0 | 72 |
| ec9ee489fb60cf362b3adb905baf6c6cebb88b4878e48ddffed7e72fbffe82b8 | QUALITY_DEGRADED,CLAIMS_FALLBACK_HIGH | degraded |  | 63 | 0 | 63 |

## 6) Gate Results

- hard_gate_pass: true
_No hard gate failures._

| soft_gate_warning |
| --- |
| degraded_or_fail_ratio=1 > 0.3 |

## 7) 运行命令与环境摘要

- base: https://pivota-agent-production.up.railway.app
- market: EU
- lang: en
- mode_requested: confirm
- concurrency: 4
- limit: all
- shuffle: false
- sanitize: true (max_edge=2048)
- timeout_ms: 30000
- retry: 2
- fail_fast_on_claim_violation: false
- photos_dir_hash: 54c277a1a11f491d
- token_present: false
- hard thresholds: card_ratio>=0.8, used_photos_ratio>=0.8
- soft thresholds: degraded_ratio<=0.3, actions_zero_ratio<=0.2, products_zero_ratio<=0.7
- artifacts: md=reports/internal_batch_20260210_0321.md, csv=reports/internal_batch_20260210_0321.csv, jsonl=reports/internal_batch_20260210_0321.jsonl

## Additional Distributions

| mode | count |
| --- | --- |
| confirm | 14 |

| error_kind | count |
| --- | --- |
| none | 12 |
| NO_CARD | 2 |

