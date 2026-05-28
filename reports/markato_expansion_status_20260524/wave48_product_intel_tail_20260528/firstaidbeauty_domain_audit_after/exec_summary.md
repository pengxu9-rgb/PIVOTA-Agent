# KB x Commerce Index Readiness Audit

Generated: 2026-05-28T10:52:32.556Z

Scope: active external seeds, market=US, domain=firstaidbeauty.com, include_attached=true, limit=500

Report directory: /private/tmp/pivota-agent-product-intel-tail-20260528/reports/markato_expansion_status_20260524/wave48_product_intel_tail_20260528/firstaidbeauty_domain_audit_after

## Executive Numbers

- Rows scanned: 45
- Terminal hold rows: 0
- Action-required rows: 29
- DB Serving Ready rows: 16 (0.3556)
- DB Serving Ready rows excluding terminal holds: 16 (0.3556)
- External index published rows: 0
- Direct KB displayable rows: 17
- Direct KB high-quality-ready rows: 16
- Identity ready rows: 42
- Public commerce doc groups built by dry-run: 42
- Rows with public commerce doc + insight summary: 16
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
| kb_blocked | 26 |
| db_serving_ready | 16 |
| identity_blocked | 3 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| firstaidbeauty.com | 45 | 0 | 16 | 0.3556 | 0.3556 | 0 | kb_blocked |

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
      "high_quality_ready": 16,
      "missing_kb": 0,
      "not_displayable": 28
    },
    "effective": {
      "displayable": 17,
      "high_quality_ready": 16,
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
        "key": "empty_watchouts",
        "count": 11
      },
      {
        "key": "missing_card_highlight",
        "count": 5
      },
      {
        "key": "quality_eligible",
        "count": 2
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
        "key": "firstaidbeauty.com::empty_watchouts",
        "count": 11
      },
      {
        "key": "firstaidbeauty.com::missing_card_highlight",
        "count": 5
      },
      {
        "key": "firstaidbeauty.com::quality_eligible",
        "count": 2
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
        "key": "reviewed",
        "count": 15
      },
      {
        "key": "eligible",
        "count": 2
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
          "external_product_id": "ext_509af4ff581a6ee8211c5b18",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Repair Rescue Barrier Balm with Dimethicone",
          "used_product_id": "ext_509af4ff581a6ee8211c5b18",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_94c4c0eb238cedb76438f01d",
          "domain": "firstaidbeauty.com",
          "title": "Hydrating Sunscreen Milk with Colloidal Oatmeal Broad Spectrum SPF 45",
          "used_product_id": "ext_94c4c0eb238cedb76438f01d",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_95582fd1ed491684223018bb",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Repair Oil-Control Moisturizer",
          "used_product_id": "ext_95582fd1ed491684223018bb",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_9bc7ff02d709cc5383cc78ec",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Repair Face Lotion with Colloidal Oatmeal",
          "used_product_id": "ext_9bc7ff02d709cc5383cc78ec",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_d59af8ba842e1f34de6a6d82",
          "domain": "firstaidbeauty.com",
          "title": "KP Bump Eraser Body Scrub 10% AHA",
          "used_product_id": "ext_d59af8ba842e1f34de6a6d82",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
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
