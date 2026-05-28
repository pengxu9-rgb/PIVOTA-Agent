# KB x Commerce Index Readiness Audit

Generated: 2026-05-28T10:41:06.799Z

Scope: active external seeds, market=US, include_attached=true, limit=500

Report directory: /private/tmp/pivota-agent-product-intel-tail-20260528/reports/markato_expansion_status_20260524/wave48_product_intel_tail_20260528/changed_post_audit_after_tirtir

## Executive Numbers

- Rows scanned: 85
- Terminal hold rows: 5
- Action-required rows: 51
- DB Serving Ready rows: 29 (0.3412)
- DB Serving Ready rows excluding terminal holds: 29 (0.3625)
- External index published rows: 0
- Direct KB displayable rows: 85
- Direct KB high-quality-ready rows: 85
- Identity ready rows: 34
- Public commerce doc groups built by dry-run: 31
- Rows with public commerce doc + insight summary: 30
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
| identity_blocked | 49 |
| db_serving_ready | 29 |
| terminal_hold | 5 |
| seed_content_blocked | 2 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| missnella.com | 52 | 2 | 2 | 0.0385 | 0.04 | 0 | identity_blocked |
| kyliecosmetics.com | 16 | 0 | 15 | 0.9375 | 0.9375 | 0 | seed_content_blocked |
| us.nuxe.com | 5 | 0 | 4 | 0.8 | 0.8 | 0 | seed_content_blocked |
| intoyoucosmetics.com | 3 | 0 | 3 | 1 | 1 | 0 | ready_no_action |
| catkin.com | 2 | 0 | 2 | 1 | 1 | 0 | ready_no_action |
| fentybeauty.com | 2 | 1 | 1 | 0.5 | 1 | 0 | terminal_hold |
| rarebeauty.com | 2 | 0 | 2 | 1 | 1 | 0 | ready_no_action |
| tirtir.global | 2 | 1 | 0 | 0 | 0 | 0 | identity_blocked |
| pixibeauty.com | 1 | 1 | 0 | 0 | 0 | 0 | terminal_hold |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 85,
  "by_market": {
    "US": 85
  },
  "by_domain": [
    {
      "key": "missnella.com",
      "count": 52
    },
    {
      "key": "kyliecosmetics.com",
      "count": 16
    },
    {
      "key": "us.nuxe.com",
      "count": 5
    },
    {
      "key": "intoyoucosmetics.com",
      "count": 3
    },
    {
      "key": "catkin.com",
      "count": 2
    },
    {
      "key": "fentybeauty.com",
      "count": 2
    },
    {
      "key": "rarebeauty.com",
      "count": 2
    },
    {
      "key": "tirtir.global",
      "count": 2
    },
    {
      "key": "pixibeauty.com",
      "count": 1
    }
  ],
  "by_product_family": [
    {
      "key": "set_or_collection",
      "count": 32
    },
    {
      "key": "accessory",
      "count": 29
    },
    {
      "key": "single_formula",
      "count": 20
    },
    {
      "key": "unknown_product",
      "count": 3
    },
    {
      "key": "non_merch",
      "count": 1
    }
  ],
  "coverage": {
    "missing_inci": 64,
    "missing_active_raw": 21,
    "missing_details": 50,
    "missing_how_to": 53,
    "missing_faq": 79
  },
  "pivota_insights": {
    "direct": {
      "displayable": 85,
      "high_quality_ready": 85,
      "missing_kb": 0,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 85,
      "high_quality_ready": 85,
      "missing_kb": 0,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [],
    "effective_issue_domains": [],
    "quality_state": [
      {
        "key": "reviewed",
        "count": 85
      }
    ],
    "evidence_profile": [
      {
        "key": "official_pdp_reviewed_limited",
        "count": 47
      },
      {
        "key": "official_pdp_reviewed_line",
        "count": 25
      },
      {
        "key": "official_pdp_reviewed_formula_and_usage",
        "count": 7
      },
      {
        "key": "official_pdp_reviewed_key_ingredients_and_usage",
        "count": 5
      },
      {
        "key": "official_pdp_reviewed_key_ingredients",
        "count": 1
      }
    ],
    "samples": {}
  },
  "active_ingredients": {
    "regulatory_expected": 1,
    "hero_expected": 4,
    "any_active_items": 5,
    "status": [
      {
        "key": "not_applicable_product_family",
        "count": 62
      },
      {
        "key": "not_expected_missing",
        "count": 17
      },
      {
        "key": "ready_hero",
        "count": 4
      },
      {
        "key": "missing_regulatory",
        "count": 1
      },
      {
        "key": "ready_other",
        "count": 1
      }
    ],
    "issues": [
      {
        "key": "missing_regulatory",
        "count": 1
      }
    ],
    "issue_domains": [
      {
        "key": "missnella.com::missing_regulatory",
        "count": 1
      }
    ],
    "source_origin": [
      {
        "key": "none",
        "count": 78
      },
      {
        "key": "pdp_section",
        "count": 7
      }
    ],
    "samples": {
      "missing_regulatory": [
        {
          "external_product_id": "ext_ead5ec8bda8626bc6fc7adee",
          "domain": "missnella.com",
          "title": "LavKids Skincare by Miss Nella SPF 50 Mineral Sunscreen",
          "status": "missing_regulatory",
          "active_items": [],
          "source_origin": "none"
        }
      ]
    }
  },
  "variants": {
    "status": [
      {
        "key": "ready",
        "count": 43
      },
      {
        "key": "no_visible_variant_axis",
        "count": 42
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
