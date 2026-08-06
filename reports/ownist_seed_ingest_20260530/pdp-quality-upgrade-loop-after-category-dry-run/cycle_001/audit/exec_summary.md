# KB x Commerce Index Readiness Audit

Generated: 2026-05-30T10:46:50.225Z

Scope: active external seeds, market=US, include_attached=true, limit=4

Report directory: /Users/pengchydan/dev/PIVOTA-Agent/reports/ownist_seed_ingest_20260530/pdp-quality-upgrade-loop-after-category-dry-run/cycle_001/audit

## Executive Numbers

- Rows scanned: 4
- Terminal hold rows: 0
- Action-required rows: 4
- DB Serving Ready rows: 0 (0)
- DB Serving Ready rows excluding terminal holds: 0 (0)
- External index published rows: 0
- Direct KB displayable rows: 0
- Direct KB high-quality-ready rows: 0
- Identity ready rows: 4
- Public commerce doc groups built by dry-run: 4
- Rows with public commerce doc + insight summary: 0
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
| kb_missing | 4 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| ownist.com | 4 | 0 | 0 | 0 | 0 | 0 | kb_missing |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 4,
  "by_market": {
    "US": 4
  },
  "by_domain": [
    {
      "key": "ownist.com",
      "count": 4
    }
  ],
  "by_product_family": [
    {
      "key": "set_or_collection",
      "count": 2
    },
    {
      "key": "unknown_product",
      "count": 2
    }
  ],
  "coverage": {
    "missing_inci": 4,
    "missing_active_raw": 2,
    "missing_details": 4,
    "missing_how_to": 4,
    "missing_faq": 4
  },
  "pivota_insights": {
    "direct": {
      "displayable": 0,
      "high_quality_ready": 0,
      "missing_kb": 4,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 0,
      "high_quality_ready": 0,
      "missing_kb": 4,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [
      {
        "key": "missing_kb",
        "count": 4
      }
    ],
    "effective_issue_domains": [
      {
        "key": "ownist.com::missing_kb",
        "count": 4
      }
    ],
    "quality_state": [
      {
        "key": "missing",
        "count": 4
      }
    ],
    "evidence_profile": [
      {
        "key": "missing",
        "count": 4
      }
    ],
    "samples": {
      "missing_kb": [
        {
          "external_product_id": "ext_8b6bcbe031a743c1e607aa6a",
          "domain": "ownist.com",
          "title": "Triple Shine Grape",
          "used_product_id": "ext_8b6bcbe031a743c1e607aa6a",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_52e9fce8bee97af26d6f77db",
          "domain": "ownist.com",
          "title": "Triple Collagen Orange",
          "used_product_id": "ext_52e9fce8bee97af26d6f77db",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_3dab0df3312e80e8dac97452",
          "domain": "ownist.com",
          "title": "Triple Shine Garden edition",
          "used_product_id": "ext_3dab0df3312e80e8dac97452",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_3b2f5eaa044e309bf442a047",
          "domain": "ownist.com",
          "title": "Triple Collagen Garden edition",
          "used_product_id": "ext_3b2f5eaa044e309bf442a047",
          "quality_state": "missing",
          "evidence_profile": "missing"
        }
      ]
    }
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
        "key": "ownist.com::missing_hero",
        "count": 2
      }
    ],
    "source_origin": [
      {
        "key": "none",
        "count": 4
      }
    ],
    "samples": {
      "missing_hero": [
        {
          "external_product_id": "ext_8b6bcbe031a743c1e607aa6a",
          "domain": "ownist.com",
          "title": "Triple Shine Grape",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "none"
        },
        {
          "external_product_id": "ext_52e9fce8bee97af26d6f77db",
          "domain": "ownist.com",
          "title": "Triple Collagen Orange",
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
        "key": "no_visible_variant_axis",
        "count": 4
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
