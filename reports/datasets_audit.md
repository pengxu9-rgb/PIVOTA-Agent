# Datasets Audit

- generated_at: 2026-02-10T11:33:37.641Z
- result: **PASS**
- datasets_audited: lapa, celebamaskhq, fasseg, acne04
- registry: datasets/registry.yaml
- manifests_dir: datasets_cache/manifests

| check | status | detail |
|---|---:|---|
| registry_schema | PASS | entries=4 |
| manifest_lapa | PASS | record_count=22168 |
| manifest_celebamaskhq | PASS | record_count=30000 |
| manifest_fasseg | PASS | record_count=151 |
| manifest_acne04 | PASS | record_count=1457 |
| gitignore:datasets_cache/** | PASS | present |
| gitignore:outputs/datasets_debug/** | PASS | present |

