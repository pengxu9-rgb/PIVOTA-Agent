# KB x Commerce Index Readiness Audit

Generated: 2026-05-26T00:34:10.818Z

Scope: active external seeds, market=US, domain=786cosmetics.com, include_attached=true, limit=80

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/wave21_candidate_probe_20260526/786cosmetics_readiness_probe

## Executive Numbers

- Rows scanned: 51
- Terminal hold rows: 1
- Action-required rows: 50
- DB Serving Ready rows: 0 (0)
- DB Serving Ready rows excluding terminal holds: 0 (0)
- External index published rows: 0
- Direct KB displayable rows: 47
- Direct KB high-quality-ready rows: 18
- Identity ready rows: 27
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
| seed_content_blocked | 30 |
| identity_blocked | 20 |
| terminal_hold | 1 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 786cosmetics.com | 51 | 1 | 0 | 0 | 0 | 0 | seed_content_blocked |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 51,
  "by_market": {
    "US": 51
  },
  "by_domain": [
    {
      "key": "786cosmetics.com",
      "count": 51
    }
  ],
  "by_product_family": [
    {
      "key": "single_formula",
      "count": 23
    },
    {
      "key": "unknown_product",
      "count": 17
    },
    {
      "key": "set_or_collection",
      "count": 7
    },
    {
      "key": "non_merch",
      "count": 3
    },
    {
      "key": "accessory",
      "count": 1
    }
  ],
  "coverage": {
    "missing_inci": 30,
    "missing_active_raw": 40,
    "missing_details": 30,
    "missing_how_to": 30,
    "missing_faq": 31
  },
  "pivota_insights": {
    "direct": {
      "displayable": 47,
      "high_quality_ready": 18,
      "missing_kb": 4,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 47,
      "high_quality_ready": 18,
      "missing_kb": 4,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [
      {
        "key": "empty_watchouts",
        "count": 45
      },
      {
        "key": "quality_limited",
        "count": 27
      },
      {
        "key": "seller_only_evidence",
        "count": 27
      },
      {
        "key": "quality_eligible",
        "count": 20
      },
      {
        "key": "ellipsis_or_truncated",
        "count": 12
      },
      {
        "key": "public_truncated_copy",
        "count": 12
      },
      {
        "key": "missing_kb",
        "count": 4
      }
    ],
    "effective_issue_domains": [
      {
        "key": "786cosmetics.com::empty_watchouts",
        "count": 45
      },
      {
        "key": "786cosmetics.com::quality_limited",
        "count": 27
      },
      {
        "key": "786cosmetics.com::seller_only_evidence",
        "count": 27
      },
      {
        "key": "786cosmetics.com::quality_eligible",
        "count": 20
      },
      {
        "key": "786cosmetics.com::ellipsis_or_truncated",
        "count": 12
      },
      {
        "key": "786cosmetics.com::public_truncated_copy",
        "count": 12
      },
      {
        "key": "786cosmetics.com::missing_kb",
        "count": 4
      }
    ],
    "quality_state": [
      {
        "key": "limited",
        "count": 27
      },
      {
        "key": "eligible",
        "count": 20
      },
      {
        "key": "missing",
        "count": 4
      }
    ],
    "evidence_profile": [
      {
        "key": "seller_only",
        "count": 27
      },
      {
        "key": "seller_plus_formula",
        "count": 20
      },
      {
        "key": "missing",
        "count": 4
      }
    ],
    "samples": {
      "seller_only_evidence": [
        {
          "external_product_id": "ext_09bd1a60af24d620706724ee",
          "domain": "786cosmetics.com",
          "title": "Hyderabad - Breathable Nail Polish",
          "used_product_id": "ext_09bd1a60af24d620706724ee",
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
          "external_product_id": "ext_152e5d39e5ef4ee3a67894b7",
          "domain": "786cosmetics.com",
          "title": "Guanajuato - Breathable Nail Polish",
          "used_product_id": "ext_152e5d39e5ef4ee3a67894b7",
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
          "external_product_id": "ext_2dcd32513f13fbec782bb9d2",
          "domain": "786cosmetics.com",
          "title": "Nail Polish Set 4 Piece (Choose Your Colors)",
          "used_product_id": "ext_2dcd32513f13fbec782bb9d2",
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
          "external_product_id": "ext_478c309275606a587d949541",
          "domain": "786cosmetics.com",
          "title": "Cusco - Breathable Nail Polish",
          "used_product_id": "ext_478c309275606a587d949541",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_58baf9029d81af1ac9f8bc7e",
          "domain": "786cosmetics.com",
          "title": "Soy Nail Polish Remover With Jojoba Seed & Tea Tree Oil",
          "used_product_id": "ext_58baf9029d81af1ac9f8bc7e",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_5c80fda1202cbae9f1252b1c",
          "domain": "786cosmetics.com",
          "title": "Nail Polish Set (Choose your Colors)",
          "used_product_id": "ext_5c80fda1202cbae9f1252b1c",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        }
      ],
      "ellipsis_or_truncated": [
        {
          "external_product_id": "ext_152e5d39e5ef4ee3a67894b7",
          "domain": "786cosmetics.com",
          "title": "Guanajuato - Breathable Nail Polish",
          "used_product_id": "ext_152e5d39e5ef4ee3a67894b7",
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
          "external_product_id": "ext_45293e532ad5a5f33438d38f",
          "domain": "786cosmetics.com",
          "title": "Nizwa - Breathable Nail Polish",
          "used_product_id": "ext_45293e532ad5a5f33438d38f",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_5f55c01bae5cd6b5f0a0e78e",
          "domain": "786cosmetics.com",
          "title": "Dakar - Breathable Nail Polish",
          "used_product_id": "ext_5f55c01bae5cd6b5f0a0e78e",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
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
          "external_product_id": "ext_86344711237a7b6cdad6cfa3",
          "domain": "786cosmetics.com",
          "title": "Golden Hour Collection - 6 Piece Nail Polish Set",
          "used_product_id": "ext_86344711237a7b6cdad6cfa3",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_87a0af88b9bd23b8f2123d1b",
          "domain": "786cosmetics.com",
          "title": "Almond & Ginseng Cuticle Oil",
          "used_product_id": "ext_87a0af88b9bd23b8f2123d1b",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_9a469b8f450d59f67ae21f6d",
          "domain": "786cosmetics.com",
          "title": "Paris - Breathable Nail Polish",
          "used_product_id": "ext_9a469b8f450d59f67ae21f6d",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_9cd211269e8480e6a7475b5e",
          "domain": "786cosmetics.com",
          "title": "Muscat - Breathable Nail Polish",
          "used_product_id": "ext_9cd211269e8480e6a7475b5e",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_ab32c65ee7badd0b4a614919",
          "domain": "786cosmetics.com",
          "title": "Marrakesh Nights Collection - 4  Piece Nail Polish Set",
          "used_product_id": "ext_ab32c65ee7badd0b4a614919",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        }
      ],
      "public_truncated_copy": [
        {
          "external_product_id": "ext_152e5d39e5ef4ee3a67894b7",
          "domain": "786cosmetics.com",
          "title": "Guanajuato - Breathable Nail Polish",
          "used_product_id": "ext_152e5d39e5ef4ee3a67894b7",
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
          "external_product_id": "ext_45293e532ad5a5f33438d38f",
          "domain": "786cosmetics.com",
          "title": "Nizwa - Breathable Nail Polish",
          "used_product_id": "ext_45293e532ad5a5f33438d38f",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_5f55c01bae5cd6b5f0a0e78e",
          "domain": "786cosmetics.com",
          "title": "Dakar - Breathable Nail Polish",
          "used_product_id": "ext_5f55c01bae5cd6b5f0a0e78e",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
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
          "external_product_id": "ext_86344711237a7b6cdad6cfa3",
          "domain": "786cosmetics.com",
          "title": "Golden Hour Collection - 6 Piece Nail Polish Set",
          "used_product_id": "ext_86344711237a7b6cdad6cfa3",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_87a0af88b9bd23b8f2123d1b",
          "domain": "786cosmetics.com",
          "title": "Almond & Ginseng Cuticle Oil",
          "used_product_id": "ext_87a0af88b9bd23b8f2123d1b",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_9a469b8f450d59f67ae21f6d",
          "domain": "786cosmetics.com",
          "title": "Paris - Breathable Nail Polish",
          "used_product_id": "ext_9a469b8f450d59f67ae21f6d",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_9cd211269e8480e6a7475b5e",
          "domain": "786cosmetics.com",
          "title": "Muscat - Breathable Nail Polish",
          "used_product_id": "ext_9cd211269e8480e6a7475b5e",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_ab32c65ee7badd0b4a614919",
          "domain": "786cosmetics.com",
          "title": "Marrakesh Nights Collection - 4  Piece Nail Polish Set",
          "used_product_id": "ext_ab32c65ee7badd0b4a614919",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        }
      ],
      "missing_kb": [
        {
          "external_product_id": "ext_22c3e831a335c12bc33fca2f",
          "domain": "786cosmetics.com",
          "title": "Java - Breathable Nail Polish",
          "used_product_id": "ext_22c3e831a335c12bc33fca2f",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_31b12b124fb01c2d35b98e38",
          "domain": "786cosmetics.com",
          "title": "786 Canvas Tote Bag",
          "used_product_id": "ext_31b12b124fb01c2d35b98e38",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_c127c1d09e3be26e54f4a0a0",
          "domain": "786cosmetics.com",
          "title": "Gift Card",
          "used_product_id": "ext_c127c1d09e3be26e54f4a0a0",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_e96da71bdfd3ec573a4642cd",
          "domain": "786cosmetics.com",
          "title": "Shipping Protection",
          "used_product_id": "ext_e96da71bdfd3ec573a4642cd",
          "quality_state": "missing",
          "evidence_profile": "missing"
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
        "count": 40
      },
      {
        "key": "not_applicable_product_family",
        "count": 11
      }
    ],
    "issues": [],
    "issue_domains": [],
    "source_origin": [
      {
        "key": "none",
        "count": 31
      },
      {
        "key": "pdp_section",
        "count": 20
      }
    ],
    "samples": {}
  },
  "variants": {
    "status": [
      {
        "key": "no_visible_variant_axis",
        "count": 42
      },
      {
        "key": "ready",
        "count": 9
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
