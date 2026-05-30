# KB x Commerce Index Readiness Audit

Generated: 2026-05-30T02:06:52.409Z

Scope: active external seeds, market=US, include_attached=true, limit=20000

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave72_mossnoor_source_gap_probe_20260530/readiness_before_source_probe

## Executive Numbers

- Rows scanned: 8
- Terminal hold rows: 0
- Action-required rows: 8
- DB Serving Ready rows: 0 (0)
- DB Serving Ready rows excluding terminal holds: 0 (0)
- External index published rows: 0
- Direct KB displayable rows: 8
- Direct KB high-quality-ready rows: 8
- Identity ready rows: 0
- Public commerce doc groups built by dry-run: 0
- Rows with public commerce doc + insight summary: 0
- External index configured: false
- External index required for DB Serving Ready: false

## Active External Seed Rows By Market

| Market | Active rows |
| --- | ---: |
| US | 5770 |
| EU-DE | 50 |
| KR | 12 |
| JP | 10 |

## Main Blockers

| Blocker | Rows |
| --- | ---: |
| identity_blocked | 8 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| mossnoor.com | 8 | 0 | 0 | 0 | 0 | 0 | identity_blocked |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 8,
  "by_market": {
    "US": 8
  },
  "by_domain": [
    {
      "key": "mossnoor.com",
      "count": 8
    }
  ],
  "by_product_family": [
    {
      "key": "single_formula",
      "count": 8
    }
  ],
  "coverage": {
    "missing_inci": 2,
    "missing_active_raw": 8,
    "missing_details": 8,
    "missing_how_to": 8,
    "missing_faq": 0
  },
  "pivota_insights": {
    "direct": {
      "displayable": 8,
      "high_quality_ready": 8,
      "missing_kb": 0,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 8,
      "high_quality_ready": 8,
      "missing_kb": 0,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [],
    "effective_issue_domains": [],
    "quality_state": [
      {
        "key": "reviewed",
        "count": 8
      }
    ],
    "evidence_profile": [
      {
        "key": "official_pdp_seed",
        "count": 8
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
        "key": "not_expected_missing",
        "count": 6
      },
      {
        "key": "missing_hero",
        "count": 2
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
        "key": "mossnoor.com::missing_hero",
        "count": 2
      }
    ],
    "source_origin": [
      {
        "key": "reviewed_source_backed_pdp_content_patch",
        "count": 5
      },
      {
        "key": "none",
        "count": 3
      }
    ],
    "samples": {
      "missing_hero": [
        {
          "external_product_id": "ext_fef6fb32a26319fb95c750ab",
          "domain": "mossnoor.com",
          "title": "Hand Wash - Fresh Grapefruit",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "none"
        },
        {
          "external_product_id": "ext_2ceae3f0084e576134f4c1eb",
          "domain": "mossnoor.com",
          "title": "Hand Wash - Crispy Cucumber",
          "status": "missing_hero",
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
        "count": 8
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
