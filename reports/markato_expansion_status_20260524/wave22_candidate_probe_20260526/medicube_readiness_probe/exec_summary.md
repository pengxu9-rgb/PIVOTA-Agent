# KB x Commerce Index Readiness Audit

Generated: 2026-05-26T01:14:18.879Z

Scope: active external seeds, market=US, domain=medicube.us, include_attached=true, limit=80

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/wave22_candidate_probe_20260526/medicube_readiness_probe

## Executive Numbers

- Rows scanned: 17
- Terminal hold rows: 0
- Action-required rows: 3
- DB Serving Ready rows: 14 (0.8235)
- DB Serving Ready rows excluding terminal holds: 14 (0.8235)
- External index published rows: 0
- Direct KB displayable rows: 17
- Direct KB high-quality-ready rows: 17
- Identity ready rows: 14
- Public commerce doc groups built by dry-run: 14
- Rows with public commerce doc + insight summary: 14
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
| db_serving_ready | 14 |
| identity_blocked | 3 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| medicube.us | 17 | 0 | 14 | 0.8235 | 0.8235 | 0 | identity_blocked |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 17,
  "by_market": {
    "US": 17
  },
  "by_domain": [
    {
      "key": "medicube.us",
      "count": 17
    }
  ],
  "by_product_family": [
    {
      "key": "single_formula",
      "count": 13
    },
    {
      "key": "set_or_collection",
      "count": 4
    }
  ],
  "coverage": {
    "missing_inci": 0,
    "missing_active_raw": 0,
    "missing_details": 0,
    "missing_how_to": 0,
    "missing_faq": 15
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
        "key": "verified",
        "count": 17
      }
    ],
    "evidence_profile": [
      {
        "key": "seller_plus_formula_reviews",
        "count": 12
      },
      {
        "key": "seller_plus_formula",
        "count": 5
      }
    ],
    "samples": {}
  },
  "active_ingredients": {
    "regulatory_expected": 0,
    "hero_expected": 12,
    "any_active_items": 13,
    "status": [
      {
        "key": "ready_hero",
        "count": 11
      },
      {
        "key": "not_applicable_product_family",
        "count": 4
      },
      {
        "key": "possibly_inci_guess",
        "count": 1
      },
      {
        "key": "ready_other",
        "count": 1
      }
    ],
    "issues": [
      {
        "key": "possibly_inci_guess",
        "count": 1
      }
    ],
    "issue_domains": [
      {
        "key": "medicube.us::possibly_inci_guess",
        "count": 1
      }
    ],
    "source_origin": [
      {
        "key": "pdp_section",
        "count": 13
      },
      {
        "key": "none",
        "count": 4
      }
    ],
    "samples": {
      "possibly_inci_guess": [
        {
          "external_product_id": "ext_bdeaac19241ab0f35520a3a0",
          "domain": "medicube.us",
          "title": "Booster Gel Serum",
          "status": "possibly_inci_guess",
          "active_items": [
            "Plant Stem Cell Extract"
          ],
          "source_origin": "pdp_section"
        }
      ]
    }
  },
  "variants": {
    "status": [
      {
        "key": "ready",
        "count": 17
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
