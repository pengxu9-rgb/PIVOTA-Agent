# KB x Commerce Index Readiness Audit

Generated: 2026-06-01T02:48:45.767Z

Scope: active external seeds, market=US, include_attached=true, limit=10

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave113_kravebeauty_product_intel_20260601/readiness_after_product_intel

## Executive Numbers

- Rows scanned: 3
- Terminal hold rows: 0
- Action-required rows: 1
- DB Serving Ready rows: 2 (0.6667)
- DB Serving Ready rows excluding terminal holds: 2 (0.6667)
- External index published rows: 0
- Direct KB displayable rows: 3
- Direct KB high-quality-ready rows: 2
- Identity ready rows: 3
- Public commerce doc groups built by dry-run: 3
- Rows with public commerce doc + insight summary: 2
- External index configured: false
- External index required for DB Serving Ready: false

## Active External Seed Rows By Market

| Market | Active rows |
| --- | ---: |
| US | 5774 |
| EU-DE | 50 |
| KR | 12 |
| JP | 10 |

## Main Blockers

| Blocker | Rows |
| --- | ---: |
| db_serving_ready | 2 |
| kb_blocked | 1 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| kravebeauty.com | 3 | 0 | 2 | 0.6667 | 0.6667 | 0 | kb_blocked |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 3,
  "by_market": {
    "US": 3
  },
  "by_domain": [
    {
      "key": "kravebeauty.com",
      "count": 3
    }
  ],
  "by_product_family": [
    {
      "key": "set_or_collection",
      "count": 1
    },
    {
      "key": "single_formula",
      "count": 1
    },
    {
      "key": "unknown_product",
      "count": 1
    }
  ],
  "coverage": {
    "missing_inci": 2,
    "missing_active_raw": 1,
    "missing_details": 1,
    "missing_how_to": 0,
    "missing_faq": 1
  },
  "pivota_insights": {
    "direct": {
      "displayable": 3,
      "high_quality_ready": 2,
      "missing_kb": 0,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 3,
      "high_quality_ready": 2,
      "missing_kb": 0,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [
      {
        "key": "public_sensitive_claim",
        "count": 1
      }
    ],
    "effective_issue_domains": [
      {
        "key": "kravebeauty.com::public_sensitive_claim",
        "count": 1
      }
    ],
    "quality_state": [
      {
        "key": "reviewed",
        "count": 3
      }
    ],
    "evidence_profile": [
      {
        "key": "official_pdp_seed",
        "count": 2
      },
      {
        "key": "seller_plus_formula",
        "count": 1
      }
    ],
    "samples": {
      "public_sensitive_claim": [
        {
          "external_product_id": "ext_5ffe1c0b5195b36d2bdcffa9",
          "domain": "kravebeauty.com",
          "title": "Oil La La",
          "used_product_id": "ext_5ffe1c0b5195b36d2bdcffa9",
          "quality_state": "reviewed",
          "evidence_profile": "seller_plus_formula"
        }
      ]
    }
  },
  "active_ingredients": {
    "regulatory_expected": 0,
    "hero_expected": 1,
    "any_active_items": 1,
    "status": [
      {
        "key": "not_applicable_product_family",
        "count": 1
      },
      {
        "key": "not_expected_missing",
        "count": 1
      },
      {
        "key": "ready_hero",
        "count": 1
      }
    ],
    "issues": [],
    "issue_domains": [],
    "source_origin": [
      {
        "key": "none",
        "count": 2
      },
      {
        "key": "pdp_section",
        "count": 1
      }
    ],
    "samples": {}
  },
  "variants": {
    "status": [
      {
        "key": "ready",
        "count": 3
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
