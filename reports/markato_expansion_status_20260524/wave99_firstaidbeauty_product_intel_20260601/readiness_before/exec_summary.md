# KB x Commerce Index Readiness Audit

Generated: 2026-05-31T16:05:50.849Z

Scope: active external seeds, market=US, include_attached=true, limit=20

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave99_firstaidbeauty_product_intel_20260601/readiness_before

## Executive Numbers

- Rows scanned: 8
- Terminal hold rows: 0
- Action-required rows: 6
- DB Serving Ready rows: 2 (0.25)
- DB Serving Ready rows excluding terminal holds: 2 (0.25)
- External index published rows: 0
- Direct KB displayable rows: 2
- Direct KB high-quality-ready rows: 2
- Identity ready rows: 8
- Public commerce doc groups built by dry-run: 8
- Rows with public commerce doc + insight summary: 2
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
| kb_blocked | 6 |
| db_serving_ready | 2 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| firstaidbeauty.com | 8 | 0 | 2 | 0.25 | 0.25 | 0 | kb_blocked |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 8,
  "by_market": {
    "US": 8
  },
  "by_domain": [
    {
      "key": "firstaidbeauty.com",
      "count": 8
    }
  ],
  "by_product_family": [
    {
      "key": "single_formula",
      "count": 7
    },
    {
      "key": "unknown_product",
      "count": 1
    }
  ],
  "coverage": {
    "missing_inci": 0,
    "missing_active_raw": 5,
    "missing_details": 0,
    "missing_how_to": 0,
    "missing_faq": 1
  },
  "pivota_insights": {
    "direct": {
      "displayable": 2,
      "high_quality_ready": 2,
      "missing_kb": 0,
      "not_displayable": 6
    },
    "effective": {
      "displayable": 2,
      "high_quality_ready": 2,
      "missing_kb": 0,
      "not_displayable": 6,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [
      {
        "key": "not_displayable_gate",
        "count": 6
      },
      {
        "key": "not_reviewed",
        "count": 6
      },
      {
        "key": "quality_limited",
        "count": 6
      },
      {
        "key": "seller_only_evidence",
        "count": 6
      },
      {
        "key": "empty_watchouts",
        "count": 2
      },
      {
        "key": "missing_card_highlight",
        "count": 2
      },
      {
        "key": "public_sensitive_claim",
        "count": 1
      }
    ],
    "effective_issue_domains": [
      {
        "key": "firstaidbeauty.com::not_displayable_gate",
        "count": 6
      },
      {
        "key": "firstaidbeauty.com::not_reviewed",
        "count": 6
      },
      {
        "key": "firstaidbeauty.com::quality_limited",
        "count": 6
      },
      {
        "key": "firstaidbeauty.com::seller_only_evidence",
        "count": 6
      },
      {
        "key": "firstaidbeauty.com::empty_watchouts",
        "count": 2
      },
      {
        "key": "firstaidbeauty.com::missing_card_highlight",
        "count": 2
      },
      {
        "key": "firstaidbeauty.com::public_sensitive_claim",
        "count": 1
      }
    ],
    "quality_state": [
      {
        "key": "limited",
        "count": 6
      },
      {
        "key": "reviewed",
        "count": 2
      }
    ],
    "evidence_profile": [
      {
        "key": "seller_only",
        "count": 6
      },
      {
        "key": "seller_plus_formula",
        "count": 2
      }
    ],
    "samples": {
      "not_reviewed": [
        {
          "external_product_id": "ext_a29393bd005135c81f47dade",
          "domain": "firstaidbeauty.com",
          "title": "Hydrating Dewy Gel Cream Moisturizer with Hyaluronic Acid + Ceramides",
          "used_product_id": "ext_a29393bd005135c81f47dade",
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
          "external_product_id": "ext_1b35e9b9464058f6b641c8e3",
          "domain": "firstaidbeauty.com",
          "title": "Brighten + Glow Facial Radiance Pads with Glycolic + Lactic Acids 90 Count",
          "used_product_id": "ext_1b35e9b9464058f6b641c8e3",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
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
          "external_product_id": "ext_f22e924478be64d4c3a1b918",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Repair Firming Night Cream with Colloidal Oatmeal + Niacinamide",
          "used_product_id": "ext_f22e924478be64d4c3a1b918",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        }
      ],
      "not_displayable_gate": [
        {
          "external_product_id": "ext_a29393bd005135c81f47dade",
          "domain": "firstaidbeauty.com",
          "title": "Hydrating Dewy Gel Cream Moisturizer with Hyaluronic Acid + Ceramides",
          "used_product_id": "ext_a29393bd005135c81f47dade",
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
          "external_product_id": "ext_1b35e9b9464058f6b641c8e3",
          "domain": "firstaidbeauty.com",
          "title": "Brighten + Glow Facial Radiance Pads with Glycolic + Lactic Acids 90 Count",
          "used_product_id": "ext_1b35e9b9464058f6b641c8e3",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
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
          "external_product_id": "ext_f22e924478be64d4c3a1b918",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Repair Firming Night Cream with Colloidal Oatmeal + Niacinamide",
          "used_product_id": "ext_f22e924478be64d4c3a1b918",
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
      ],
      "seller_only_evidence": [
        {
          "external_product_id": "ext_a29393bd005135c81f47dade",
          "domain": "firstaidbeauty.com",
          "title": "Hydrating Dewy Gel Cream Moisturizer with Hyaluronic Acid + Ceramides",
          "used_product_id": "ext_a29393bd005135c81f47dade",
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
          "external_product_id": "ext_1b35e9b9464058f6b641c8e3",
          "domain": "firstaidbeauty.com",
          "title": "Brighten + Glow Facial Radiance Pads with Glycolic + Lactic Acids 90 Count",
          "used_product_id": "ext_1b35e9b9464058f6b641c8e3",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
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
          "external_product_id": "ext_f22e924478be64d4c3a1b918",
          "domain": "firstaidbeauty.com",
          "title": "Ultra Repair Firming Night Cream with Colloidal Oatmeal + Niacinamide",
          "used_product_id": "ext_f22e924478be64d4c3a1b918",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        }
      ],
      "missing_card_highlight": [
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
        }
      ]
    }
  },
  "active_ingredients": {
    "regulatory_expected": 0,
    "hero_expected": 7,
    "any_active_items": 7,
    "status": [
      {
        "key": "ready_hero",
        "count": 6
      },
      {
        "key": "low_signal_active",
        "count": 1
      },
      {
        "key": "ready_other",
        "count": 1
      }
    ],
    "issues": [
      {
        "key": "low_signal_active",
        "count": 1
      }
    ],
    "issue_domains": [
      {
        "key": "firstaidbeauty.com::low_signal_active",
        "count": 1
      }
    ],
    "source_origin": [
      {
        "key": "pdp_section",
        "count": 8
      }
    ],
    "samples": {
      "low_signal_active": [
        {
          "external_product_id": "ext_d59af8ba842e1f34de6a6d82",
          "domain": "firstaidbeauty.com",
          "title": "KP Bump Eraser Body Scrub 10% AHA",
          "status": "low_signal_active",
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
        "count": 8
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
