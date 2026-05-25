# KB x Commerce Index Readiness Audit

Generated: 2026-05-25T09:22:52.620Z

Scope: active external seeds, market=US, domain=lucamarskincare.com, include_attached=true, limit=20

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/wave16_lucamar_remainder_20260525/readiness_after_product_intel

## Executive Numbers

- Rows scanned: 5
- Terminal hold rows: 0
- Action-required rows: 2
- DB Serving Ready rows: 3 (0.6)
- DB Serving Ready rows excluding terminal holds: 3 (0.6)
- External index published rows: 0
- Direct KB displayable rows: 5
- Direct KB high-quality-ready rows: 5
- Identity ready rows: 5
- Public commerce doc groups built by dry-run: 3
- Rows with public commerce doc + insight summary: 3
- External index configured: false
- External index required for DB Serving Ready: false

## Active External Seed Rows By Market

| Market | Active rows |
| --- | ---: |
| US | 5738 |
| EU-DE | 50 |
| KR | 12 |
| JP | 10 |

## Main Blockers

| Blocker | Rows |
| --- | ---: |
| db_serving_ready | 3 |
| seed_content_blocked | 2 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| lucamarskincare.com | 5 | 0 | 3 | 0.6 | 0.6 | 0 | seed_content_blocked |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 5,
  "by_market": {
    "US": 5
  },
  "by_domain": [
    {
      "key": "lucamarskincare.com",
      "count": 5
    }
  ],
  "by_product_family": [
    {
      "key": "single_formula",
      "count": 3
    },
    {
      "key": "unknown_product",
      "count": 2
    }
  ],
  "coverage": {
    "missing_inci": 1,
    "missing_active_raw": 5,
    "missing_details": 0,
    "missing_how_to": 0,
    "missing_faq": 5
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
        "count": 4
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
    "hero_expected": 5,
    "any_active_items": 0,
    "status": [
      {
        "key": "missing_hero",
        "count": 5
      }
    ],
    "issues": [
      {
        "key": "missing_hero",
        "count": 5
      }
    ],
    "issue_domains": [
      {
        "key": "lucamarskincare.com::missing_hero",
        "count": 5
      }
    ],
    "source_origin": [
      {
        "key": "none",
        "count": 5
      }
    ],
    "samples": {
      "missing_hero": [
        {
          "external_product_id": "ext_05c5a41a67fb37dcf352853e",
          "domain": "lucamarskincare.com",
          "title": "Lucamar Baalm 50g",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "none"
        },
        {
          "external_product_id": "ext_065337312a937f0f26d50865",
          "domain": "lucamarskincare.com",
          "title": "Lucamar Baalm 50g  UNSCENTED",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "none"
        },
        {
          "external_product_id": "ext_0836525e72365da8ecbcc3b5",
          "domain": "lucamarskincare.com",
          "title": "Baa Ram Ewe  Lanolin Skin Balm  120g",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "none"
        },
        {
          "external_product_id": "ext_c26547ca63d530592ed62d63",
          "domain": "lucamarskincare.com",
          "title": "Baa Ram Ewe  Lanolin Skin Balm  120g UNSCENTED",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "none"
        },
        {
          "external_product_id": "ext_edcf7e510314384ac432b385",
          "domain": "lucamarskincare.com",
          "title": "Baa Ram Ewe Lanolin Skin Balm 50g",
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
