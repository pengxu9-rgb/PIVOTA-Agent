# Aurora BFF Experiments (A/B) — Skin Diagnosis

This repo supports a lightweight, **API-compatible** A/B framework for the skin diagnosis pipeline.

- **No external API contract changes**: experiment info is only used internally (behavior + logs/metrics).
- **Deterministic bucketing**: each request is assigned a stable `variant` per `experiment_id` based on `request_id`.
- **Parallel experiments**: you can run 2–3 experiments at the same time (recommended: one per `kind`).

---

## Config: `AURORA_EXPERIMENTS_JSON`

Provide a JSON array via env var `AURORA_EXPERIMENTS_JSON`.

Example (3 experiments running in parallel):

```json
[
  {
    "id": "qgate_2026q1",
    "kind": "quality_gate",
    "variants": { "control": 50, "tighter": 50 },
    "params": {
      "control": {
        "fail": { "min_quality_factor": 0.25 },
        "degraded": { "min_quality_factor": 0.55 }
      },
      "tighter": {
        "fail": { "min_quality_factor": 0.35 },
        "degraded": { "min_quality_factor": 0.62 }
      }
    }
  },
  {
    "id": "sev_pores_nose",
    "kind": "severity_mapping",
    "variants": { "control": 50, "higher_nose_threshold": 50 },
    "params": {
      "control": {},
      "higher_nose_threshold": {
        "pores": { "nose": [0.4, 0.65, 0.85] }
      }
    }
  },
  {
    "id": "prompt_v2",
    "kind": "llm_prompt",
    "variants": { "v1": 50, "v2": 50 },
    "params": {
      "v1": { "prompt_version": "v1" },
      "v2": { "prompt_version": "v2" }
    }
  }
]
```

### Field semantics

- `id`: experiment identifier (sanitized to `[a-z0-9_-]`).
- `kind`: what subsystem it affects (sanitized to `[a-z0-9_-]`).
- `variants`: `{ variantName: weightInt }`
  - weights are interpreted on a 0..100 bucket scale.
  - if weights sum to **< 100**, remaining buckets map to **`holdout`**.
  - if weights sum to **> 100**, weights are normalized down to 100.
- `params`: optional per-variant config object (only plain objects are accepted).

### Bucketing (deterministic)

For each experiment:

- seed = `${experiment_id}:${request_id}`
- bucket = `sha256(seed) % 100`
- choose variant by cumulative weights (or `holdout`)

This means:

- same `request_id` always gets the same variant for a given `experiment_id`
- different experiments are **salted** (so they don’t share the same buckets)

### Precedence when multiple experiments share the same `kind`

The pipeline reads **one assignment per kind**; if you configure multiple experiments with the same `kind`, the **last one in the JSON array wins** for that kind’s runtime overrides.

Metrics are still emitted for **all** experiments in the list.

---

## Supported kinds (current)

### `quality_gate`

Overrides the pixel-level photo quality grade thresholds in `src/auroraBff/skinDiagnosisV1.js`.

Params shape (all numbers are `0..1`, partial overrides allowed):

```json
{
  "fail": {
    "min_coverage": 0.06,
    "min_blur_factor": 0.2,
    "min_exposure_factor": 0.2,
    "min_quality_factor": 0.25
  },
  "degraded": {
    "min_blur_factor": 0.45,
    "min_exposure_factor": 0.45,
    "min_wb_factor": 0.65,
    "min_quality_factor": 0.55
  }
}
```

### `severity_mapping`

Overrides the score → severity threshold triplets used by the deterministic detector.

Params are a partial override of the internal `SEVERITY_THRESHOLDS` map:

```json
{
  "pores": {
    "nose": [0.35, 0.6, 0.82],
    "cheeks": [0.3, 0.55, 0.78],
    "all": [0.3, 0.55, 0.78]
  }
}
```

Each triplet is `[t1, t2, t3]` for:

- `< t1` → `none`
- `< t2` → `mild`
- `< t3` → `moderate`
- `>= t3` → `severe`

### `llm_prompt`

Controls the prompt template version for both:

- OpenAI vision prompt (`buildSkinVisionPrompt`)
- Aurora/Gemini report prompt (`buildSkinReportPrompt`)

Params:

```json
{ "prompt_version": "v1" }
```

If `prompt_version` is not provided, the system falls back to using the experiment `variant` name (e.g. `"v2"`).

---

## Metrics emitted (per request)

For each experiment assignment, the server logs metrics using metric **names that embed** `experiment_id` + `variant` + `pipeline_version`.

Emitted metrics:

- `aurora.skin_experiment.<experiment_id>.<variant>.<pipeline_version>.requests` (value=1)
- `aurora.skin_experiment.<experiment_id>.<variant>.<pipeline_version>.total_ms` (value=`total_ms`)
- `aurora.skin_experiment.<experiment_id>.<variant>.<pipeline_version>.llm_calls` (value=`llm_summary.calls`)
- `aurora.skin_experiment.<experiment_id>.<variant>.<pipeline_version>.quality_grade.<grade>` (value=1)

Where `grade` is one of: `pass | degraded | fail | unknown`.

To compare variants:

- latency: compare `total_ms` percentiles by `variant`
- LLM usage: average `llm_calls` per request by `variant`
- fail/degraded rate: `quality_grade.fail / requests`, `quality_grade.degraded / requests`

---

## Troubleshooting

- If `AURORA_EXPERIMENTS_JSON` is invalid, the system will **warn in logs** and proceed with defaults.
- If an experiment has no valid `variants`, it will assign `holdout` and not apply any params.

