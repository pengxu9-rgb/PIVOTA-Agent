# KB x Commerce Index Readiness Audit

Generated: 2026-05-27T09:26:05.262Z

Scope: active external seeds, market=US, include_attached=true, limit=20000

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave26_joocyee_serving_sync_20260527/readiness_before_serving_sync

## Executive Numbers

- Rows scanned: 17
- Terminal hold rows: 0
- Action-required rows: 17
- DB Serving Ready rows: 0 (0)
- DB Serving Ready rows excluding terminal holds: 0 (0)
- External index published rows: 0
- Direct KB displayable rows: 5
- Direct KB high-quality-ready rows: 5
- Identity ready rows: 17
- Public commerce doc groups built by dry-run: 0
- Rows with public commerce doc + insight summary: 0
- External index configured: false
- External index required for DB Serving Ready: false

## Active External Seed Rows By Market

| Market | Active rows |
| --- | ---: |
| US | 5766 |
| EU-DE | 50 |
| KR | 12 |
| JP | 10 |

## Main Blockers

| Blocker | Rows |
| --- | ---: |
| kb_missing | 12 |
| index_doc_shadow_only | 5 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| joocyee.com | 17 | 0 | 0 | 0 | 0 | 0 | kb_missing |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 17,
  "by_market": {
    "US": 17
  },
  "by_domain": [
    {
      "key": "joocyee.com",
      "count": 17
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
    "missing_active_raw": 0,
    "missing_details": 0,
    "missing_how_to": 0,
    "missing_faq": 17
  },
  "pivota_insights": {
    "direct": {
      "displayable": 5,
      "high_quality_ready": 5,
      "missing_kb": 12,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 17,
      "high_quality_ready": 17,
      "missing_kb": 0,
      "not_displayable": 0,
      "borrowed_from_sibling": 12
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
        "count": 14
      },
      {
        "key": "official_pdp_reviewed_formula_and_usage",
        "count": 3
      }
    ],
    "samples": {
      "borrowed_from_sibling": [
        {
          "external_product_id": "ext_41c98523b6fc0a8279c3095c",
          "domain": "joocyee.com",
          "title": "Glazed Lip Gloss",
          "used_product_id": "ext_bb9685457f5a919c945ee9ce",
          "quality_state": "reviewed",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_8bced3f34a8100c3cfa62377",
          "domain": "joocyee.com",
          "title": "Color-correcting Primer",
          "used_product_id": "ext_794deab047eb4a75225329df",
          "quality_state": "reviewed",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_35ffa71281354a958ef30f7e",
          "domain": "joocyee.com",
          "title": "Glazed Lip Gloss",
          "used_product_id": "ext_bb9685457f5a919c945ee9ce",
          "quality_state": "reviewed",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_3c9980e0455d648c3173c14e",
          "domain": "joocyee.com",
          "title": "Glazed Lip Gloss",
          "used_product_id": "ext_bb9685457f5a919c945ee9ce",
          "quality_state": "reviewed",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_70a0b0b3c68a48630060c7ff",
          "domain": "joocyee.com",
          "title": "Glazed Lip Gloss",
          "used_product_id": "ext_bb9685457f5a919c945ee9ce",
          "quality_state": "reviewed",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_75c1cd3bbad92bbdbc6ab010",
          "domain": "joocyee.com",
          "title": "Glazed Lip Gloss",
          "used_product_id": "ext_bb9685457f5a919c945ee9ce",
          "quality_state": "reviewed",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_4888a0d0940daa58fc77af80",
          "domain": "joocyee.com",
          "title": "Glazed Lip Gloss",
          "used_product_id": "ext_bb9685457f5a919c945ee9ce",
          "quality_state": "reviewed",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_52a27acd606756dea463a717",
          "domain": "joocyee.com",
          "title": "Glazed Lip Gloss",
          "used_product_id": "ext_bb9685457f5a919c945ee9ce",
          "quality_state": "reviewed",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_a9a9d873995dc784e34cb222",
          "domain": "joocyee.com",
          "title": "Glazed Lip Gloss",
          "used_product_id": "ext_bb9685457f5a919c945ee9ce",
          "quality_state": "reviewed",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_c037778265747b32fc52a16c",
          "domain": "joocyee.com",
          "title": "Glazed Lip Gloss",
          "used_product_id": "ext_bb9685457f5a919c945ee9ce",
          "quality_state": "reviewed",
          "evidence_profile": "seller_plus_formula"
        }
      ]
    }
  },
  "active_ingredients": {
    "regulatory_expected": 0,
    "hero_expected": 14,
    "any_active_items": 14,
    "status": [
      {
        "key": "ready_hero",
        "count": 14
      },
      {
        "key": "not_expected_missing",
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
        "key": "ready",
        "count": 14
      },
      {
        "key": "flagged",
        "count": 3
      }
    ],
    "issues": [
      {
        "key": "default_option_size_evidence_missing_axis",
        "count": 3
      }
    ],
    "issue_domains": [
      {
        "key": "joocyee.com::default_option_size_evidence_missing_axis",
        "count": 3
      }
    ],
    "samples": {
      "default_option_size_evidence_missing_axis": [
        {
          "external_product_id": "ext_613e3bbbf834dcce655539b3",
          "domain": "joocyee.com",
          "title": "Dual-Ended Eyebrow Pencil & Cream 2.0",
          "status": "flagged",
          "examples": [
            {
              "axis_name": "default",
              "axis_kind": "volume",
              "value": "2 g",
              "visual": false
            }
          ]
        },
        {
          "external_product_id": "ext_d479efb9a5fafb985e19bd3c",
          "domain": "joocyee.com",
          "title": "Dual-Ended Eyebrow Pencil & Cream 2.0",
          "status": "flagged",
          "examples": [
            {
              "axis_name": "default",
              "axis_kind": "volume",
              "value": "2 g",
              "visual": false
            }
          ]
        },
        {
          "external_product_id": "ext_4fe791cb17f27395a25f91ee",
          "domain": "joocyee.com",
          "title": "Dual-Ended Eyebrow Pencil & Cream 2.0",
          "status": "flagged",
          "examples": [
            {
              "axis_name": "default",
              "axis_kind": "volume",
              "value": "2 g",
              "visual": false
            }
          ]
        }
      ]
    }
  }
}
```

## Notes

- DB Serving Ready is stricter than KB presence. Seller-only or limited evidence is not counted as high-quality pass.
- Commerce dry-run used the same catalog serving document builder with `includeNonPublic=false` and market-filtered source rows derived from `external_product_seeds`; no DB/index writes were attempted.
- A row can have high-quality KB and still fail DB serving readiness if identity or commerce doc hydration does not expose it.
- External index publication is tracked separately and is not a blocker for the current DB-backed serving path.
- Next remediation should start from `gap_backlog.csv` ordered by lane and domain impact.
