# KB x Commerce Index Readiness Audit

Generated: 2026-05-28T10:49:16.549Z

Scope: active external seeds, market=US, domain=firstaidbeauty.com, include_attached=true, limit=500

Report directory: /private/tmp/pivota-agent-product-intel-tail-20260528/reports/markato_expansion_status_20260524/wave48_product_intel_tail_20260528/firstaidbeauty_domain_audit_before

## Executive Numbers

- Rows scanned: 45
- Terminal hold rows: 0
- Action-required rows: 43
- DB Serving Ready rows: 2 (0.0444)
- DB Serving Ready rows excluding terminal holds: 2 (0.0444)
- External index published rows: 0
- Direct KB displayable rows: 17
- Direct KB high-quality-ready rows: 2
- Identity ready rows: 42
- Public commerce doc groups built by dry-run: 42
- Rows with public commerce doc + insight summary: 2
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
| kb_blocked | 40 |
| identity_blocked | 3 |
| db_serving_ready | 2 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| firstaidbeauty.com | 45 | 0 | 2 | 0.0444 | 0.0444 | 0 | kb_blocked |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 45,
  "by_market": {
    "US": 45
  },
  "by_domain": [
    {
      "key": "firstaidbeauty.com",
      "count": 45
    }
  ],
  "by_product_family": [
    {
      "key": "single_formula",
      "count": 33
    },
    {
      "key": "unknown_product",
      "count": 11
    },
    {
      "key": "accessory",
      "count": 1
    }
  ],
  "coverage": {
    "missing_inci": 0,
    "missing_active_raw": 30,
    "missing_details": 0,
    "missing_how_to": 1,
    "missing_faq": 10
  },
  "pivota_insights": {
    "direct": {
      "displayable": 17,
      "high_quality_ready": 2,
      "missing_kb": 0,
      "not_displayable": 28
    },
    "effective": {
      "displayable": 17,
      "high_quality_ready": 2,
      "missing_kb": 0,
      "not_displayable": 28,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [
      {
        "key": "not_displayable_gate",
        "count": 28
      },
      {
        "key": "not_reviewed",
        "count": 28
      },
      {
        "key": "quality_limited",
        "count": 28
      },
      {
        "key": "seller_only_evidence",
        "count": 28
      },
      {
        "key": "missing_card_highlight",
        "count": 19
      },
      {
        "key": "quality_eligible",
        "count": 16
      },
      {
        "key": "empty_watchouts",
        "count": 13
      },
      {
        "key": "public_generic_marketing_copy",
        "count": 1
      },
      {
        "key": "public_sensitive_claim",
        "count": 1
      }
    ],
    "effective_issue_domains": [
      {
        "key": "firstaidbeauty.com::not_displayable_gate",
        "count": 28
      },
      {
        "key": "firstaidbeauty.com::not_reviewed",
        "count": 28
      },
      {
        "key": "firstaidbeauty.com::quality_limited",
        "count": 28
      },
      {
        "key": "firstaidbeauty.com::seller_only_evidence",
        "count": 28
      },
      {
        "key": "firstaidbeauty.com::missing_card_highlight",
        "count": 19
      },
      {
        "key": "firstaidbeauty.com::quality_eligible",
        "count": 16
      },
      {
        "key": "firstaidbeauty.com::empty_watchouts",
        "count": 13
      },
      {
        "key": "firstaidbeauty.com::public_generic_marketing_copy",
        "count": 1
      },
      {
        "key": "firstaidbeauty.com::public_sensitive_claim",
        "count": 1
      }
    ],
    "quality_state": [
      {
        "key": "limited",
        "count": 28
      },
      {
        "key": "eligible",
        "count": 16
      },
      {
        "key": "reviewed",
        "count": 1
      }
    ],
    "evidence_profile": [
      {
        "key": "seller_only",
        "count": 28
      },
      {
        "key": "seller_plus_formula",
        "count": 17
      }
    ],
    "samples": {
      "not_reviewed": [
        {
          "external_product_id": "ext_08a4a4bfddf769bc8b3d7944",
          "domain": "firstaidbeauty.com",
          "title": "KP Smoothing + Brightening Body Lotion Fresh Peach",
          "used_product_id": "ext_08a4a4bfddf769bc8b3d7944",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_0ace092e3cb5d4cc0e714a7b",
          "domain": "firstaidbeauty.com",
          "title": "Bronze + Glow Drops with Niacinamide",
          "used_product_id": "ext_0ace092e3cb5d4cc0e714a7b",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_11963457ee34178a22a33486",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Gentle Cream-to-Foam Face Cleanser with Colloidal Oatmeal + Glycerin",
          "used_product_id": "ext_11963457ee34178a22a33486",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_1828b66659da703fa19235fb",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Repair Hydrating Pillow Pads with Colloidal Oatmeal + Ceramides",
          "used_product_id": "ext_1828b66659da703fa19235fb",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_1b35e9b9464058f6b641c8e3",
          "domain": "firstaidbeauty.com",
          "title": "Brighten + Glow Facial Radiance Pads with Glycolic + Lactic Acids 90 Count",
          "used_product_id": "ext_1b35e9b9464058f6b641c8e3",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_1d9e01e4c3a8800a0c22b175",
          "domain": "firstaidbeauty.com",
          "title": "Daily Resurfacing Lotion with 2% Niacinamide",
          "used_product_id": "ext_1d9e01e4c3a8800a0c22b175",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_3c794804d01f461caa12a3a3",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Repair Retinol Eye Cream with Retinol, Squalane + Ceramides",
          "used_product_id": "ext_3c794804d01f461caa12a3a3",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_509af4ff581a6ee8211c5b18",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Repair Rescue Barrier Balm with Dimethicone",
          "used_product_id": "ext_509af4ff581a6ee8211c5b18",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_62685854dfc71d2634e828e6",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Repair Firming Day Cream with Peptides, Niacinamide + Collagen",
          "used_product_id": "ext_62685854dfc71d2634e828e6",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_67275a9b74b688eca7eefe38",
          "domain": "firstaidbeauty.com",
          "title": "KP Bump Eraser Body Scrub 10% AHA Toasted Coconut",
          "used_product_id": "ext_67275a9b74b688eca7eefe38",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        }
      ],
      "not_displayable_gate": [
        {
          "external_product_id": "ext_08a4a4bfddf769bc8b3d7944",
          "domain": "firstaidbeauty.com",
          "title": "KP Smoothing + Brightening Body Lotion Fresh Peach",
          "used_product_id": "ext_08a4a4bfddf769bc8b3d7944",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_0ace092e3cb5d4cc0e714a7b",
          "domain": "firstaidbeauty.com",
          "title": "Bronze + Glow Drops with Niacinamide",
          "used_product_id": "ext_0ace092e3cb5d4cc0e714a7b",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_11963457ee34178a22a33486",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Gentle Cream-to-Foam Face Cleanser with Colloidal Oatmeal + Glycerin",
          "used_product_id": "ext_11963457ee34178a22a33486",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_1828b66659da703fa19235fb",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Repair Hydrating Pillow Pads with Colloidal Oatmeal + Ceramides",
          "used_product_id": "ext_1828b66659da703fa19235fb",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_1b35e9b9464058f6b641c8e3",
          "domain": "firstaidbeauty.com",
          "title": "Brighten + Glow Facial Radiance Pads with Glycolic + Lactic Acids 90 Count",
          "used_product_id": "ext_1b35e9b9464058f6b641c8e3",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_1d9e01e4c3a8800a0c22b175",
          "domain": "firstaidbeauty.com",
          "title": "Daily Resurfacing Lotion with 2% Niacinamide",
          "used_product_id": "ext_1d9e01e4c3a8800a0c22b175",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_3c794804d01f461caa12a3a3",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Repair Retinol Eye Cream with Retinol, Squalane + Ceramides",
          "used_product_id": "ext_3c794804d01f461caa12a3a3",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_509af4ff581a6ee8211c5b18",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Repair Rescue Barrier Balm with Dimethicone",
          "used_product_id": "ext_509af4ff581a6ee8211c5b18",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_62685854dfc71d2634e828e6",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Repair Firming Day Cream with Peptides, Niacinamide + Collagen",
          "used_product_id": "ext_62685854dfc71d2634e828e6",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_67275a9b74b688eca7eefe38",
          "domain": "firstaidbeauty.com",
          "title": "KP Bump Eraser Body Scrub 10% AHA Toasted Coconut",
          "used_product_id": "ext_67275a9b74b688eca7eefe38",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        }
      ],
      "seller_only_evidence": [
        {
          "external_product_id": "ext_08a4a4bfddf769bc8b3d7944",
          "domain": "firstaidbeauty.com",
          "title": "KP Smoothing + Brightening Body Lotion Fresh Peach",
          "used_product_id": "ext_08a4a4bfddf769bc8b3d7944",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_0ace092e3cb5d4cc0e714a7b",
          "domain": "firstaidbeauty.com",
          "title": "Bronze + Glow Drops with Niacinamide",
          "used_product_id": "ext_0ace092e3cb5d4cc0e714a7b",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_11963457ee34178a22a33486",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Gentle Cream-to-Foam Face Cleanser with Colloidal Oatmeal + Glycerin",
          "used_product_id": "ext_11963457ee34178a22a33486",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_1828b66659da703fa19235fb",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Repair Hydrating Pillow Pads with Colloidal Oatmeal + Ceramides",
          "used_product_id": "ext_1828b66659da703fa19235fb",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_1b35e9b9464058f6b641c8e3",
          "domain": "firstaidbeauty.com",
          "title": "Brighten + Glow Facial Radiance Pads with Glycolic + Lactic Acids 90 Count",
          "used_product_id": "ext_1b35e9b9464058f6b641c8e3",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_1d9e01e4c3a8800a0c22b175",
          "domain": "firstaidbeauty.com",
          "title": "Daily Resurfacing Lotion with 2% Niacinamide",
          "used_product_id": "ext_1d9e01e4c3a8800a0c22b175",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_3c794804d01f461caa12a3a3",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Repair Retinol Eye Cream with Retinol, Squalane + Ceramides",
          "used_product_id": "ext_3c794804d01f461caa12a3a3",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_509af4ff581a6ee8211c5b18",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Repair Rescue Barrier Balm with Dimethicone",
          "used_product_id": "ext_509af4ff581a6ee8211c5b18",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_62685854dfc71d2634e828e6",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Repair Firming Day Cream with Peptides, Niacinamide + Collagen",
          "used_product_id": "ext_62685854dfc71d2634e828e6",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_67275a9b74b688eca7eefe38",
          "domain": "firstaidbeauty.com",
          "title": "KP Bump Eraser Body Scrub 10% AHA Toasted Coconut",
          "used_product_id": "ext_67275a9b74b688eca7eefe38",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        }
      ],
      "public_generic_marketing_copy": [
        {
          "external_product_id": "ext_1d9e01e4c3a8800a0c22b175",
          "domain": "firstaidbeauty.com",
          "title": "Daily Resurfacing Lotion with 2% Niacinamide",
          "used_product_id": "ext_1d9e01e4c3a8800a0c22b175",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        }
      ],
      "missing_card_highlight": [
        {
          "external_product_id": "ext_27541ddaefa99c1185fd9677",
          "domain": "firstaidbeauty.com",
          "title": "After-Shower Nourishing Body Oil",
          "used_product_id": "ext_27541ddaefa99c1185fd9677",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_3a8ab0e88713143fd1df39ed",
          "domain": "firstaidbeauty.com",
          "title": "KP Bump Eraser Body Scrub 10% AHA Fresh Peach",
          "used_product_id": "ext_3a8ab0e88713143fd1df39ed",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_509af4ff581a6ee8211c5b18",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Repair Rescue Barrier Balm with Dimethicone",
          "used_product_id": "ext_509af4ff581a6ee8211c5b18",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_5a941eb383f5c65705b4b130",
          "domain": "firstaidbeauty.com",
          "title": "KP Bump Eraser Body Scrub 10% AHA Travel Size",
          "used_product_id": "ext_5a941eb383f5c65705b4b130",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_684ef08faa23d138a2222481",
          "domain": "firstaidbeauty.com",
          "title": "KP Bump Eraser Body Scrub 10% AHA Fresh Strawberry",
          "used_product_id": "ext_684ef08faa23d138a2222481",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_6c2feb5d6e43c9362d6a2254",
          "domain": "firstaidbeauty.com",
          "title": "Whole Body Deodorant Cream",
          "used_product_id": "ext_6c2feb5d6e43c9362d6a2254",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_84593a93fbe72818eb9f87d3",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Gentle Cream-to-Foam Face Cleanser with Colloidal Oatmeal + Glycerin Travel Size",
          "used_product_id": "ext_84593a93fbe72818eb9f87d3",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_8753278741a1169f5466840f",
          "domain": "firstaidbeauty.com",
          "title": "Anti-Chafe Stick with Shea Butter + Colloidal Oatmeal",
          "used_product_id": "ext_8753278741a1169f5466840f",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_8e21eb216b27854ddea6e0fa",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Gentle Cream-to-Foam Face Cleanser Jumbo",
          "used_product_id": "ext_8e21eb216b27854ddea6e0fa",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_92987efc90e7844dfa9d1899",
          "domain": "firstaidbeauty.com",
          "title": "Smooth Shave Cream",
          "used_product_id": "ext_92987efc90e7844dfa9d1899",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
        }
      ],
      "public_sensitive_claim": [
        {
          "external_product_id": "ext_a29393bd005135c81f47dade",
          "domain": "firstaidbeauty.com",
          "title": "Hydrating Dewy Gel Cream Moisturizer with Hyaluronic Acid + Ceramides",
          "used_product_id": "ext_a29393bd005135c81f47dade",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        }
      ]
    }
  },
  "active_ingredients": {
    "regulatory_expected": 4,
    "hero_expected": 32,
    "any_active_items": 28,
    "status": [
      {
        "key": "ready_hero",
        "count": 21
      },
      {
        "key": "low_signal_active",
        "count": 14
      },
      {
        "key": "ready_regulatory",
        "count": 4
      },
      {
        "key": "ready_other",
        "count": 3
      },
      {
        "key": "missing_hero",
        "count": 1
      },
      {
        "key": "not_applicable_product_family",
        "count": 1
      },
      {
        "key": "not_expected_missing",
        "count": 1
      }
    ],
    "issues": [
      {
        "key": "low_signal_active",
        "count": 14
      },
      {
        "key": "active_raw_may_be_full_inci",
        "count": 1
      },
      {
        "key": "missing_hero",
        "count": 1
      }
    ],
    "issue_domains": [
      {
        "key": "firstaidbeauty.com::low_signal_active",
        "count": 14
      },
      {
        "key": "firstaidbeauty.com::active_raw_may_be_full_inci",
        "count": 1
      },
      {
        "key": "firstaidbeauty.com::missing_hero",
        "count": 1
      }
    ],
    "source_origin": [
      {
        "key": "pdp_section",
        "count": 44
      },
      {
        "key": "none",
        "count": 1
      }
    ],
    "samples": {
      "low_signal_active": [
        {
          "external_product_id": "ext_11963457ee34178a22a33486",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Gentle Cream-to-Foam Face Cleanser with Colloidal Oatmeal + Glycerin",
          "status": "low_signal_active",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_1ccec8358c11ec3397c03abf",
          "domain": "firstaidbeauty.com",
          "title": "Ingrown Hair Pads with BHA + AHA Travel Size",
          "status": "low_signal_active",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_3a8ab0e88713143fd1df39ed",
          "domain": "firstaidbeauty.com",
          "title": "KP Bump Eraser Body Scrub 10% AHA Fresh Peach",
          "status": "low_signal_active",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_5a941eb383f5c65705b4b130",
          "domain": "firstaidbeauty.com",
          "title": "KP Bump Eraser Body Scrub 10% AHA Travel Size",
          "status": "low_signal_active",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_67275a9b74b688eca7eefe38",
          "domain": "firstaidbeauty.com",
          "title": "KP Bump Eraser Body Scrub 10% AHA Toasted Coconut",
          "status": "low_signal_active",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_84593a93fbe72818eb9f87d3",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Gentle Cream-to-Foam Face Cleanser with Colloidal Oatmeal + Glycerin Travel Size",
          "status": "low_signal_active",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_8b6e05cca86c4a7e142950d8",
          "domain": "firstaidbeauty.com",
          "title": "Ingrown Hair Pads with BHA + AHA",
          "status": "low_signal_active",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_8e21eb216b27854ddea6e0fa",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Gentle Cream-to-Foam Face Cleanser Jumbo",
          "status": "low_signal_active",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_92987efc90e7844dfa9d1899",
          "domain": "firstaidbeauty.com",
          "title": "Smooth Shave Cream",
          "status": "low_signal_active",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_9383dd326e07694ef444ca7c",
          "domain": "firstaidbeauty.com",
          "title": "Ingrown Hair Pads with BHA + AHA 60 count",
          "status": "low_signal_active",
          "active_items": [],
          "source_origin": "pdp_section"
        }
      ],
      "active_raw_may_be_full_inci": [
        {
          "external_product_id": "ext_684ef08faa23d138a2222481",
          "domain": "firstaidbeauty.com",
          "title": "KP Bump Eraser Body Scrub 10% AHA Fresh Strawberry",
          "status": "ready_hero",
          "active_items": [
            "Pumice Buffing Beads",
            "Glycolic & Lactic Acids",
            "Bisabolol",
            "Vitamin E"
          ],
          "source_origin": "pdp_section"
        }
      ],
      "missing_hero": [
        {
          "external_product_id": "ext_8753278741a1169f5466840f",
          "domain": "firstaidbeauty.com",
          "title": "Anti-Chafe Stick with Shea Butter + Colloidal Oatmeal",
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
        "count": 45
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
