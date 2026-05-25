# KB x Commerce Index Readiness Audit

Generated: 2026-05-25T04:17:35.961Z

Scope: active external seeds, market=US, domain=apiceuticals.com, include_attached=true, limit=10

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/wave12_apiceuticals_batch_20260525/readiness_after_product_intel_apply

## Executive Numbers

- Rows scanned: 5
- Terminal hold rows: 0
- Action-required rows: 0
- DB Serving Ready rows: 5 (1)
- DB Serving Ready rows excluding terminal holds: 5 (1)
- External index published rows: 0
- Direct KB displayable rows: 5
- Direct KB high-quality-ready rows: 5
- Identity ready rows: 5
- Public commerce doc groups built by dry-run: 5
- Rows with public commerce doc + insight summary: 5
- External index configured: false
- External index required for DB Serving Ready: false

## Active External Seed Rows By Market

| Market | Active rows |
| --- | ---: |
| US | 5718 |
| EU-DE | 50 |
| KR | 12 |
| JP | 10 |

## Main Blockers

| Blocker | Rows |
| --- | ---: |
| db_serving_ready | 5 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| apiceuticals.com | 5 | 0 | 5 | 1 | 1 | 0 | ready_no_action |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 5,
  "by_market": {
    "US": 5
  },
  "by_domain": [
    {
      "key": "apiceuticals.com",
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
    "missing_inci": 0,
    "missing_active_raw": 1,
    "missing_details": 0,
    "missing_how_to": 0,
    "missing_faq": 0
  },
  "pivota_insights": {
    "direct": {
      "displayable": 5,
      "high_quality_ready": 5,
      "missing_kb": 0,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 5,
      "high_quality_ready": 5,
      "missing_kb": 0,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [],
    "effective_issue_domains": [],
    "quality_state": [
      {
        "key": "reviewed",
        "count": 5
      }
    ],
    "evidence_profile": [
      {
        "key": "seller_plus_formula",
        "count": 5
      }
    ],
    "samples": {}
  },
  "active_ingredients": {
    "regulatory_expected": 0,
    "hero_expected": 4,
    "any_active_items": 0,
    "status": [
      {
        "key": "low_signal_active",
        "count": 4
      },
      {
        "key": "missing_hero",
        "count": 1
      }
    ],
    "issues": [
      {
        "key": "low_signal_active",
        "count": 4
      },
      {
        "key": "missing_hero",
        "count": 1
      }
    ],
    "issue_domains": [
      {
        "key": "apiceuticals.com::low_signal_active",
        "count": 4
      },
      {
        "key": "apiceuticals.com::missing_hero",
        "count": 1
      }
    ],
    "source_origin": [
      {
        "key": "pdp_section",
        "count": 5
      }
    ],
    "samples": {
      "low_signal_active": [
        {
          "external_product_id": "ext_1e27467ab07ddb83ad74c213",
          "domain": "apiceuticals.com",
          "title": "PROPOWAX™ Antioxidant Shampoo 300ml",
          "status": "low_signal_active",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_4e95b920b4c6a5295d55aa46",
          "domain": "apiceuticals.com",
          "title": "PROPOWAX™ Antioxidant Conditioner 300ml",
          "status": "low_signal_active",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_c0e5209513c083e2c649c1a1",
          "domain": "apiceuticals.com",
          "title": "PROPOWAX™ Antioxidant Body Lotion 300ml",
          "status": "low_signal_active",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_d17dfc05f98d0400d5129f1c",
          "domain": "apiceuticals.com",
          "title": "PROPOWAX™ Antioxidant Shower Gel 300ml",
          "status": "low_signal_active",
          "active_items": [],
          "source_origin": "pdp_section"
        }
      ],
      "missing_hero": [
        {
          "external_product_id": "ext_d3d708f481903ba2a6f9b732",
          "domain": "apiceuticals.com",
          "title": "PROPOWAX™ Antioxidant Dry Oil 100ml",
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
