# KB x Commerce Index Readiness Audit

Generated: 2026-05-28T03:45:15.921Z

Scope: active external seeds, market=US, include_attached=true, limit=20000

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave43_missnella_upcircle_source_recovery_20260528/upcircle_readiness_after_category_patch

## Executive Numbers

- Rows scanned: 11
- Terminal hold rows: 0
- Action-required rows: 0
- DB Serving Ready rows: 11 (1)
- DB Serving Ready rows excluding terminal holds: 11 (1)
- External index published rows: 0
- Direct KB displayable rows: 11
- Direct KB high-quality-ready rows: 11
- Identity ready rows: 11
- Public commerce doc groups built by dry-run: 11
- Rows with public commerce doc + insight summary: 11
- External index configured: false
- External index required for DB Serving Ready: false

## Active External Seed Rows By Market

| Market | Active rows |
| --- | ---: |
| US | 5771 |
| EU-DE | 50 |
| KR | 12 |
| JP | 10 |

## Main Blockers

| Blocker | Rows |
| --- | ---: |
| db_serving_ready | 11 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| upcirclebeauty.com | 11 | 0 | 11 | 1 | 1 | 0 | ready_no_action |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 11,
  "by_market": {
    "US": 11
  },
  "by_domain": [
    {
      "key": "upcirclebeauty.com",
      "count": 11
    }
  ],
  "by_product_family": [
    {
      "key": "single_formula",
      "count": 10
    },
    {
      "key": "unknown_product",
      "count": 1
    }
  ],
  "coverage": {
    "missing_inci": 0,
    "missing_active_raw": 11,
    "missing_details": 0,
    "missing_how_to": 0,
    "missing_faq": 11
  },
  "pivota_insights": {
    "direct": {
      "displayable": 11,
      "high_quality_ready": 11,
      "missing_kb": 0,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 11,
      "high_quality_ready": 11,
      "missing_kb": 0,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [],
    "effective_issue_domains": [],
    "quality_state": [
      {
        "key": "reviewed",
        "count": 11
      }
    ],
    "evidence_profile": [
      {
        "key": "official_pdp_reviewed_limited",
        "count": 8
      },
      {
        "key": "official_pdp_reviewed_key_ingredients",
        "count": 3
      }
    ],
    "samples": {}
  },
  "active_ingredients": {
    "regulatory_expected": 0,
    "hero_expected": 3,
    "any_active_items": 4,
    "status": [
      {
        "key": "not_expected_missing",
        "count": 7
      },
      {
        "key": "ready_hero",
        "count": 3
      },
      {
        "key": "possibly_inci_guess",
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
        "key": "upcirclebeauty.com::possibly_inci_guess",
        "count": 1
      }
    ],
    "source_origin": [
      {
        "key": "pdp_section",
        "count": 8
      },
      {
        "key": "none",
        "count": 2
      },
      {
        "key": "active_block",
        "count": 1
      }
    ],
    "samples": {
      "possibly_inci_guess": [
        {
          "external_product_id": "ext_6815bee1060ef71d9a99ce5b",
          "domain": "upcirclebeauty.com",
          "title": "Cleansing Face Milk with Oat Powder + Aloe Vera",
          "status": "possibly_inci_guess",
          "active_items": [
            "Aloe"
          ],
          "source_origin": "pdp_section"
        }
      ]
    }
  },
  "variants": {
    "status": [
      {
        "key": "flagged",
        "count": 5
      },
      {
        "key": "no_visible_variant_axis",
        "count": 5
      },
      {
        "key": "ready",
        "count": 1
      }
    ],
    "issues": [
      {
        "key": "default_option_size_evidence_missing_axis",
        "count": 5
      }
    ],
    "issue_domains": [
      {
        "key": "upcirclebeauty.com::default_option_size_evidence_missing_axis",
        "count": 5
      }
    ],
    "samples": {
      "default_option_size_evidence_missing_axis": [
        {
          "external_product_id": "ext_714399863bd72a30bcc6259c",
          "domain": "upcirclebeauty.com",
          "title": "RETURN + REFILL Organic Face Oil with Coffee Extract - ON PAUSE",
          "status": "flagged",
          "examples": [
            {
              "axis_name": "default",
              "axis_kind": "volume",
              "value": "RETURN + REFILL Organic Face Oil with Coffee Extract - ON PAUSE",
              "visual": false
            }
          ]
        },
        {
          "external_product_id": "ext_c384be41af865ac0aecd06ed",
          "domain": "upcirclebeauty.com",
          "title": "RETURN + REFILL Shampoo Crème with Pink Berry - ON PAUSE",
          "status": "flagged",
          "examples": [
            {
              "axis_name": "default",
              "axis_kind": "volume",
              "value": "RETURN + REFILL Shampoo Crème with Pink Berry - ON PAUSE",
              "visual": false
            }
          ]
        },
        {
          "external_product_id": "ext_719fa01081b88bf7472f06e1",
          "domain": "upcirclebeauty.com",
          "title": "RETURN + REFILL Eye Cream with Hyaluronic Acid + Coffee - ON PAUSE",
          "status": "flagged",
          "examples": [
            {
              "axis_name": "default",
              "axis_kind": "volume",
              "value": "RETURN + REFILL Eye Cream with Hyaluronic Acid + Coffee - ON PAUSE",
              "visual": false
            }
          ]
        },
        {
          "external_product_id": "ext_96484ace25be03a8f8cb595d",
          "domain": "upcirclebeauty.com",
          "title": "RETURN + REFILL Night Cream with Hyaluronic Acid + Niacinamide - ON PAUSE",
          "status": "flagged",
          "examples": [
            {
              "axis_name": "default",
              "axis_kind": "volume",
              "value": "RETURN + REFILL Night Cream with Hyaluronic Acid + Niacinamide - ON PAUSE",
              "visual": false
            }
          ]
        },
        {
          "external_product_id": "ext_3584983333bdd1568bd59312",
          "domain": "upcirclebeauty.com",
          "title": "RETURN + REFILL Peptide Serum with Custard Apple + Blood Orange - ON PAUSE",
          "status": "flagged",
          "examples": [
            {
              "axis_name": "default",
              "axis_kind": "volume",
              "value": "RETURN + REFILL Peptide Serum with Custard Apple + Blood Orange - ON PAUSE",
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
