# KB x Commerce Index Readiness Audit

Generated: 2026-05-26T01:17:29.714Z

Scope: active external seeds, market=US, domain=nalacare.com, include_attached=true, limit=80

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/wave22_candidate_probe_20260526/nalacare_readiness_probe

## Executive Numbers

- Rows scanned: 10
- Terminal hold rows: 0
- Action-required rows: 10
- DB Serving Ready rows: 0 (0)
- DB Serving Ready rows excluding terminal holds: 0 (0)
- External index published rows: 0
- Direct KB displayable rows: 10
- Direct KB high-quality-ready rows: 10
- Identity ready rows: 0
- Public commerce doc groups built by dry-run: 0
- Rows with public commerce doc + insight summary: 0
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
| identity_blocked | 10 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| nalacare.com | 10 | 0 | 0 | 0 | 0 | 0 | identity_blocked |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 10,
  "by_market": {
    "US": 10
  },
  "by_domain": [
    {
      "key": "nalacare.com",
      "count": 10
    }
  ],
  "by_product_family": [
    {
      "key": "single_formula",
      "count": 10
    }
  ],
  "coverage": {
    "missing_inci": 0,
    "missing_active_raw": 10,
    "missing_details": 0,
    "missing_how_to": 10,
    "missing_faq": 0
  },
  "pivota_insights": {
    "direct": {
      "displayable": 10,
      "high_quality_ready": 10,
      "missing_kb": 0,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 10,
      "high_quality_ready": 10,
      "missing_kb": 0,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [],
    "effective_issue_domains": [],
    "quality_state": [
      {
        "key": "reviewed",
        "count": 10
      }
    ],
    "evidence_profile": [
      {
        "key": "seller_plus_formula",
        "count": 9
      },
      {
        "key": "official_pdp_seed",
        "count": 1
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
        "count": 8
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
        "key": "nalacare.com::missing_hero",
        "count": 2
      }
    ],
    "source_origin": [
      {
        "key": "pdp_section",
        "count": 10
      }
    ],
    "samples": {
      "missing_hero": [
        {
          "external_product_id": "ext_66e7e115c711d23c6f9094ee",
          "domain": "nalacare.com",
          "title": "Peach & Chamomile, Extra Strength Natural Deodorant",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_d895a41b4cbb77184f3de655",
          "domain": "nalacare.com",
          "title": "Breast Oil",
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
        "count": 5
      },
      {
        "key": "ready",
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
