# KB x Commerce Index Readiness Audit

Generated: 2026-05-28T01:13:30.806Z

Scope: active external seeds, market=US, include_attached=true, limit=20000

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave36_identity_refresh_small_batch_20260528/readiness_after_catalog_sync_all_candidates

## Executive Numbers

- Rows scanned: 4
- Terminal hold rows: 0
- Action-required rows: 1
- DB Serving Ready rows: 3 (0.75)
- DB Serving Ready rows excluding terminal holds: 3 (0.75)
- External index published rows: 0
- Direct KB displayable rows: 4
- Direct KB high-quality-ready rows: 4
- Identity ready rows: 3
- Public commerce doc groups built by dry-run: 3
- Rows with public commerce doc + insight summary: 3
- External index configured: false
- External index required for DB Serving Ready: false

## Active External Seed Rows By Market

| Market | Active rows |
| --- | ---: |
| US | 5766 |
| EU-DE | 50 |
| KR | 12 |
| JP | 10 |

## Main Blockers

| Blocker | Rows |
| --- | ---: |
| db_serving_ready | 3 |
| identity_blocked | 1 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| delicatedaisys.com | 2 | 0 | 2 | 1 | 1 | 0 | ready_no_action |
| joocyee.com | 1 | 0 | 1 | 1 | 1 | 0 | ready_no_action |
| medicube.us | 1 | 0 | 0 | 0 | 0 | 0 | identity_blocked |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 4,
  "by_market": {
    "US": 4
  },
  "by_domain": [
    {
      "key": "delicatedaisys.com",
      "count": 2
    },
    {
      "key": "joocyee.com",
      "count": 1
    },
    {
      "key": "medicube.us",
      "count": 1
    }
  ],
  "by_product_family": [
    {
      "key": "single_formula",
      "count": 3
    },
    {
      "key": "set_or_collection",
      "count": 1
    }
  ],
  "coverage": {
    "missing_inci": 0,
    "missing_active_raw": 3,
    "missing_details": 2,
    "missing_how_to": 0,
    "missing_faq": 4
  },
  "pivota_insights": {
    "direct": {
      "displayable": 4,
      "high_quality_ready": 4,
      "missing_kb": 0,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 4,
      "high_quality_ready": 4,
      "missing_kb": 0,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [],
    "effective_issue_domains": [],
    "quality_state": [
      {
        "key": "reviewed",
        "count": 3
      },
      {
        "key": "verified",
        "count": 1
      }
    ],
    "evidence_profile": [
      {
        "key": "seller_plus_formula",
        "count": 4
      }
    ],
    "samples": {}
  },
  "active_ingredients": {
    "regulatory_expected": 0,
    "hero_expected": 2,
    "any_active_items": 0,
    "status": [
      {
        "key": "missing_hero",
        "count": 2
      },
      {
        "key": "not_applicable_product_family",
        "count": 1
      },
      {
        "key": "not_expected_missing",
        "count": 1
      }
    ],
    "issues": [
      {
        "key": "missing_hero",
        "count": 2
      }
    ],
    "issue_domains": [
      {
        "key": "delicatedaisys.com::missing_hero",
        "count": 2
      }
    ],
    "source_origin": [
      {
        "key": "pdp_section",
        "count": 3
      },
      {
        "key": "none",
        "count": 1
      }
    ],
    "samples": {
      "missing_hero": [
        {
          "external_product_id": "ext_5232f3454fc57c62d8d3e7bc",
          "domain": "delicatedaisys.com",
          "title": "Refreshing Body Wash Bulgarian Rose",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_05040ea019efc2b0fe1a9111",
          "domain": "delicatedaisys.com",
          "title": "Firming & Polishing Body Scrub Sea Salt & Pineapple",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "pdp_section"
        }
      ]
    }
  },
  "variants": {
    "status": [
      {
        "key": "no_visible_variant_axis",
        "count": 2
      },
      {
        "key": "flagged",
        "count": 1
      },
      {
        "key": "ready",
        "count": 1
      }
    ],
    "issues": [
      {
        "key": "default_option_size_evidence_missing_axis",
        "count": 1
      }
    ],
    "issue_domains": [
      {
        "key": "joocyee.com::default_option_size_evidence_missing_axis",
        "count": 1
      }
    ],
    "samples": {
      "default_option_size_evidence_missing_axis": [
        {
          "external_product_id": "ext_10d91302e0cbb32d89cb0cb7",
          "domain": "joocyee.com",
          "title": "Dual-Ended Eyebrow Pencil & Cream 2.0",
          "status": "flagged",
          "examples": [
            {
              "axis_name": "default",
              "axis_kind": "volume",
              "value": "2 g",
              "visual": false
            }
          ]
        }
      ]
    }
  }
}
```

## Notes

- DB Serving Ready is stricter than KB presence. Seller-only or limited evidence is not counted as high-quality pass.
- Commerce dry-run used the same catalog serving document builder with `includeNonPublic=false` and market-filtered source rows derived from `external_product_seeds`; no DB/index writes were attempted.
- A row can have high-quality KB and still fail DB serving readiness if identity or commerce doc hydration does not expose it.
- External index publication is tracked separately and is not a blocker for the current DB-backed serving path.
- Next remediation should start from `gap_backlog.csv` ordered by lane and domain impact.
