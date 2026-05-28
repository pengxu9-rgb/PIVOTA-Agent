# KB x Commerce Index Readiness Audit

Generated: 2026-05-27T17:21:08.919Z

Scope: active external seeds, market=US, include_attached=true, limit=20000

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave35_786_identity_refresh_serving_sync_20260527/readiness_before_catalog_sync

## Executive Numbers

- Rows scanned: 9
- Terminal hold rows: 0
- Action-required rows: 9
- DB Serving Ready rows: 0 (0)
- DB Serving Ready rows excluding terminal holds: 0 (0)
- External index published rows: 0
- Direct KB displayable rows: 9
- Direct KB high-quality-ready rows: 8
- Identity ready rows: 0
- Public commerce doc groups built by dry-run: 0
- Rows with public commerce doc + insight summary: 0
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
| identity_blocked | 9 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 786cosmetics.com | 9 | 0 | 0 | 0 | 0 | 0 | identity_blocked |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 9,
  "by_market": {
    "US": 9
  },
  "by_domain": [
    {
      "key": "786cosmetics.com",
      "count": 9
    }
  ],
  "by_product_family": [
    {
      "key": "single_formula",
      "count": 9
    }
  ],
  "coverage": {
    "missing_inci": 0,
    "missing_active_raw": 9,
    "missing_details": 0,
    "missing_how_to": 0,
    "missing_faq": 0
  },
  "pivota_insights": {
    "direct": {
      "displayable": 9,
      "high_quality_ready": 8,
      "missing_kb": 0,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 9,
      "high_quality_ready": 8,
      "missing_kb": 0,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [
      {
        "key": "empty_watchouts",
        "count": 9
      },
      {
        "key": "quality_eligible",
        "count": 9
      },
      {
        "key": "ellipsis_or_truncated",
        "count": 1
      },
      {
        "key": "public_truncated_copy",
        "count": 1
      }
    ],
    "effective_issue_domains": [
      {
        "key": "786cosmetics.com::empty_watchouts",
        "count": 9
      },
      {
        "key": "786cosmetics.com::quality_eligible",
        "count": 9
      },
      {
        "key": "786cosmetics.com::ellipsis_or_truncated",
        "count": 1
      },
      {
        "key": "786cosmetics.com::public_truncated_copy",
        "count": 1
      }
    ],
    "quality_state": [
      {
        "key": "eligible",
        "count": 9
      }
    ],
    "evidence_profile": [
      {
        "key": "seller_plus_formula",
        "count": 9
      }
    ],
    "samples": {
      "ellipsis_or_truncated": [
        {
          "external_product_id": "ext_5f55c01bae5cd6b5f0a0e78e",
          "domain": "786cosmetics.com",
          "title": "Dakar - Breathable Nail Polish",
          "used_product_id": "ext_5f55c01bae5cd6b5f0a0e78e",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
        }
      ],
      "public_truncated_copy": [
        {
          "external_product_id": "ext_5f55c01bae5cd6b5f0a0e78e",
          "domain": "786cosmetics.com",
          "title": "Dakar - Breathable Nail Polish",
          "used_product_id": "ext_5f55c01bae5cd6b5f0a0e78e",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
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
        "count": 9
      }
    ],
    "issues": [],
    "issue_domains": [],
    "source_origin": [
      {
        "key": "pdp_section",
        "count": 9
      }
    ],
    "samples": {}
  },
  "variants": {
    "status": [
      {
        "key": "no_visible_variant_axis",
        "count": 9
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
