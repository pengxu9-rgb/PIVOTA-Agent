# KB x Commerce Index Readiness Audit

Generated: 2026-05-26T01:26:55.467Z

Scope: active external seeds, market=US, include_attached=true, limit=20000

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/wave22_nala_delicate_joocyee_identity_refresh_20260526/readiness_after_product_intel

## Executive Numbers

- Rows scanned: 17
- Terminal hold rows: 0
- Action-required rows: 0
- DB Serving Ready rows: 17 (1)
- DB Serving Ready rows excluding terminal holds: 17 (1)
- External index published rows: 0
- Direct KB displayable rows: 17
- Direct KB high-quality-ready rows: 17
- Identity ready rows: 17
- Public commerce doc groups built by dry-run: 17
- Rows with public commerce doc + insight summary: 17
- External index configured: false
- External index required for DB Serving Ready: false

## Active External Seed Rows By Market

| Market | Active rows |
| --- | ---: |
| US | 5764 |
| EU-DE | 50 |
| KR | 12 |
| JP | 10 |

## Main Blockers

| Blocker | Rows |
| --- | ---: |
| db_serving_ready | 17 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| nalacare.com | 8 | 0 | 8 | 1 | 1 | 0 | ready_no_action |
| delicatedaisys.com | 7 | 0 | 7 | 1 | 1 | 0 | ready_no_action |
| joocyee.com | 2 | 0 | 2 | 1 | 1 | 0 | ready_no_action |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 17,
  "by_market": {
    "US": 17
  },
  "by_domain": [
    {
      "key": "nalacare.com",
      "count": 8
    },
    {
      "key": "delicatedaisys.com",
      "count": 7
    },
    {
      "key": "joocyee.com",
      "count": 2
    }
  ],
  "by_product_family": [
    {
      "key": "single_formula",
      "count": 17
    }
  ],
  "coverage": {
    "missing_inci": 0,
    "missing_active_raw": 15,
    "missing_details": 7,
    "missing_how_to": 9,
    "missing_faq": 9
  },
  "pivota_insights": {
    "direct": {
      "displayable": 17,
      "high_quality_ready": 17,
      "missing_kb": 0,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 17,
      "high_quality_ready": 17,
      "missing_kb": 0,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [],
    "effective_issue_domains": [],
    "quality_state": [
      {
        "key": "reviewed",
        "count": 17
      }
    ],
    "evidence_profile": [
      {
        "key": "seller_plus_formula",
        "count": 17
      }
    ],
    "samples": {}
  },
  "active_ingredients": {
    "regulatory_expected": 0,
    "hero_expected": 3,
    "any_active_items": 3,
    "status": [
      {
        "key": "not_expected_missing",
        "count": 14
      },
      {
        "key": "ready_hero",
        "count": 3
      }
    ],
    "issues": [],
    "issue_domains": [],
    "source_origin": [
      {
        "key": "pdp_section",
        "count": 17
      }
    ],
    "samples": {}
  },
  "variants": {
    "status": [
      {
        "key": "no_visible_variant_axis",
        "count": 11
      },
      {
        "key": "ready",
        "count": 6
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
