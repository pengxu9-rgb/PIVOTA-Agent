# KB x Commerce Index Readiness Audit

Generated: 2026-05-28T02:04:08.176Z

Scope: active external seeds, market=US, include_attached=true, limit=20000

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave39_new_brand_source_recovery_20260528/readiness_after_seed_apply_content_patch

## Executive Numbers

- Rows scanned: 5
- Terminal hold rows: 0
- Action-required rows: 5
- DB Serving Ready rows: 0 (0)
- DB Serving Ready rows excluding terminal holds: 0 (0)
- External index published rows: 0
- Direct KB displayable rows: 0
- Direct KB high-quality-ready rows: 0
- Identity ready rows: 0
- Public commerce doc groups built by dry-run: 0
- Rows with public commerce doc + insight summary: 0
- External index configured: false
- External index required for DB Serving Ready: false

## Active External Seed Rows By Market

| Market | Active rows |
| --- | ---: |
| US | 5771 |
| EU-DE | 50 |
| KR | 12 |
| JP | 10 |

## Main Blockers

| Blocker | Rows |
| --- | ---: |
| seed_content_blocked | 5 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| oiluj.com | 5 | 0 | 0 | 0 | 0 | 0 | seed_content_blocked |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 5,
  "by_market": {
    "US": 5
  },
  "by_domain": [
    {
      "key": "oiluj.com",
      "count": 5
    }
  ],
  "by_product_family": [
    {
      "key": "single_formula",
      "count": 5
    }
  ],
  "coverage": {
    "missing_inci": 5,
    "missing_active_raw": 5,
    "missing_details": 0,
    "missing_how_to": 5,
    "missing_faq": 5
  },
  "pivota_insights": {
    "direct": {
      "displayable": 0,
      "high_quality_ready": 0,
      "missing_kb": 5,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 0,
      "high_quality_ready": 0,
      "missing_kb": 5,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [
      {
        "key": "missing_kb",
        "count": 5
      }
    ],
    "effective_issue_domains": [
      {
        "key": "oiluj.com::missing_kb",
        "count": 5
      }
    ],
    "quality_state": [
      {
        "key": "missing",
        "count": 5
      }
    ],
    "evidence_profile": [
      {
        "key": "missing",
        "count": 5
      }
    ],
    "samples": {
      "missing_kb": [
        {
          "external_product_id": "ext_07cfaab25950196c3ec1b5f3",
          "domain": "oiluj.com",
          "title": "OILÙJ, Life Oil: Organic Moringa/Sandalwood Blend",
          "used_product_id": "ext_07cfaab25950196c3ec1b5f3",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_1493a61baf165a6c00e4977b",
          "domain": "oiluj.com",
          "title": "OILÙJ, Life Oil: Organic Moringa/ French Lavender Blend",
          "used_product_id": "ext_1493a61baf165a6c00e4977b",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_3a16e6a6300af832ae3ccdb7",
          "domain": "oiluj.com",
          "title": "OILÙJ, \"Eye Live\"",
          "used_product_id": "ext_3a16e6a6300af832ae3ccdb7",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_79fc9f55f8b092590e168c8d",
          "domain": "oiluj.com",
          "title": "OILÙJ, \"Lip Life\"",
          "used_product_id": "ext_79fc9f55f8b092590e168c8d",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_ab35eb07e8635bb1e1be3ebf",
          "domain": "oiluj.com",
          "title": "OILÙJ, Life Oil",
          "used_product_id": "ext_ab35eb07e8635bb1e1be3ebf",
          "quality_state": "missing",
          "evidence_profile": "missing"
        }
      ]
    }
  },
  "active_ingredients": {
    "regulatory_expected": 0,
    "hero_expected": 0,
    "any_active_items": 0,
    "status": [
      {
        "key": "not_expected_missing",
        "count": 5
      }
    ],
    "issues": [],
    "issue_domains": [],
    "source_origin": [
      {
        "key": "none",
        "count": 5
      }
    ],
    "samples": {}
  },
  "variants": {
    "status": [
      {
        "key": "no_visible_variant_axis",
        "count": 5
      }
    ],
    "issues": [],
    "issue_domains": [],
    "samples": {}
  }
}
```

## Notes

- DB Serving Ready is stricter than KB presence. Seller-only or limited evidence is not counted as high-quality pass.
- Commerce dry-run used the same catalog serving document builder with `includeNonPublic=false` and market-filtered source rows derived from `external_product_seeds`; no DB/index writes were attempted.
- A row can have high-quality KB and still fail DB serving readiness if identity or commerce doc hydration does not expose it.
- External index publication is tracked separately and is not a blocker for the current DB-backed serving path.
- Next remediation should start from `gap_backlog.csv` ordered by lane and domain impact.
