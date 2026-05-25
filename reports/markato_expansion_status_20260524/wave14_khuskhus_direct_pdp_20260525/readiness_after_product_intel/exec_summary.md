# KB x Commerce Index Readiness Audit

Generated: 2026-05-25T06:41:51.539Z

Scope: active external seeds, market=US, domain=khus-khus.com, include_attached=true, limit=100

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/wave14_khuskhus_direct_pdp_20260525/readiness_after_product_intel

## Executive Numbers

- Rows scanned: 8
- Terminal hold rows: 0
- Action-required rows: 0
- DB Serving Ready rows: 8 (1)
- DB Serving Ready rows excluding terminal holds: 8 (1)
- External index published rows: 0
- Direct KB displayable rows: 8
- Direct KB high-quality-ready rows: 8
- Identity ready rows: 8
- Public commerce doc groups built by dry-run: 8
- Rows with public commerce doc + insight summary: 8
- External index configured: false
- External index required for DB Serving Ready: false

## Active External Seed Rows By Market

| Market | Active rows |
| --- | ---: |
| US | 5730 |
| EU-DE | 50 |
| KR | 12 |
| JP | 10 |

## Main Blockers

| Blocker | Rows |
| --- | ---: |
| db_serving_ready | 8 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| khus-khus.com | 8 | 0 | 8 | 1 | 1 | 0 | ready_no_action |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 8,
  "by_market": {
    "US": 8
  },
  "by_domain": [
    {
      "key": "khus-khus.com",
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
    "missing_inci": 0,
    "missing_active_raw": 8,
    "missing_details": 0,
    "missing_how_to": 0,
    "missing_faq": 8
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
        "key": "seller_plus_formula",
        "count": 8
      }
    ],
    "samples": {}
  },
  "active_ingredients": {
    "regulatory_expected": 0,
    "hero_expected": 7,
    "any_active_items": 0,
    "status": [
      {
        "key": "missing_hero",
        "count": 7
      },
      {
        "key": "not_expected_missing",
        "count": 1
      }
    ],
    "issues": [
      {
        "key": "missing_hero",
        "count": 7
      }
    ],
    "issue_domains": [
      {
        "key": "khus-khus.com::missing_hero",
        "count": 7
      }
    ],
    "source_origin": [
      {
        "key": "pdp_section",
        "count": 8
      }
    ],
    "samples": {
      "missing_hero": [
        {
          "external_product_id": "ext_45cabf70e20e807f1ea5d63e",
          "domain": "khus-khus.com",
          "title": "THE FIX face potion",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_4dace0e8a2fe70b378b91c2c",
          "domain": "khus-khus.com",
          "title": "BLEU body serum",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_65f9a9219685ffc820a9eee8",
          "domain": "khus-khus.com",
          "title": "C DROPS serum",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_6ae70ce8a0cf2d0f8615d4dc",
          "domain": "khus-khus.com",
          "title": "SURYA body elixir",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_b30bcf26cdb534ef9538a3f7",
          "domain": "khus-khus.com",
          "title": "COPIOUS body serum",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_f27f918bac908cf6ba236b83",
          "domain": "khus-khus.com",
          "title": "KAI repair balm",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_f86a3606bf6dc20fc810f99d",
          "domain": "khus-khus.com",
          "title": "SANS AGE face serum",
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
