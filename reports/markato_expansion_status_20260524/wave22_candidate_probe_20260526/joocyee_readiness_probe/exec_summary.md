# KB x Commerce Index Readiness Audit

Generated: 2026-05-26T01:14:25.698Z

Scope: active external seeds, market=US, domain=joocyee.com, include_attached=true, limit=80

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/wave22_candidate_probe_20260526/joocyee_readiness_probe

## Executive Numbers

- Rows scanned: 18
- Terminal hold rows: 0
- Action-required rows: 18
- DB Serving Ready rows: 0 (0)
- DB Serving Ready rows excluding terminal holds: 0 (0)
- External index published rows: 0
- Direct KB displayable rows: 3
- Direct KB high-quality-ready rows: 3
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
| identity_blocked | 18 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| joocyee.com | 18 | 0 | 0 | 0 | 0 | 0 | identity_blocked |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 18,
  "by_market": {
    "US": 18
  },
  "by_domain": [
    {
      "key": "joocyee.com",
      "count": 18
    }
  ],
  "by_product_family": [
    {
      "key": "single_formula",
      "count": 18
    }
  ],
  "coverage": {
    "missing_inci": 0,
    "missing_active_raw": 1,
    "missing_details": 0,
    "missing_how_to": 0,
    "missing_faq": 18
  },
  "pivota_insights": {
    "direct": {
      "displayable": 3,
      "high_quality_ready": 3,
      "missing_kb": 15,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 3,
      "high_quality_ready": 3,
      "missing_kb": 15,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [
      {
        "key": "missing_kb",
        "count": 15
      }
    ],
    "effective_issue_domains": [
      {
        "key": "joocyee.com::missing_kb",
        "count": 15
      }
    ],
    "quality_state": [
      {
        "key": "missing",
        "count": 15
      },
      {
        "key": "reviewed",
        "count": 3
      }
    ],
    "evidence_profile": [
      {
        "key": "missing",
        "count": 15
      },
      {
        "key": "seller_plus_formula",
        "count": 3
      }
    ],
    "samples": {
      "missing_kb": [
        {
          "external_product_id": "ext_2881559170714581057e21eb",
          "domain": "joocyee.com",
          "title": "Glazed Lip Gloss",
          "used_product_id": "ext_2881559170714581057e21eb",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_35ffa71281354a958ef30f7e",
          "domain": "joocyee.com",
          "title": "Glazed Lip Gloss",
          "used_product_id": "ext_35ffa71281354a958ef30f7e",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_3c9980e0455d648c3173c14e",
          "domain": "joocyee.com",
          "title": "Glazed Lip Gloss",
          "used_product_id": "ext_3c9980e0455d648c3173c14e",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_3ca7c85748b01b4bc8e2f3bb",
          "domain": "joocyee.com",
          "title": "Color-correcting Primer",
          "used_product_id": "ext_3ca7c85748b01b4bc8e2f3bb",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_41c98523b6fc0a8279c3095c",
          "domain": "joocyee.com",
          "title": "Glazed Lip Gloss",
          "used_product_id": "ext_41c98523b6fc0a8279c3095c",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_4888a0d0940daa58fc77af80",
          "domain": "joocyee.com",
          "title": "Glazed Lip Gloss",
          "used_product_id": "ext_4888a0d0940daa58fc77af80",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_4fe791cb17f27395a25f91ee",
          "domain": "joocyee.com",
          "title": "Dual-Ended Eyebrow Pencil & Cream 2.0",
          "used_product_id": "ext_4fe791cb17f27395a25f91ee",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_52a27acd606756dea463a717",
          "domain": "joocyee.com",
          "title": "Glazed Lip Gloss",
          "used_product_id": "ext_52a27acd606756dea463a717",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_613e3bbbf834dcce655539b3",
          "domain": "joocyee.com",
          "title": "Dual-Ended Eyebrow Pencil & Cream 2.0",
          "used_product_id": "ext_613e3bbbf834dcce655539b3",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_70a0b0b3c68a48630060c7ff",
          "domain": "joocyee.com",
          "title": "Glazed Lip Gloss",
          "used_product_id": "ext_70a0b0b3c68a48630060c7ff",
          "quality_state": "missing",
          "evidence_profile": "missing"
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
        "count": 4
      }
    ],
    "issues": [],
    "issue_domains": [],
    "source_origin": [
      {
        "key": "pdp_section",
        "count": 18
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
        "count": 4
      }
    ],
    "issues": [
      {
        "key": "default_option_size_evidence_missing_axis",
        "count": 4
      }
    ],
    "issue_domains": [
      {
        "key": "joocyee.com::default_option_size_evidence_missing_axis",
        "count": 4
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
        },
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
