# Skin Prompt Quality Gate

- Cases: 85
- Judged rows: 85
- Prompt version: skin_v3
- Deepening prompt version: skin_deepening_v2_canonical
- Judge mode: single

## Bucket Summary

- vision / en-US: pass=false success_rate=0.6667 avg_score=5.53 hard_fail_rate=0.4 below8_rate=0.4 repeat_consistency=0.6667
- vision / zh-CN: pass=false success_rate=0.6667 avg_score=5.53 hard_fail_rate=0.4 below8_rate=0.4 repeat_consistency=0.6
- report / en-US: pass=false success_rate=0.4667 avg_score=3.07 hard_fail_rate=0.7333 below8_rate=0.7333 repeat_consistency=0.4667
- report / zh-CN: pass=false success_rate=0.9 avg_score=8.5 hard_fail_rate=0.1 below8_rate=0.1 repeat_consistency=0.5
- deepening / en-US: pass=false success_rate=0.9333 avg_score=8.31 hard_fail_rate=0.1333 below8_rate=0.1333 repeat_consistency=0.5333
- deepening / zh-CN: pass=false success_rate=1 avg_score=9.87 hard_fail_rate=0 below8_rate=0 repeat_consistency=0.5333

## Rows Needing Review

- vision_insufficient_placeholder_en / vision / en-US / repeat=0: score=0 hard_fail=true reasons=outright_call_failure
- vision_insufficient_placeholder_en / vision / en-US / repeat=1: score=0 hard_fail=true reasons=outright_call_failure
- vision_insufficient_placeholder_en / vision / en-US / repeat=2: score=0 hard_fail=true reasons=outright_call_failure
- vision_insufficient_placeholder_en / vision / en-US / repeat=3: score=0 hard_fail=true reasons=outright_call_failure
- vision_insufficient_placeholder_en / vision / en-US / repeat=4: score=0 hard_fail=true reasons=outright_call_failure
- vision_pass_quality_en / vision / en-US / repeat=2: score=0 hard_fail=true reasons=judge_failed
- vision_weak_signal_en / vision / en-US / repeat=0: score=8 hard_fail=false reasons=
- vision_weak_signal_en / vision / en-US / repeat=4: score=8 hard_fail=false reasons=
- vision_weak_signal_zh / vision / zh-CN / repeat=0: score=8 hard_fail=false reasons=
- vision_weak_signal_zh / vision / zh-CN / repeat=1: score=8 hard_fail=false reasons=
- vision_weak_signal_zh / vision / zh-CN / repeat=2: score=8.5 hard_fail=false reasons=
- vision_weak_signal_zh / vision / zh-CN / repeat=3: score=8.5 hard_fail=false reasons=
- vision_weak_signal_zh / vision / zh-CN / repeat=4: score=0 hard_fail=true reasons=judge_failed
- vision_insufficient_placeholder_zh / vision / zh-CN / repeat=0: score=0 hard_fail=true reasons=outright call failure
- vision_insufficient_placeholder_zh / vision / zh-CN / repeat=1: score=0 hard_fail=true reasons=outright call failure
- vision_insufficient_placeholder_zh / vision / zh-CN / repeat=2: score=0 hard_fail=true reasons=outright call failure
- vision_insufficient_placeholder_zh / vision / zh-CN / repeat=3: score=0 hard_fail=true reasons=outright call failure
- vision_insufficient_placeholder_zh / vision / zh-CN / repeat=4: score=0 hard_fail=true reasons=outright call failure
- report_barrier_redness_en / report / en-US / repeat=1: score=1 hard_fail=true reasons=structure_failure, json_truncation
- report_barrier_redness_en / report / en-US / repeat=2: score=1 hard_fail=true reasons=outright_call_failure
