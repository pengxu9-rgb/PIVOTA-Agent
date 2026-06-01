# KB x Commerce Index Readiness Audit

Generated: 2026-06-01T03:11:41.939Z

Scope: active external seeds, market=US, include_attached=true, limit=20

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave115_sigmabeauty_continuation_20260601/readiness_before

## Executive Numbers

- Rows scanned: 11
- Terminal hold rows: 0
- Action-required rows: 11
- DB Serving Ready rows: 0 (0)
- DB Serving Ready rows excluding terminal holds: 0 (0)
- External index published rows: 0
- Direct KB displayable rows: 11
- Direct KB high-quality-ready rows: 0
- Identity ready rows: 11
- Public commerce doc groups built by dry-run: 11
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
| kb_blocked | 11 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| sigmabeauty.com | 11 | 0 | 0 | 0 | 0 | 0 | kb_blocked |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 11,
  "by_market": {
    "US": 11
  },
  "by_domain": [
    {
      "key": "sigmabeauty.com",
      "count": 11
    }
  ],
  "by_product_family": [
    {
      "key": "accessory",
      "count": 6
    },
    {
      "key": "set_or_collection",
      "count": 3
    },
    {
      "key": "single_formula",
      "count": 1
    },
    {
      "key": "unknown_product",
      "count": 1
    }
  ],
  "coverage": {
    "missing_inci": 8,
    "missing_active_raw": 1,
    "missing_details": 1,
    "missing_how_to": 1,
    "missing_faq": 11
  },
  "pivota_insights": {
    "direct": {
      "displayable": 11,
      "high_quality_ready": 0,
      "missing_kb": 0,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 11,
      "high_quality_ready": 0,
      "missing_kb": 0,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [
      {
        "key": "public_generic_marketing_copy",
        "count": 10
      },
      {
        "key": "public_sensitive_claim",
        "count": 1
      }
    ],
    "effective_issue_domains": [
      {
        "key": "sigmabeauty.com::public_generic_marketing_copy",
        "count": 10
      },
      {
        "key": "sigmabeauty.com::public_sensitive_claim",
        "count": 1
      }
    ],
    "quality_state": [
      {
        "key": "reviewed",
        "count": 11
      }
    ],
    "evidence_profile": [
      {
        "key": "official_pdp_seed",
        "count": 8
      },
      {
        "key": "seller_plus_formula",
        "count": 3
      }
    ],
    "samples": {
      "public_generic_marketing_copy": [
        {
          "external_product_id": "ext_a5b987fc8aaf5f746b522ada",
          "domain": "sigmabeauty.com",
          "title": "Polish & Perfect Brush Set",
          "used_product_id": "ext_a5b987fc8aaf5f746b522ada",
          "quality_state": "reviewed",
          "evidence_profile": "official_pdp_seed"
        },
        {
          "external_product_id": "ext_f4ca7bdecaa68310675ac54d",
          "domain": "sigmabeauty.com",
          "title": "F26 Domed Concealer Brush",
          "used_product_id": "ext_f4ca7bdecaa68310675ac54d",
          "quality_state": "reviewed",
          "evidence_profile": "official_pdp_seed"
        },
        {
          "external_product_id": "ext_f0c0337789be945a8b85a360",
          "domain": "sigmabeauty.com",
          "title": "Essential Travel Brush Set",
          "used_product_id": "ext_f0c0337789be945a8b85a360",
          "quality_state": "reviewed",
          "evidence_profile": "official_pdp_seed"
        },
        {
          "external_product_id": "ext_2fa17c7f0417769ff2e9abb8",
          "domain": "sigmabeauty.com",
          "title": "Sigma x Face Foundrié Beautiful Base Set",
          "used_product_id": "ext_2fa17c7f0417769ff2e9abb8",
          "quality_state": "reviewed",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_d45ccb74956c1ef9c9637352",
          "domain": "sigmabeauty.com",
          "title": "F08 Precision Powder Brush",
          "used_product_id": "ext_d45ccb74956c1ef9c9637352",
          "quality_state": "reviewed",
          "evidence_profile": "official_pdp_seed"
        },
        {
          "external_product_id": "ext_d1d97a9ff67e0354f391856c",
          "domain": "sigmabeauty.com",
          "title": "F23 Soft Angle Contour™ Brush",
          "used_product_id": "ext_d1d97a9ff67e0354f391856c",
          "quality_state": "reviewed",
          "evidence_profile": "official_pdp_seed"
        },
        {
          "external_product_id": "ext_b96a6d6c33e2547fc31aca0d",
          "domain": "sigmabeauty.com",
          "title": "E28 Detailed Buffer™ Brush",
          "used_product_id": "ext_b96a6d6c33e2547fc31aca0d",
          "quality_state": "reviewed",
          "evidence_profile": "official_pdp_seed"
        },
        {
          "external_product_id": "ext_e09ac3e79003532a24a50e29",
          "domain": "sigmabeauty.com",
          "title": "F81 Blend Kabuki™ Brush",
          "used_product_id": "ext_e09ac3e79003532a24a50e29",
          "quality_state": "reviewed",
          "evidence_profile": "official_pdp_seed"
        },
        {
          "external_product_id": "ext_a17b2f2ec278dd6d32210b21",
          "domain": "sigmabeauty.com",
          "title": "3DHD™ Blender",
          "used_product_id": "ext_a17b2f2ec278dd6d32210b21",
          "quality_state": "reviewed",
          "evidence_profile": "official_pdp_seed"
        },
        {
          "external_product_id": "ext_683bce84d49887a3f4a83038",
          "domain": "sigmabeauty.com",
          "title": "Perfect Brow Set",
          "used_product_id": "ext_683bce84d49887a3f4a83038",
          "quality_state": "reviewed",
          "evidence_profile": "seller_plus_formula"
        }
      ],
      "public_sensitive_claim": [
        {
          "external_product_id": "ext_68f54cb97689f84e81809010",
          "domain": "sigmabeauty.com",
          "title": "Renew Lip Oil",
          "used_product_id": "ext_68f54cb97689f84e81809010",
          "quality_state": "reviewed",
          "evidence_profile": "seller_plus_formula"
        }
      ]
    }
  },
  "active_ingredients": {
    "regulatory_expected": 0,
    "hero_expected": 0,
    "any_active_items": 0,
    "status": [
      {
        "key": "not_applicable_product_family",
        "count": 9
      },
      {
        "key": "not_expected_missing",
        "count": 2
      }
    ],
    "issues": [
      {
        "key": "active_raw_may_be_full_inci",
        "count": 1
      },
      {
        "key": "active_raw_too_long",
        "count": 1
      }
    ],
    "issue_domains": [
      {
        "key": "sigmabeauty.com::active_raw_may_be_full_inci",
        "count": 1
      },
      {
        "key": "sigmabeauty.com::active_raw_too_long",
        "count": 1
      }
    ],
    "source_origin": [
      {
        "key": "none",
        "count": 10
      },
      {
        "key": "pdp_section",
        "count": 1
      }
    ],
    "samples": {
      "active_raw_too_long": [
        {
          "external_product_id": "ext_68f54cb97689f84e81809010",
          "domain": "sigmabeauty.com",
          "title": "Renew Lip Oil",
          "status": "not_expected_missing",
          "active_items": [],
          "source_origin": "pdp_section"
        }
      ],
      "active_raw_may_be_full_inci": [
        {
          "external_product_id": "ext_68f54cb97689f84e81809010",
          "domain": "sigmabeauty.com",
          "title": "Renew Lip Oil",
          "status": "not_expected_missing",
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
        "count": 10
      },
      {
        "key": "no_visible_variant_axis",
        "count": 1
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
