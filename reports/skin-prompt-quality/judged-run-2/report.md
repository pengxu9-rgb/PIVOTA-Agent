# Skin Prompt Quality Gate

- Cases: 85
- Judged rows: 85
- Prompt version: skin_v3
- Deepening prompt version: skin_deepening_v2_canonical
- Judge mode: single

## Bucket Summary

- vision / en-US: pass=false success_rate=0.6667 avg_score=6.27 hard_fail_rate=0.3333 below8_rate=0.4 repeat_consistency=0.6667
- vision / zh-CN: pass=false success_rate=0.6667 avg_score=4.9 hard_fail_rate=0.4667 below8_rate=0.5333 repeat_consistency=0.7333
- report / en-US: pass=false success_rate=1 avg_score=6 hard_fail_rate=0.4 below8_rate=0.4 repeat_consistency=0.4667
- report / zh-CN: pass=false success_rate=1 avg_score=8.85 hard_fail_rate=0.1 below8_rate=0.1 repeat_consistency=0.5
- deepening / en-US: pass=false success_rate=0.9333 avg_score=9.2 hard_fail_rate=0.0667 below8_rate=0.0667 repeat_consistency=0.5333
- deepening / zh-CN: pass=false success_rate=1 avg_score=9.97 hard_fail_rate=0 below8_rate=0 repeat_consistency=0.7333

## Rows Needing Review

- vision_insufficient_placeholder_en / vision / en-US / repeat=0: score=0 hard_fail=true reasons=outright_call_failure
- vision_insufficient_placeholder_en / vision / en-US / repeat=1: score=0 hard_fail=true reasons=outright_call_failure
- vision_insufficient_placeholder_en / vision / en-US / repeat=2: score=0 hard_fail=true reasons=outright_call_failure
- vision_insufficient_placeholder_en / vision / en-US / repeat=3: score=0 hard_fail=true reasons=outright_call_failure
- vision_insufficient_placeholder_en / vision / en-US / repeat=4: score=0 hard_fail=true reasons=outright_call_failure
- vision_weak_signal_en / vision / en-US / repeat=3: score=7 hard_fail=false reasons=
- vision_weak_signal_zh / vision / zh-CN / repeat=0: score=6 hard_fail=false reasons=
- vision_weak_signal_zh / vision / zh-CN / repeat=2: score=0 hard_fail=true reasons=judge_failed
- vision_weak_signal_zh / vision / zh-CN / repeat=4: score=0 hard_fail=true reasons=judge_failed
- vision_insufficient_placeholder_zh / vision / zh-CN / repeat=0: score=0 hard_fail=true reasons=outright call failure
- vision_insufficient_placeholder_zh / vision / zh-CN / repeat=1: score=0 hard_fail=true reasons=outright call failure
- vision_insufficient_placeholder_zh / vision / zh-CN / repeat=2: score=0 hard_fail=true reasons=outright call failure
- vision_insufficient_placeholder_zh / vision / zh-CN / repeat=3: score=0 hard_fail=true reasons=outright call failure
- vision_insufficient_placeholder_zh / vision / zh-CN / repeat=4: score=0 hard_fail=true reasons=outright call failure
- report_barrier_redness_en / report / en-US / repeat=0: score=0 hard_fail=true reasons=judge_failed
- report_oiliness_acne_zh / report / zh-CN / repeat=4: score=0 hard_fail=true reasons=judge_failed
- report_degraded_quality_en / report / en-US / repeat=0: score=0 hard_fail=true reasons=judge_failed
- report_degraded_quality_en / report / en-US / repeat=1: score=0 hard_fail=true reasons=judge_failed
- report_degraded_quality_en / report / en-US / repeat=2: score=0 hard_fail=true reasons=judge_failed
- report_degraded_quality_en / report / en-US / repeat=3: score=0 hard_fail=true reasons=judge_failed
