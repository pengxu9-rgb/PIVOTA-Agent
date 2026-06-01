# KB x Commerce Index Readiness Audit

Generated: 2026-06-01T04:47:56.427Z

Scope: active external seeds, market=US, include_attached=true, limit=20000

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave119_next_official_product_intel_20260601/exact_readiness_after_apply

## Executive Numbers

- Rows scanned: 17
- Terminal hold rows: 2
- Action-required rows: 3
- DB Serving Ready rows: 12 (0.7059)
- DB Serving Ready rows excluding terminal holds: 12 (0.8)
- External index published rows: 0
- Direct KB displayable rows: 17
- Direct KB high-quality-ready rows: 17
- Identity ready rows: 16
- Public commerce doc groups built by dry-run: 14
- Rows with public commerce doc + insight summary: 14
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
| db_serving_ready | 12 |
| index_doc_shadow_only | 2 |
| terminal_hold | 2 |
| identity_blocked | 1 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| tirtir.global | 15 | 2 | 12 | 0.8 | 0.9231 | 0 | terminal_hold |
| joocyee.com | 2 | 0 | 0 | 0 | 0 | 0 | index_doc_shadow_only |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 17,
  "by_market": {
    "US": 17
  },
  "by_domain": [
    {
      "key": "tirtir.global",
      "count": 15
    },
    {
      "key": "joocyee.com",
      "count": 2
    }
  ],
  "by_product_family": [
    {
      "key": "single_formula",
      "count": 16
    },
    {
      "key": "set_or_collection",
      "count": 1
    }
  ],
  "coverage": {
    "missing_inci": 0,
    "missing_active_raw": 2,
    "missing_details": 0,
    "missing_how_to": 0,
    "missing_faq": 17
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
        "key": "reviewed",
        "count": 9
      },
      {
        "key": "verified",
        "count": 8
      }
    ],
    "evidence_profile": [
      {
        "key": "official_pdp_reviewed_formula_and_usage",
        "count": 6
      },
      {
        "key": "seller_plus_formula_reviews",
        "count": 5
      },
      {
        "key": "official_pdp_reviewed_key_ingredients_and_usage",
        "count": 2
      },
      {
        "key": "seller_plus_reviews",
        "count": 2
      },
      {
        "key": "community_supported",
        "count": 1
      },
      {
        "key": "seller_plus_formula",
        "count": 1
      }
    ],
    "samples": {}
  },
  "active_ingredients": {
    "regulatory_expected": 0,
    "hero_expected": 13,
    "any_active_items": 14,
    "status": [
      {
        "key": "ready_hero",
        "count": 12
      },
      {
        "key": "not_expected_missing",
        "count": 2
      },
      {
        "key": "possibly_inci_guess",
        "count": 2
      },
      {
        "key": "not_applicable_product_family",
        "count": 1
      }
    ],
    "issues": [
      {
        "key": "possibly_inci_guess",
        "count": 2
      }
    ],
    "issue_domains": [
      {
        "key": "tirtir.global::possibly_inci_guess",
        "count": 2
      }
    ],
    "source_origin": [
      {
        "key": "pdp_section",
        "count": 14
      },
      {
        "key": "active_block",
        "count": 2
      },
      {
        "key": "none",
        "count": 1
      }
    ],
    "samples": {
      "possibly_inci_guess": [
        {
          "external_product_id": "ext_b0c69b8e4b3b439d52f4b8bb",
          "domain": "tirtir.global",
          "title": "Collagen Firming Gel Mask",
          "status": "possibly_inci_guess",
          "active_items": [
            "Hydrolyzed Collagen"
          ],
          "source_origin": "active_block"
        },
        {
          "external_product_id": "ext_4e8c76f135dacc76b2653045",
          "domain": "tirtir.global",
          "title": "Flawless Pore Prep Primer",
          "status": "possibly_inci_guess",
          "active_items": [
            "Guaiazulene",
            "Chamomilla Recutita (Matricaria) Flower Water",
            "Enantia Chlorantha Bark Extract",
            "Silybum Marianum Extract",
            "Zingiber Officinale (Ginger) Root Extract",
            "Mentha Piperita (Peppermint) Leaf Extract"
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
        "count": 16
      },
      {
        "key": "flagged",
        "count": 1
      }
    ],
    "issues": [
      {
        "key": "default_option_size_evidence_missing_axis",
        "count": 1
      }
    ],
    "issue_domains": [
      {
        "key": "joocyee.com::default_option_size_evidence_missing_axis",
        "count": 1
      }
    ],
    "samples": {
      "default_option_size_evidence_missing_axis": [
        {
          "external_product_id": "ext_10d91302e0cbb32d89cb0cb7",
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
