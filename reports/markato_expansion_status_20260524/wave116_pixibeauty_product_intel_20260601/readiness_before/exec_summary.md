# KB x Commerce Index Readiness Audit

Generated: 2026-06-01T03:11:46.629Z

Scope: active external seeds, market=US, include_attached=true, limit=10

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave116_pixibeauty_product_intel_20260601/readiness_before

## Executive Numbers

- Rows scanned: 3
- Terminal hold rows: 0
- Action-required rows: 3
- DB Serving Ready rows: 0 (0)
- DB Serving Ready rows excluding terminal holds: 0 (0)
- External index published rows: 0
- Direct KB displayable rows: 3
- Direct KB high-quality-ready rows: 0
- Identity ready rows: 3
- Public commerce doc groups built by dry-run: 3
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
| kb_blocked | 3 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| pixibeauty.com | 3 | 0 | 0 | 0 | 0 | 0 | kb_blocked |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 3,
  "by_market": {
    "US": 3
  },
  "by_domain": [
    {
      "key": "pixibeauty.com",
      "count": 3
    }
  ],
  "by_product_family": [
    {
      "key": "unknown_product",
      "count": 2
    },
    {
      "key": "set_or_collection",
      "count": 1
    }
  ],
  "coverage": {
    "missing_inci": 0,
    "missing_active_raw": 0,
    "missing_details": 0,
    "missing_how_to": 0,
    "missing_faq": 3
  },
  "pivota_insights": {
    "direct": {
      "displayable": 3,
      "high_quality_ready": 0,
      "missing_kb": 0,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 3,
      "high_quality_ready": 0,
      "missing_kb": 0,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [
      {
        "key": "public_generic_marketing_copy",
        "count": 3
      },
      {
        "key": "public_truncated_copy",
        "count": 3
      }
    ],
    "effective_issue_domains": [
      {
        "key": "pixibeauty.com::public_generic_marketing_copy",
        "count": 3
      },
      {
        "key": "pixibeauty.com::public_truncated_copy",
        "count": 3
      }
    ],
    "quality_state": [
      {
        "key": "reviewed",
        "count": 3
      }
    ],
    "evidence_profile": [
      {
        "key": "seller_plus_formula",
        "count": 3
      }
    ],
    "samples": {
      "public_truncated_copy": [
        {
          "external_product_id": "ext_ce06dc6cf523109b638508e1",
          "domain": "pixibeauty.com",
          "title": "Ultimate BASE Bundle",
          "used_product_id": "ext_ce06dc6cf523109b638508e1",
          "quality_state": "reviewed",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_b608b51bc66708d27e81473e",
          "domain": "pixibeauty.com",
          "title": "Complexion Collection",
          "used_product_id": "ext_b608b51bc66708d27e81473e",
          "quality_state": "reviewed",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_e36414c7892f92c40d7f6026",
          "domain": "pixibeauty.com",
          "title": "Ultimate Complexion Besties",
          "used_product_id": "ext_e36414c7892f92c40d7f6026",
          "quality_state": "reviewed",
          "evidence_profile": "seller_plus_formula"
        }
      ],
      "public_generic_marketing_copy": [
        {
          "external_product_id": "ext_ce06dc6cf523109b638508e1",
          "domain": "pixibeauty.com",
          "title": "Ultimate BASE Bundle",
          "used_product_id": "ext_ce06dc6cf523109b638508e1",
          "quality_state": "reviewed",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_b608b51bc66708d27e81473e",
          "domain": "pixibeauty.com",
          "title": "Complexion Collection",
          "used_product_id": "ext_b608b51bc66708d27e81473e",
          "quality_state": "reviewed",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_e36414c7892f92c40d7f6026",
          "domain": "pixibeauty.com",
          "title": "Ultimate Complexion Besties",
          "used_product_id": "ext_e36414c7892f92c40d7f6026",
          "quality_state": "reviewed",
          "evidence_profile": "seller_plus_formula"
        }
      ]
    }
  },
  "active_ingredients": {
    "regulatory_expected": 0,
    "hero_expected": 2,
    "any_active_items": 2,
    "status": [
      {
        "key": "ready_hero",
        "count": 2
      },
      {
        "key": "not_applicable_product_family",
        "count": 1
      }
    ],
    "issues": [
      {
        "key": "active_raw_may_be_full_inci",
        "count": 2
      }
    ],
    "issue_domains": [
      {
        "key": "pixibeauty.com::active_raw_may_be_full_inci",
        "count": 2
      }
    ],
    "source_origin": [
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
      "active_raw_may_be_full_inci": [
        {
          "external_product_id": "ext_b608b51bc66708d27e81473e",
          "domain": "pixibeauty.com",
          "title": "Complexion Collection",
          "status": "ready_hero",
          "active_items": [
            "Ceramide NP"
          ],
          "source_origin": "active_block"
        },
        {
          "external_product_id": "ext_e36414c7892f92c40d7f6026",
          "domain": "pixibeauty.com",
          "title": "Ultimate Complexion Besties",
          "status": "ready_hero",
          "active_items": [
            "Ceramide NP"
          ],
          "source_origin": "active_block"
        }
      ]
    }
  },
  "variants": {
    "status": [
      {
        "key": "ready",
        "count": 3
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
