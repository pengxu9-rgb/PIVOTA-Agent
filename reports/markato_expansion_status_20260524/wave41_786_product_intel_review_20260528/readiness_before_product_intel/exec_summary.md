# KB x Commerce Index Readiness Audit

Generated: 2026-05-28T02:56:06.554Z

Scope: active external seeds, market=US, include_attached=true, limit=20000

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave41_786_product_intel_review_20260528/readiness_before_product_intel

## Executive Numbers

- Rows scanned: 16
- Terminal hold rows: 0
- Action-required rows: 16
- DB Serving Ready rows: 0 (0)
- DB Serving Ready rows excluding terminal holds: 0 (0)
- External index published rows: 0
- Direct KB displayable rows: 16
- Direct KB high-quality-ready rows: 0
- Identity ready rows: 16
- Public commerce doc groups built by dry-run: 16
- Rows with public commerce doc + insight summary: 0
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
| seed_content_blocked | 16 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 786cosmetics.com | 16 | 0 | 0 | 0 | 0 | 0 | seed_content_blocked |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 16,
  "by_market": {
    "US": 16
  },
  "by_domain": [
    {
      "key": "786cosmetics.com",
      "count": 16
    }
  ],
  "by_product_family": [
    {
      "key": "unknown_product",
      "count": 15
    },
    {
      "key": "non_merch",
      "count": 1
    }
  ],
  "coverage": {
    "missing_inci": 0,
    "missing_active_raw": 15,
    "missing_details": 0,
    "missing_how_to": 0,
    "missing_faq": 16
  },
  "pivota_insights": {
    "direct": {
      "displayable": 16,
      "high_quality_ready": 0,
      "missing_kb": 0,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 16,
      "high_quality_ready": 0,
      "missing_kb": 0,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [
      {
        "key": "quality_limited",
        "count": 16
      },
      {
        "key": "seller_only_evidence",
        "count": 16
      },
      {
        "key": "empty_watchouts",
        "count": 15
      },
      {
        "key": "ellipsis_or_truncated",
        "count": 7
      },
      {
        "key": "public_truncated_copy",
        "count": 7
      }
    ],
    "effective_issue_domains": [
      {
        "key": "786cosmetics.com::quality_limited",
        "count": 16
      },
      {
        "key": "786cosmetics.com::seller_only_evidence",
        "count": 16
      },
      {
        "key": "786cosmetics.com::empty_watchouts",
        "count": 15
      },
      {
        "key": "786cosmetics.com::ellipsis_or_truncated",
        "count": 7
      },
      {
        "key": "786cosmetics.com::public_truncated_copy",
        "count": 7
      }
    ],
    "quality_state": [
      {
        "key": "limited",
        "count": 16
      }
    ],
    "evidence_profile": [
      {
        "key": "seller_only",
        "count": 16
      }
    ],
    "samples": {
      "ellipsis_or_truncated": [
        {
          "external_product_id": "ext_9a469b8f450d59f67ae21f6d",
          "domain": "786cosmetics.com",
          "title": "Paris - Breathable Nail Polish",
          "used_product_id": "ext_9a469b8f450d59f67ae21f6d",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_45293e532ad5a5f33438d38f",
          "domain": "786cosmetics.com",
          "title": "Nizwa - Breathable Nail Polish",
          "used_product_id": "ext_45293e532ad5a5f33438d38f",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_1a3dc4611dcd01447437ed9c",
          "domain": "786cosmetics.com",
          "title": "Rotomahana - Breathable Nail Polish",
          "used_product_id": "ext_1a3dc4611dcd01447437ed9c",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_7bac80d00f1f149743824dee",
          "domain": "786cosmetics.com",
          "title": "Top Coat Clear - Breathable Nail Polish",
          "used_product_id": "ext_7bac80d00f1f149743824dee",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_cd1678cacc37126a9d483888",
          "domain": "786cosmetics.com",
          "title": "Bursa - Breathable Nail Polish",
          "used_product_id": "ext_cd1678cacc37126a9d483888",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_c6ce33a7e9e59a7c8c24fc36",
          "domain": "786cosmetics.com",
          "title": "Kyoto - Breathable Nail Polish",
          "used_product_id": "ext_c6ce33a7e9e59a7c8c24fc36",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_152e5d39e5ef4ee3a67894b7",
          "domain": "786cosmetics.com",
          "title": "Guanajuato - Breathable Nail Polish",
          "used_product_id": "ext_152e5d39e5ef4ee3a67894b7",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        }
      ],
      "public_truncated_copy": [
        {
          "external_product_id": "ext_9a469b8f450d59f67ae21f6d",
          "domain": "786cosmetics.com",
          "title": "Paris - Breathable Nail Polish",
          "used_product_id": "ext_9a469b8f450d59f67ae21f6d",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_45293e532ad5a5f33438d38f",
          "domain": "786cosmetics.com",
          "title": "Nizwa - Breathable Nail Polish",
          "used_product_id": "ext_45293e532ad5a5f33438d38f",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_1a3dc4611dcd01447437ed9c",
          "domain": "786cosmetics.com",
          "title": "Rotomahana - Breathable Nail Polish",
          "used_product_id": "ext_1a3dc4611dcd01447437ed9c",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_7bac80d00f1f149743824dee",
          "domain": "786cosmetics.com",
          "title": "Top Coat Clear - Breathable Nail Polish",
          "used_product_id": "ext_7bac80d00f1f149743824dee",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_cd1678cacc37126a9d483888",
          "domain": "786cosmetics.com",
          "title": "Bursa - Breathable Nail Polish",
          "used_product_id": "ext_cd1678cacc37126a9d483888",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_c6ce33a7e9e59a7c8c24fc36",
          "domain": "786cosmetics.com",
          "title": "Kyoto - Breathable Nail Polish",
          "used_product_id": "ext_c6ce33a7e9e59a7c8c24fc36",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_152e5d39e5ef4ee3a67894b7",
          "domain": "786cosmetics.com",
          "title": "Guanajuato - Breathable Nail Polish",
          "used_product_id": "ext_152e5d39e5ef4ee3a67894b7",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        }
      ],
      "seller_only_evidence": [
        {
          "external_product_id": "ext_9a469b8f450d59f67ae21f6d",
          "domain": "786cosmetics.com",
          "title": "Paris - Breathable Nail Polish",
          "used_product_id": "ext_9a469b8f450d59f67ae21f6d",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_478c309275606a587d949541",
          "domain": "786cosmetics.com",
          "title": "Cusco - Breathable Nail Polish",
          "used_product_id": "ext_478c309275606a587d949541",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_45293e532ad5a5f33438d38f",
          "domain": "786cosmetics.com",
          "title": "Nizwa - Breathable Nail Polish",
          "used_product_id": "ext_45293e532ad5a5f33438d38f",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_799b3d12caaa6ad1842840dd",
          "domain": "786cosmetics.com",
          "title": "Sakura - Breathable Nail Polish",
          "used_product_id": "ext_799b3d12caaa6ad1842840dd",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_1a3dc4611dcd01447437ed9c",
          "domain": "786cosmetics.com",
          "title": "Rotomahana - Breathable Nail Polish",
          "used_product_id": "ext_1a3dc4611dcd01447437ed9c",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_2d506dd9dc7428de2d3d0cc8",
          "domain": "786cosmetics.com",
          "title": "Seville - Breathable Nail Polish",
          "used_product_id": "ext_2d506dd9dc7428de2d3d0cc8",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_09f3ad39bdfe1ea4a957c45f",
          "domain": "786cosmetics.com",
          "title": "Alexandria - Breathable Nail Polish",
          "used_product_id": "ext_09f3ad39bdfe1ea4a957c45f",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_7bac80d00f1f149743824dee",
          "domain": "786cosmetics.com",
          "title": "Top Coat Clear - Breathable Nail Polish",
          "used_product_id": "ext_7bac80d00f1f149743824dee",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_a5d2bdb05f2216a85764454f",
          "domain": "786cosmetics.com",
          "title": "Lisbon - Breathable Nail Polish",
          "used_product_id": "ext_a5d2bdb05f2216a85764454f",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_cd1678cacc37126a9d483888",
          "domain": "786cosmetics.com",
          "title": "Bursa - Breathable Nail Polish",
          "used_product_id": "ext_cd1678cacc37126a9d483888",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
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
        "key": "not_expected_missing",
        "count": 15
      },
      {
        "key": "not_applicable_product_family",
        "count": 1
      }
    ],
    "issues": [],
    "issue_domains": [],
    "source_origin": [
      {
        "key": "pdp_section",
        "count": 15
      },
      {
        "key": "none",
        "count": 1
      }
    ],
    "samples": {}
  },
  "variants": {
    "status": [
      {
        "key": "ready",
        "count": 15
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
