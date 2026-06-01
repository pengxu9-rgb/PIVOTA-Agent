# KB x Commerce Index Readiness Audit

Generated: 2026-06-01T02:45:57.236Z

Scope: active external seeds, market=US, include_attached=true, limit=10

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave112_safe_singletons_product_intel_20260601/readiness_before

## Executive Numbers

- Rows scanned: 3
- Terminal hold rows: 0
- Action-required rows: 2
- DB Serving Ready rows: 1 (0.3333)
- DB Serving Ready rows excluding terminal holds: 1 (0.3333)
- External index published rows: 0
- Direct KB displayable rows: 3
- Direct KB high-quality-ready rows: 1
- Identity ready rows: 3
- Public commerce doc groups built by dry-run: 3
- Rows with public commerce doc + insight summary: 1
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
| kb_blocked | 2 |
| db_serving_ready | 1 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| fableandmane.com | 1 | 0 | 1 | 1 | 1 | 0 | ready_no_action |
| randco.com | 1 | 0 | 0 | 0 | 0 | 0 | kb_blocked |
| sofiepavittface.com | 1 | 0 | 0 | 0 | 0 | 0 | kb_blocked |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 3,
  "by_market": {
    "US": 3
  },
  "by_domain": [
    {
      "key": "fableandmane.com",
      "count": 1
    },
    {
      "key": "randco.com",
      "count": 1
    },
    {
      "key": "sofiepavittface.com",
      "count": 1
    }
  ],
  "by_product_family": [
    {
      "key": "single_formula",
      "count": 3
    }
  ],
  "coverage": {
    "missing_inci": 2,
    "missing_active_raw": 2,
    "missing_details": 2,
    "missing_how_to": 0,
    "missing_faq": 3
  },
  "pivota_insights": {
    "direct": {
      "displayable": 3,
      "high_quality_ready": 1,
      "missing_kb": 0,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 3,
      "high_quality_ready": 1,
      "missing_kb": 0,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [
      {
        "key": "empty_watchouts",
        "count": 2
      },
      {
        "key": "public_sensitive_claim",
        "count": 2
      },
      {
        "key": "missing_card_highlight",
        "count": 1
      },
      {
        "key": "quality_eligible",
        "count": 1
      }
    ],
    "effective_issue_domains": [
      {
        "key": "randco.com::empty_watchouts",
        "count": 1
      },
      {
        "key": "randco.com::public_sensitive_claim",
        "count": 1
      },
      {
        "key": "sofiepavittface.com::empty_watchouts",
        "count": 1
      },
      {
        "key": "sofiepavittface.com::missing_card_highlight",
        "count": 1
      },
      {
        "key": "sofiepavittface.com::public_sensitive_claim",
        "count": 1
      },
      {
        "key": "sofiepavittface.com::quality_eligible",
        "count": 1
      }
    ],
    "quality_state": [
      {
        "key": "eligible",
        "count": 1
      },
      {
        "key": "reviewed",
        "count": 1
      },
      {
        "key": "verified",
        "count": 1
      }
    ],
    "evidence_profile": [
      {
        "key": "seller_plus_formula",
        "count": 2
      },
      {
        "key": "official_pdp_seed",
        "count": 1
      }
    ],
    "samples": {
      "public_sensitive_claim": [
        {
          "external_product_id": "ext_3088e75b19f5e9bd85df5432",
          "domain": "randco.com",
          "title": "ON A CLOUD Bond Building + Repair Styling Oil",
          "used_product_id": "ext_3088e75b19f5e9bd85df5432",
          "quality_state": "verified",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_6c7b1ee909303169dc9c2ee4",
          "domain": "sofiepavittface.com",
          "title": "Omega Rich Moisturizer",
          "used_product_id": "ext_6c7b1ee909303169dc9c2ee4",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
        }
      ],
      "missing_card_highlight": [
        {
          "external_product_id": "ext_6c7b1ee909303169dc9c2ee4",
          "domain": "sofiepavittface.com",
          "title": "Omega Rich Moisturizer",
          "used_product_id": "ext_6c7b1ee909303169dc9c2ee4",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
        }
      ]
    }
  },
  "active_ingredients": {
    "regulatory_expected": 0,
    "hero_expected": 2,
    "any_active_items": 1,
    "status": [
      {
        "key": "missing_hero",
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
    "issues": [
      {
        "key": "missing_hero",
        "count": 1
      }
    ],
    "issue_domains": [
      {
        "key": "randco.com::missing_hero",
        "count": 1
      }
    ],
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
    "samples": {
      "missing_hero": [
        {
          "external_product_id": "ext_3088e75b19f5e9bd85df5432",
          "domain": "randco.com",
          "title": "ON A CLOUD Bond Building + Repair Styling Oil",
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
