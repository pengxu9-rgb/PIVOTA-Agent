# KB x Commerce Index Readiness Audit

Generated: 2026-06-01T07:09:18.695Z

Scope: active external seeds, market=US, include_attached=true, limit=20000

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave121_next_official_product_intel_20260601/exact_readiness_after_apply

## Executive Numbers

- Rows scanned: 14
- Terminal hold rows: 0
- Action-required rows: 3
- DB Serving Ready rows: 11 (0.7857)
- DB Serving Ready rows excluding terminal holds: 11 (0.7857)
- External index published rows: 0
- Direct KB displayable rows: 14
- Direct KB high-quality-ready rows: 14
- Identity ready rows: 13
- Public commerce doc groups built by dry-run: 11
- Rows with public commerce doc + insight summary: 11
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
| db_serving_ready | 11 |
| index_doc_shadow_only | 2 |
| identity_blocked | 1 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| tirtir.global | 11 | 0 | 10 | 0.9091 | 0.9091 | 0 | identity_blocked |
| baiebotanique.com | 3 | 0 | 1 | 0.3333 | 0.3333 | 0 | index_doc_shadow_only |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 14,
  "by_market": {
    "US": 14
  },
  "by_domain": [
    {
      "key": "tirtir.global",
      "count": 11
    },
    {
      "key": "baiebotanique.com",
      "count": 3
    }
  ],
  "by_product_family": [
    {
      "key": "single_formula",
      "count": 14
    }
  ],
  "coverage": {
    "missing_inci": 0,
    "missing_active_raw": 10,
    "missing_details": 0,
    "missing_how_to": 1,
    "missing_faq": 14
  },
  "pivota_insights": {
    "direct": {
      "displayable": 14,
      "high_quality_ready": 14,
      "missing_kb": 0,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 14,
      "high_quality_ready": 14,
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
        "count": 5
      }
    ],
    "evidence_profile": [
      {
        "key": "official_pdp_reviewed_formula_and_usage",
        "count": 7
      },
      {
        "key": "seller_plus_reviews",
        "count": 3
      },
      {
        "key": "community_supported",
        "count": 1
      },
      {
        "key": "official_pdp_reviewed_formula",
        "count": 1
      },
      {
        "key": "seller_plus_formula",
        "count": 1
      },
      {
        "key": "seller_plus_formula_reviews",
        "count": 1
      }
    ],
    "samples": {}
  },
  "active_ingredients": {
    "regulatory_expected": 0,
    "hero_expected": 6,
    "any_active_items": 5,
    "status": [
      {
        "key": "not_expected_missing",
        "count": 6
      },
      {
        "key": "missing_hero",
        "count": 3
      },
      {
        "key": "ready_hero",
        "count": 3
      },
      {
        "key": "possibly_inci_guess",
        "count": 1
      },
      {
        "key": "ready_other",
        "count": 1
      }
    ],
    "issues": [
      {
        "key": "missing_hero",
        "count": 3
      },
      {
        "key": "possibly_inci_guess",
        "count": 1
      }
    ],
    "issue_domains": [
      {
        "key": "baiebotanique.com::missing_hero",
        "count": 3
      },
      {
        "key": "tirtir.global::possibly_inci_guess",
        "count": 1
      }
    ],
    "source_origin": [
      {
        "key": "pdp_section",
        "count": 14
      }
    ],
    "samples": {
      "missing_hero": [
        {
          "external_product_id": "ext_f11383c339335d64f05a964e",
          "domain": "baiebotanique.com",
          "title": "Regenerating Eye Cream",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_60ded78effb04e9d6389bfce",
          "domain": "baiebotanique.com",
          "title": "Rose & Cupuaçu Enzyme Cleanser",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_1d312f4c2dac999920d9b936",
          "domain": "baiebotanique.com",
          "title": "Rose Renew Face Wash",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "pdp_section"
        }
      ],
      "possibly_inci_guess": [
        {
          "external_product_id": "ext_2ed925c42fe7f2dfd73f98db",
          "domain": "tirtir.global",
          "title": "Matcha Tea Pads",
          "status": "possibly_inci_guess",
          "active_items": [
            "PDRN"
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
        "count": 14
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
