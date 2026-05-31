# KB x Commerce Index Readiness Audit

Generated: 2026-05-31T16:19:17.362Z

Scope: active external seeds, market=US, include_attached=true, limit=20

Report directory: /Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave25-786-20260527/reports/markato_expansion_status_20260524/wave100_embryolisse_product_intel_20260601/readiness_before

## Executive Numbers

- Rows scanned: 8
- Terminal hold rows: 0
- Action-required rows: 8
- DB Serving Ready rows: 0 (0)
- DB Serving Ready rows excluding terminal holds: 0 (0)
- External index published rows: 0
- Direct KB displayable rows: 0
- Direct KB high-quality-ready rows: 0
- Identity ready rows: 8
- Public commerce doc groups built by dry-run: 8
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
| kb_blocked | 8 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| us.embryolisse.com | 8 | 0 | 0 | 0 | 0 | 0 | kb_blocked |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 8,
  "by_market": {
    "US": 8
  },
  "by_domain": [
    {
      "key": "us.embryolisse.com",
      "count": 8
    }
  ],
  "by_product_family": [
    {
      "key": "single_formula",
      "count": 5
    },
    {
      "key": "unknown_product",
      "count": 3
    }
  ],
  "coverage": {
    "missing_inci": 0,
    "missing_active_raw": 1,
    "missing_details": 0,
    "missing_how_to": 0,
    "missing_faq": 7
  },
  "pivota_insights": {
    "direct": {
      "displayable": 0,
      "high_quality_ready": 0,
      "missing_kb": 0,
      "not_displayable": 8
    },
    "effective": {
      "displayable": 0,
      "high_quality_ready": 0,
      "missing_kb": 0,
      "not_displayable": 8,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [
      {
        "key": "not_displayable_gate",
        "count": 8
      },
      {
        "key": "not_reviewed",
        "count": 8
      },
      {
        "key": "quality_limited",
        "count": 8
      },
      {
        "key": "seller_only_evidence",
        "count": 8
      },
      {
        "key": "empty_watchouts",
        "count": 7
      }
    ],
    "effective_issue_domains": [
      {
        "key": "us.embryolisse.com::not_displayable_gate",
        "count": 8
      },
      {
        "key": "us.embryolisse.com::not_reviewed",
        "count": 8
      },
      {
        "key": "us.embryolisse.com::quality_limited",
        "count": 8
      },
      {
        "key": "us.embryolisse.com::seller_only_evidence",
        "count": 8
      },
      {
        "key": "us.embryolisse.com::empty_watchouts",
        "count": 7
      }
    ],
    "quality_state": [
      {
        "key": "limited",
        "count": 8
      }
    ],
    "evidence_profile": [
      {
        "key": "seller_only",
        "count": 8
      }
    ],
    "samples": {
      "not_reviewed": [
        {
          "external_product_id": "ext_76bfd11a0bea190f4c9d32c7",
          "domain": "us.embryolisse.com",
          "title": "Radiant Eye Stick - Cool Treatment For A Brighter Look",
          "used_product_id": "ext_76bfd11a0bea190f4c9d32c7",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_1b4a85868ba125bc6b7040e0",
          "domain": "us.embryolisse.com",
          "title": "Filaderme Emulsion - Face Lotion For Dry Skin",
          "used_product_id": "ext_1b4a85868ba125bc6b7040e0",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_a47933ea068521800615641f",
          "domain": "us.embryolisse.com",
          "title": "Lait-Crème Fluid+ Eco-Refill",
          "used_product_id": "ext_a47933ea068521800615641f",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_4df267da6c48f581bf6ff5f4",
          "domain": "us.embryolisse.com",
          "title": "Cicalisse Hands and Nails",
          "used_product_id": "ext_4df267da6c48f581bf6ff5f4",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_1204da285323c4c294847daf",
          "domain": "us.embryolisse.com",
          "title": "Exfoliating Milk Powder",
          "used_product_id": "ext_1204da285323c4c294847daf",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_e13d80b8bf9b8dfe44042064",
          "domain": "us.embryolisse.com",
          "title": "SOS Corrective Cream",
          "used_product_id": "ext_e13d80b8bf9b8dfe44042064",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_3a04dcee79f96ee9570e93f3",
          "domain": "us.embryolisse.com",
          "title": "3-in-1 Secret Paste",
          "used_product_id": "ext_3a04dcee79f96ee9570e93f3",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_1f01309541611d783b7fd63c",
          "domain": "us.embryolisse.com",
          "title": "Cicalisse - Restorative & Protective skin Cream - Face, Body, Lip",
          "used_product_id": "ext_1f01309541611d783b7fd63c",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        }
      ],
      "not_displayable_gate": [
        {
          "external_product_id": "ext_76bfd11a0bea190f4c9d32c7",
          "domain": "us.embryolisse.com",
          "title": "Radiant Eye Stick - Cool Treatment For A Brighter Look",
          "used_product_id": "ext_76bfd11a0bea190f4c9d32c7",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_1b4a85868ba125bc6b7040e0",
          "domain": "us.embryolisse.com",
          "title": "Filaderme Emulsion - Face Lotion For Dry Skin",
          "used_product_id": "ext_1b4a85868ba125bc6b7040e0",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_a47933ea068521800615641f",
          "domain": "us.embryolisse.com",
          "title": "Lait-Crème Fluid+ Eco-Refill",
          "used_product_id": "ext_a47933ea068521800615641f",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_4df267da6c48f581bf6ff5f4",
          "domain": "us.embryolisse.com",
          "title": "Cicalisse Hands and Nails",
          "used_product_id": "ext_4df267da6c48f581bf6ff5f4",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_1204da285323c4c294847daf",
          "domain": "us.embryolisse.com",
          "title": "Exfoliating Milk Powder",
          "used_product_id": "ext_1204da285323c4c294847daf",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_e13d80b8bf9b8dfe44042064",
          "domain": "us.embryolisse.com",
          "title": "SOS Corrective Cream",
          "used_product_id": "ext_e13d80b8bf9b8dfe44042064",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_3a04dcee79f96ee9570e93f3",
          "domain": "us.embryolisse.com",
          "title": "3-in-1 Secret Paste",
          "used_product_id": "ext_3a04dcee79f96ee9570e93f3",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_1f01309541611d783b7fd63c",
          "domain": "us.embryolisse.com",
          "title": "Cicalisse - Restorative & Protective skin Cream - Face, Body, Lip",
          "used_product_id": "ext_1f01309541611d783b7fd63c",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        }
      ],
      "seller_only_evidence": [
        {
          "external_product_id": "ext_76bfd11a0bea190f4c9d32c7",
          "domain": "us.embryolisse.com",
          "title": "Radiant Eye Stick - Cool Treatment For A Brighter Look",
          "used_product_id": "ext_76bfd11a0bea190f4c9d32c7",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_1b4a85868ba125bc6b7040e0",
          "domain": "us.embryolisse.com",
          "title": "Filaderme Emulsion - Face Lotion For Dry Skin",
          "used_product_id": "ext_1b4a85868ba125bc6b7040e0",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_a47933ea068521800615641f",
          "domain": "us.embryolisse.com",
          "title": "Lait-Crème Fluid+ Eco-Refill",
          "used_product_id": "ext_a47933ea068521800615641f",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_4df267da6c48f581bf6ff5f4",
          "domain": "us.embryolisse.com",
          "title": "Cicalisse Hands and Nails",
          "used_product_id": "ext_4df267da6c48f581bf6ff5f4",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_1204da285323c4c294847daf",
          "domain": "us.embryolisse.com",
          "title": "Exfoliating Milk Powder",
          "used_product_id": "ext_1204da285323c4c294847daf",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_e13d80b8bf9b8dfe44042064",
          "domain": "us.embryolisse.com",
          "title": "SOS Corrective Cream",
          "used_product_id": "ext_e13d80b8bf9b8dfe44042064",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_3a04dcee79f96ee9570e93f3",
          "domain": "us.embryolisse.com",
          "title": "3-in-1 Secret Paste",
          "used_product_id": "ext_3a04dcee79f96ee9570e93f3",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_1f01309541611d783b7fd63c",
          "domain": "us.embryolisse.com",
          "title": "Cicalisse - Restorative & Protective skin Cream - Face, Body, Lip",
          "used_product_id": "ext_1f01309541611d783b7fd63c",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        }
      ]
    }
  },
  "active_ingredients": {
    "regulatory_expected": 0,
    "hero_expected": 5,
    "any_active_items": 4,
    "status": [
      {
        "key": "low_signal_active",
        "count": 3
      },
      {
        "key": "ready_hero",
        "count": 3
      },
      {
        "key": "missing_hero",
        "count": 1
      },
      {
        "key": "possibly_inci_guess",
        "count": 1
      }
    ],
    "issues": [
      {
        "key": "active_raw_too_long",
        "count": 3
      },
      {
        "key": "low_signal_active",
        "count": 3
      },
      {
        "key": "active_raw_may_be_full_inci",
        "count": 2
      },
      {
        "key": "missing_hero",
        "count": 1
      },
      {
        "key": "possibly_inci_guess",
        "count": 1
      }
    ],
    "issue_domains": [
      {
        "key": "us.embryolisse.com::active_raw_too_long",
        "count": 3
      },
      {
        "key": "us.embryolisse.com::low_signal_active",
        "count": 3
      },
      {
        "key": "us.embryolisse.com::active_raw_may_be_full_inci",
        "count": 2
      },
      {
        "key": "us.embryolisse.com::missing_hero",
        "count": 1
      },
      {
        "key": "us.embryolisse.com::possibly_inci_guess",
        "count": 1
      }
    ],
    "source_origin": [
      {
        "key": "active_block",
        "count": 4
      },
      {
        "key": "none",
        "count": 4
      }
    ],
    "samples": {
      "low_signal_active": [
        {
          "external_product_id": "ext_76bfd11a0bea190f4c9d32c7",
          "domain": "us.embryolisse.com",
          "title": "Radiant Eye Stick - Cool Treatment For A Brighter Look",
          "status": "low_signal_active",
          "active_items": [],
          "source_origin": "none"
        },
        {
          "external_product_id": "ext_4df267da6c48f581bf6ff5f4",
          "domain": "us.embryolisse.com",
          "title": "Cicalisse Hands and Nails",
          "status": "low_signal_active",
          "active_items": [],
          "source_origin": "none"
        },
        {
          "external_product_id": "ext_3a04dcee79f96ee9570e93f3",
          "domain": "us.embryolisse.com",
          "title": "3-in-1 Secret Paste",
          "status": "low_signal_active",
          "active_items": [],
          "source_origin": "none"
        }
      ],
      "active_raw_too_long": [
        {
          "external_product_id": "ext_1b4a85868ba125bc6b7040e0",
          "domain": "us.embryolisse.com",
          "title": "Filaderme Emulsion - Face Lotion For Dry Skin",
          "status": "ready_hero",
          "active_items": [
            "Squalane"
          ],
          "source_origin": "active_block"
        },
        {
          "external_product_id": "ext_a47933ea068521800615641f",
          "domain": "us.embryolisse.com",
          "title": "Lait-Crème Fluid+ Eco-Refill",
          "status": "possibly_inci_guess",
          "active_items": [
            "Aloe Vera gently repairs and revitalizes skin"
          ],
          "source_origin": "active_block"
        },
        {
          "external_product_id": "ext_4df267da6c48f581bf6ff5f4",
          "domain": "us.embryolisse.com",
          "title": "Cicalisse Hands and Nails",
          "status": "low_signal_active",
          "active_items": [],
          "source_origin": "none"
        }
      ],
      "active_raw_may_be_full_inci": [
        {
          "external_product_id": "ext_1b4a85868ba125bc6b7040e0",
          "domain": "us.embryolisse.com",
          "title": "Filaderme Emulsion - Face Lotion For Dry Skin",
          "status": "ready_hero",
          "active_items": [
            "Squalane"
          ],
          "source_origin": "active_block"
        },
        {
          "external_product_id": "ext_a47933ea068521800615641f",
          "domain": "us.embryolisse.com",
          "title": "Lait-Crème Fluid+ Eco-Refill",
          "status": "possibly_inci_guess",
          "active_items": [
            "Aloe Vera gently repairs and revitalizes skin"
          ],
          "source_origin": "active_block"
        }
      ],
      "possibly_inci_guess": [
        {
          "external_product_id": "ext_a47933ea068521800615641f",
          "domain": "us.embryolisse.com",
          "title": "Lait-Crème Fluid+ Eco-Refill",
          "status": "possibly_inci_guess",
          "active_items": [
            "Aloe Vera gently repairs and revitalizes skin"
          ],
          "source_origin": "active_block"
        }
      ],
      "missing_hero": [
        {
          "external_product_id": "ext_1204da285323c4c294847daf",
          "domain": "us.embryolisse.com",
          "title": "Exfoliating Milk Powder",
          "status": "missing_hero",
          "active_items": [],
          "source_origin": "none"
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
