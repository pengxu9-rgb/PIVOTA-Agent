# Casebook (24h)

## Strict-empty Top Queries

| query | count | intent_top1 | domain | result_type | reason_code |
|---|---:|---|---|---|---|
| 狗链 | 1 | category | pet | strict_empty | NO_CANDIDATES |

## Quality-risk Top Queries

| query | count | intent_top1 | domain | result_type | reason_code |
|---|---:|---|---|---|---|
| 约会妆 | 1 | scenario | beauty | clarify | AMBIGUOUS_MEDIUM |
| 狗链 | 1 | category | pet | strict_empty | NO_CANDIDATES |
| ipsa | 1 | lookup | beauty | product_list | CACHE_HIT |

## Degrade Top Queries

| query | count | intent_top1 | domain | result_type | reason_code |
|---|---:|---|---|---|---|

## Strict-empty Samples

### 狗链 (1)
- req_id=sample-3 reason=NO_CANDIDATES U_pre=0.370; U_post=0.620; domain_entropy_topK=null; anchor_ratio_topK=null; drops.domain_filter=0; degrade.vector_skipped=false; degrade.nlu_degraded=false; degrade.behavior_skipped=false

## Quality-risk Samples

### 约会妆 (1)
- req_id=sample-2 reason=AMBIGUOUS_MEDIUM U_pre=0.420; U_post=0.710; domain_entropy_topK=null; anchor_ratio_topK=null; drops.domain_filter=2; degrade.vector_skipped=false; degrade.nlu_degraded=false; degrade.behavior_skipped=false

### 狗链 (1)
- req_id=sample-3 reason=NO_CANDIDATES U_pre=0.370; U_post=0.620; domain_entropy_topK=null; anchor_ratio_topK=null; drops.domain_filter=0; degrade.vector_skipped=false; degrade.nlu_degraded=false; degrade.behavior_skipped=false

### ipsa (1)
- req_id=sample-1 reason=CACHE_HIT U_pre=0.110; U_post=0.140; domain_entropy_topK=0.000; anchor_ratio_topK=1.000; drops.domain_filter=0; degrade.vector_skipped=false; degrade.nlu_degraded=false; degrade.behavior_skipped=false

## Degrade Samples
