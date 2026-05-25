# KB x Commerce Index Readiness Audit

Generated: 2026-05-25T06:31:14.975Z

Scope: active external seeds, market=US, domain=khus-khus.com, include_attached=true, limit=100

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/wave14_khuskhus_direct_pdp_20260525/readiness_after_catalog_sync

## Executive Numbers

- Rows scanned: 8
- Terminal hold rows: 0
- Action-required rows: 8
- DB Serving Ready rows: 0 (0)
- DB Serving Ready rows excluding terminal holds: 0 (0)
- External index published rows: 0
- Direct KB displayable rows: 0
- Direct KB high-quality-ready rows: 0
- Identity ready rows: 8
- Public commerce doc groups built by dry-run: 8
- Rows with public commerce doc + insight summary: 0
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
| kb_missing | 8 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| khus-khus.com | 8 | 0 | 0 | 0 | 0 | 0 | kb_missing |

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
      "displayable": 0,
      "high_quality_ready": 0,
      "missing_kb": 8,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 0,
      "high_quality_ready": 0,
      "missing_kb": 8,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [
      {
        "key": "missing_kb",
        "count": 8
      }
    ],
    "effective_issue_domains": [
      {
        "key": "khus-khus.com::missing_kb",
        "count": 8
      }
    ],
    "quality_state": [
      {
        "key": "missing",
        "count": 8
      }
    ],
    "evidence_profile": [
      {
        "key": "missing",
        "count": 8
      }
    ],
    "samples": {
      "missing_kb": [
        {
          "external_product_id": "ext_290f05b3b8bfbfdb4e079d09",
          "domain": "khus-khus.com",
          "title": "D DROP humectant factor",
          "used_product_id": "ext_290f05b3b8bfbfdb4e079d09",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_45cabf70e20e807f1ea5d63e",
          "domain": "khus-khus.com",
          "title": "THE FIX face potion",
          "used_product_id": "ext_45cabf70e20e807f1ea5d63e",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_4dace0e8a2fe70b378b91c2c",
          "domain": "khus-khus.com",
          "title": "BLEU body serum",
          "used_product_id": "ext_4dace0e8a2fe70b378b91c2c",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_65f9a9219685ffc820a9eee8",
          "domain": "khus-khus.com",
          "title": "C DROPS serum",
          "used_product_id": "ext_65f9a9219685ffc820a9eee8",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_6ae70ce8a0cf2d0f8615d4dc",
          "domain": "khus-khus.com",
          "title": "SURYA body elixir",
          "used_product_id": "ext_6ae70ce8a0cf2d0f8615d4dc",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_b30bcf26cdb534ef9538a3f7",
          "domain": "khus-khus.com",
          "title": "COPIOUS body serum",
          "used_product_id": "ext_b30bcf26cdb534ef9538a3f7",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_f27f918bac908cf6ba236b83",
          "domain": "khus-khus.com",
          "title": "KAI repair balm",
          "used_product_id": "ext_f27f918bac908cf6ba236b83",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_f86a3606bf6dc20fc810f99d",
          "domain": "khus-khus.com",
          "title": "SANS AGE face serum",
          "used_product_id": "ext_f86a3606bf6dc20fc810f99d",
          "quality_state": "missing",
          "evidence_profile": "missing"
        }
      ]
    }
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
