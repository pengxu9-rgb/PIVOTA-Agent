# KB x Commerce Index Readiness Audit

Generated: 2026-05-26T00:06:15.250Z

Scope: active external seeds, market=US, include_attached=true, limit=20000

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/wave20_nubest_official_pdp_20260526/readiness_after_catalog_sync

## Executive Numbers

- Rows scanned: 10
- Terminal hold rows: 0
- Action-required rows: 10
- DB Serving Ready rows: 0 (0)
- DB Serving Ready rows excluding terminal holds: 0 (0)
- External index published rows: 0
- Direct KB displayable rows: 0
- Direct KB high-quality-ready rows: 0
- Identity ready rows: 10
- Public commerce doc groups built by dry-run: 10
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
| kb_missing | 10 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| nubest.com | 10 | 0 | 0 | 0 | 0 | 0 | kb_missing |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 10,
  "by_market": {
    "US": 10
  },
  "by_domain": [
    {
      "key": "nubest.com",
      "count": 10
    }
  ],
  "by_product_family": [
    {
      "key": "single_formula",
      "count": 10
    }
  ],
  "coverage": {
    "missing_inci": 0,
    "missing_active_raw": 0,
    "missing_details": 0,
    "missing_how_to": 0,
    "missing_faq": 10
  },
  "pivota_insights": {
    "direct": {
      "displayable": 0,
      "high_quality_ready": 0,
      "missing_kb": 10,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 0,
      "high_quality_ready": 0,
      "missing_kb": 10,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [
      {
        "key": "missing_kb",
        "count": 10
      }
    ],
    "effective_issue_domains": [
      {
        "key": "nubest.com::missing_kb",
        "count": 10
      }
    ],
    "quality_state": [
      {
        "key": "missing",
        "count": 10
      }
    ],
    "evidence_profile": [
      {
        "key": "missing",
        "count": 10
      }
    ],
    "samples": {
      "missing_kb": [
        {
          "external_product_id": "ext_97ffa9c22f3a8ea415454e83",
          "domain": "nubest.com",
          "title": "NuBest Tall 10+ - Powerful Growth Support for Teens - 60 Capsules",
          "used_product_id": "ext_97ffa9c22f3a8ea415454e83",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_1030e828c320440354e98895",
          "domain": "nubest.com",
          "title": "Doctor Taller Kids – Grape Multivitamin Chewables for Children Ages 2–9, 60 Vegan Gummies",
          "used_product_id": "ext_1030e828c320440354e98895",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_d6eb3ee536ac3d49561aaa5f",
          "domain": "nubest.com",
          "title": "NuBest Immune Gummies for Kids (Ages 4+) - 19 Essential Nutrients for Immune Support & Healthy Development - Raspberry Flavor (60 Count)",
          "used_product_id": "ext_d6eb3ee536ac3d49561aaa5f",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_d6f78ec76732918fef0b7d5b",
          "domain": "nubest.com",
          "title": "NuBest Tall Protein Vanilla Shake for Kids Ages 4+, 10 Vegan Servings - Pack 1",
          "used_product_id": "ext_d6f78ec76732918fef0b7d5b",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_461efc4478853cf6cac8d4e9",
          "domain": "nubest.com",
          "title": "NuBest Tall Protein, Chocolate Shake, 15 servings - Pack 1",
          "used_product_id": "ext_461efc4478853cf6cac8d4e9",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_fb76b45f22e546e331d4904f",
          "domain": "nubest.com",
          "title": "Doctor Taller Kids Multivitamins – Grape Flavor, Vegan Chewables for Ages 2–9 (90 Count)",
          "used_product_id": "ext_fb76b45f22e546e331d4904f",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_acff84a9f77766e338b83f44",
          "domain": "nubest.com",
          "title": "NuBest Tall Kids – Berry Multivitamin Chewables for Ages 2–9, 60 Count",
          "used_product_id": "ext_acff84a9f77766e338b83f44",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_9fbfa632c4a275917f5a0da0",
          "domain": "nubest.com",
          "title": "Omega-3 Vegan Gummies for Kids & Teens - 60 Count",
          "used_product_id": "ext_9fbfa632c4a275917f5a0da0",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_2da6f7615154860df7bdb07b",
          "domain": "nubest.com",
          "title": "Doctor Plus, For Children & Teens - 60 Capsules",
          "used_product_id": "ext_2da6f7615154860df7bdb07b",
          "quality_state": "missing",
          "evidence_profile": "missing"
        },
        {
          "external_product_id": "ext_4e7ae04d68622ea157a494da",
          "domain": "nubest.com",
          "title": "Grow Power Capsules for Kids & Teens – 60 Count",
          "used_product_id": "ext_4e7ae04d68622ea157a494da",
          "quality_state": "missing",
          "evidence_profile": "missing"
        }
      ]
    }
  },
  "active_ingredients": {
    "regulatory_expected": 0,
    "hero_expected": 8,
    "any_active_items": 6,
    "status": [
      {
        "key": "ready_hero",
        "count": 6
      },
      {
        "key": "missing_hero",
        "count": 2
      },
      {
        "key": "not_expected_missing",
        "count": 2
      }
    ],
    "issues": [
      {
        "key": "active_raw_may_be_full_inci",
        "count": 3
      },
      {
        "key": "missing_hero",
        "count": 2
      }
    ],
    "issue_domains": [
      {
        "key": "nubest.com::active_raw_may_be_full_inci",
        "count": 3
      },
      {
        "key": "nubest.com::missing_hero",
        "count": 2
      }
    ],
    "source_origin": [
      {
        "key": "pdp_section",
        "count": 10
      }
    ],
    "samples": {
      "active_raw_may_be_full_inci": [
        {
          "external_product_id": "ext_acff84a9f77766e338b83f44",
          "domain": "nubest.com",
          "title": "NuBest Tall Kids – Berry Multivitamin Chewables for Ages 2–9, 60 Count",
          "status": "ready_hero",
          "active_items": [
            "Calcium (as Calcium Carbonate)",
            "Vitamin A (as Beta Carotene)",
            "Thiamine (as Thiamine HCl)",
            "Riboflavin (Vitamin B2)",
            "Niacin (as Niacinamide)",
            "Vitamin B6 (as Pyridoxine HCl)",
            "Biotin",
            "Folate (as Folic Acid)"
          ],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_2da6f7615154860df7bdb07b",
          "domain": "nubest.com",
          "title": "Doctor Plus, For Children & Teens - 60 Capsules",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_4e7ae04d68622ea157a494da",
          "domain": "nubest.com",
          "title": "Grow Power Capsules for Kids & Teens – 60 Count",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "pdp_section"
        }
      ],
      "missing_hero": [
        {
          "external_product_id": "ext_2da6f7615154860df7bdb07b",
          "domain": "nubest.com",
          "title": "Doctor Plus, For Children & Teens - 60 Capsules",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_4e7ae04d68622ea157a494da",
          "domain": "nubest.com",
          "title": "Grow Power Capsules for Kids & Teens – 60 Count",
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
        "count": 8
      },
      {
        "key": "no_visible_variant_axis",
        "count": 2
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
