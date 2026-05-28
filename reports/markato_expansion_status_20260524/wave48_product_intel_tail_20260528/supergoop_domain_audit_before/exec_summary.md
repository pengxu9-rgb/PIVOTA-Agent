# KB x Commerce Index Readiness Audit

Generated: 2026-05-28T10:46:13.487Z

Scope: active external seeds, market=US, domain=supergoop.com, include_attached=true, limit=500

Report directory: /private/tmp/pivota-agent-product-intel-tail-20260528/reports/markato_expansion_status_20260524/wave48_product_intel_tail_20260528/supergoop_domain_audit_before

## Executive Numbers

- Rows scanned: 39
- Terminal hold rows: 0
- Action-required rows: 35
- DB Serving Ready rows: 4 (0.1026)
- DB Serving Ready rows excluding terminal holds: 4 (0.1026)
- External index published rows: 0
- Direct KB displayable rows: 33
- Direct KB high-quality-ready rows: 4
- Identity ready rows: 38
- Public commerce doc groups built by dry-run: 38
- Rows with public commerce doc + insight summary: 4
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
| kb_blocked | 33 |
| db_serving_ready | 4 |
| identity_blocked | 1 |
| seed_content_blocked | 1 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| supergoop.com | 39 | 0 | 4 | 0.1026 | 0.1026 | 0 | kb_blocked |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 39,
  "by_market": {
    "US": 39
  },
  "by_domain": [
    {
      "key": "supergoop.com",
      "count": 39
    }
  ],
  "by_product_family": [
    {
      "key": "single_formula",
      "count": 35
    },
    {
      "key": "accessory",
      "count": 3
    },
    {
      "key": "unknown_product",
      "count": 1
    }
  ],
  "coverage": {
    "missing_inci": 6,
    "missing_active_raw": 3,
    "missing_details": 4,
    "missing_how_to": 0,
    "missing_faq": 37
  },
  "pivota_insights": {
    "direct": {
      "displayable": 33,
      "high_quality_ready": 4,
      "missing_kb": 0,
      "not_displayable": 6
    },
    "effective": {
      "displayable": 33,
      "high_quality_ready": 4,
      "missing_kb": 0,
      "not_displayable": 6,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [
      {
        "key": "quality_eligible",
        "count": 32
      },
      {
        "key": "missing_card_highlight",
        "count": 31
      },
      {
        "key": "reviewed_not_displayable",
        "count": 6
      },
      {
        "key": "empty_watchouts",
        "count": 4
      },
      {
        "key": "quality_limited",
        "count": 4
      },
      {
        "key": "seller_only_evidence",
        "count": 4
      },
      {
        "key": "public_generic_marketing_copy",
        "count": 2
      },
      {
        "key": "generic_copy_signal",
        "count": 1
      }
    ],
    "effective_issue_domains": [
      {
        "key": "supergoop.com::quality_eligible",
        "count": 32
      },
      {
        "key": "supergoop.com::missing_card_highlight",
        "count": 31
      },
      {
        "key": "supergoop.com::reviewed_not_displayable",
        "count": 6
      },
      {
        "key": "supergoop.com::empty_watchouts",
        "count": 4
      },
      {
        "key": "supergoop.com::quality_limited",
        "count": 4
      },
      {
        "key": "supergoop.com::seller_only_evidence",
        "count": 4
      },
      {
        "key": "supergoop.com::public_generic_marketing_copy",
        "count": 2
      },
      {
        "key": "supergoop.com::generic_copy_signal",
        "count": 1
      }
    ],
    "quality_state": [
      {
        "key": "eligible",
        "count": 32
      },
      {
        "key": "limited",
        "count": 4
      },
      {
        "key": "verified",
        "count": 2
      },
      {
        "key": "reviewed",
        "count": 1
      }
    ],
    "evidence_profile": [
      {
        "key": "seller_plus_formula",
        "count": 29
      },
      {
        "key": "community_supported",
        "count": 5
      },
      {
        "key": "seller_only",
        "count": 4
      },
      {
        "key": "mixed",
        "count": 1
      }
    ],
    "samples": {
      "missing_card_highlight": [
        {
          "external_product_id": "ext_0231446ecac11c097b5c182a",
          "domain": "supergoop.com",
          "title": "Unseen Sunscreen SPF 50",
          "used_product_id": "ext_0231446ecac11c097b5c182a",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_1d9f58d9eb614ad78f87503e",
          "domain": "supergoop.com",
          "title": "PLAY Lip Shield SPF 30 Coconut",
          "used_product_id": "ext_1d9f58d9eb614ad78f87503e",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_2541610fd3f95d198c98bd01",
          "domain": "supergoop.com",
          "title": "Unseen Sunscreen Stick SPF 40",
          "used_product_id": "ext_2541610fd3f95d198c98bd01",
          "quality_state": "eligible",
          "evidence_profile": "community_supported"
        },
        {
          "external_product_id": "ext_2a7f0f4aac89565439078194",
          "domain": "supergoop.com",
          "title": "PLAY Antioxidant Body Mist SPF 30 with Vitamin C",
          "used_product_id": "ext_2a7f0f4aac89565439078194",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_356103c0072a64c0d2b112f0",
          "domain": "supergoop.com",
          "title": "PLAY Everyday Lotion SPF 30",
          "used_product_id": "ext_356103c0072a64c0d2b112f0",
          "quality_state": "eligible",
          "evidence_profile": "community_supported"
        },
        {
          "external_product_id": "ext_4f05182f81e66c1a648219ec",
          "domain": "supergoop.com",
          "title": "Protec(tint) Daily Skin Tint SPF 50",
          "used_product_id": "ext_4f05182f81e66c1a648219ec",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_52bf3996675b121b766c4303",
          "domain": "supergoop.com",
          "title": "PLAY Antioxidant Body Mist SPF 50 with Vitamin C",
          "used_product_id": "ext_52bf3996675b121b766c4303",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_5cb0a930037cfd06122de114",
          "domain": "supergoop.com",
          "title": "PLAY Mineral Lotion SPF 30",
          "used_product_id": "ext_5cb0a930037cfd06122de114",
          "quality_state": "eligible",
          "evidence_profile": "mixed"
        },
        {
          "external_product_id": "ext_633e8684f7da4e64ef14bbf8",
          "domain": "supergoop.com",
          "title": "Mineral Glowscreen Soft-Radiance Drops SPF 40",
          "used_product_id": "ext_633e8684f7da4e64ef14bbf8",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_732ee259400f476472656719",
          "domain": "supergoop.com",
          "title": "PLAY Lip Shield SPF 30 Strawberry",
          "used_product_id": "ext_732ee259400f476472656719",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
        }
      ],
      "reviewed_not_displayable": [
        {
          "external_product_id": "ext_192d3571e29963d1f55307db",
          "domain": "supergoop.com",
          "title": "SPF! Keychain",
          "used_product_id": "ext_192d3571e29963d1f55307db",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_1d9f58d9eb614ad78f87503e",
          "domain": "supergoop.com",
          "title": "PLAY Lip Shield SPF 30 Coconut",
          "used_product_id": "ext_1d9f58d9eb614ad78f87503e",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_39dea73e212c850cc4ba3dfb",
          "domain": "supergoop.com",
          "title": "SPF! Glass Water Bottle",
          "used_product_id": "ext_39dea73e212c850cc4ba3dfb",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_732ee259400f476472656719",
          "domain": "supergoop.com",
          "title": "PLAY Lip Shield SPF 30 Strawberry",
          "used_product_id": "ext_732ee259400f476472656719",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_e1f5622616eb50523643c2cc",
          "domain": "supergoop.com",
          "title": "Supergoop! Mesh Zip Pouch Bag",
          "used_product_id": "ext_e1f5622616eb50523643c2cc",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_f51b2e9026d47980c5ada3bf",
          "domain": "supergoop.com",
          "title": "Butterfly Hair Clip",
          "used_product_id": "ext_f51b2e9026d47980c5ada3bf",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        }
      ],
      "seller_only_evidence": [
        {
          "external_product_id": "ext_192d3571e29963d1f55307db",
          "domain": "supergoop.com",
          "title": "SPF! Keychain",
          "used_product_id": "ext_192d3571e29963d1f55307db",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_39dea73e212c850cc4ba3dfb",
          "domain": "supergoop.com",
          "title": "SPF! Glass Water Bottle",
          "used_product_id": "ext_39dea73e212c850cc4ba3dfb",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_e1f5622616eb50523643c2cc",
          "domain": "supergoop.com",
          "title": "Supergoop! Mesh Zip Pouch Bag",
          "used_product_id": "ext_e1f5622616eb50523643c2cc",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_f51b2e9026d47980c5ada3bf",
          "domain": "supergoop.com",
          "title": "Butterfly Hair Clip",
          "used_product_id": "ext_f51b2e9026d47980c5ada3bf",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        }
      ],
      "generic_copy_signal": [
        {
          "external_product_id": "ext_a64a5392090b679605a58b02",
          "domain": "supergoop.com",
          "title": "PLAY Body Mousse SPF 50",
          "used_product_id": "ext_a64a5392090b679605a58b02",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
        }
      ],
      "public_generic_marketing_copy": [
        {
          "external_product_id": "ext_e1f5622616eb50523643c2cc",
          "domain": "supergoop.com",
          "title": "Supergoop! Mesh Zip Pouch Bag",
          "used_product_id": "ext_e1f5622616eb50523643c2cc",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        },
        {
          "external_product_id": "ext_f51b2e9026d47980c5ada3bf",
          "domain": "supergoop.com",
          "title": "Butterfly Hair Clip",
          "used_product_id": "ext_f51b2e9026d47980c5ada3bf",
          "quality_state": "limited",
          "evidence_profile": "seller_only"
        }
      ]
    }
  },
  "active_ingredients": {
    "regulatory_expected": 35,
    "hero_expected": 3,
    "any_active_items": 33,
    "status": [
      {
        "key": "ready_regulatory",
        "count": 33
      },
      {
        "key": "not_applicable_product_family",
        "count": 3
      },
      {
        "key": "missing_regulatory",
        "count": 2
      },
      {
        "key": "not_expected_missing",
        "count": 1
      }
    ],
    "issues": [
      {
        "key": "missing_regulatory",
        "count": 2
      }
    ],
    "issue_domains": [
      {
        "key": "supergoop.com::missing_regulatory",
        "count": 2
      }
    ],
    "source_origin": [
      {
        "key": "pdp_section",
        "count": 33
      },
      {
        "key": "none",
        "count": 6
      }
    ],
    "samples": {
      "missing_regulatory": [
        {
          "external_product_id": "ext_39dea73e212c850cc4ba3dfb",
          "domain": "supergoop.com",
          "title": "SPF! Glass Water Bottle",
          "status": "missing_regulatory",
          "active_items": [],
          "source_origin": "none"
        },
        {
          "external_product_id": "ext_df3d4d8854c5e416d2c8a5b3",
          "domain": "supergoop.com",
          "title": "PLAY Lip Shield SPF 30 Mint",
          "status": "missing_regulatory",
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
        "count": 35
      },
      {
        "key": "flagged",
        "count": 4
      }
    ],
    "issues": [
      {
        "key": "wrong_axis_for_category",
        "count": 4
      }
    ],
    "issue_domains": [
      {
        "key": "supergoop.com::wrong_axis_for_category",
        "count": 4
      }
    ],
    "samples": {
      "wrong_axis_for_category": [
        {
          "external_product_id": "ext_633e8684f7da4e64ef14bbf8",
          "domain": "supergoop.com",
          "title": "Mineral Glowscreen Soft-Radiance Drops SPF 40",
          "status": "flagged",
          "examples": [
            {
              "axis_name": "shade",
              "axis_kind": "shade",
              "value": "sunrise",
              "visual": true
            },
            {
              "axis_name": "shade",
              "axis_kind": "shade",
              "value": "golden hour",
              "visual": true
            },
            {
              "axis_name": "shade",
              "axis_kind": "shade",
              "value": "sunset",
              "visual": true
            }
          ]
        },
        {
          "external_product_id": "ext_95cb5b67ba4527b8c34949b2",
          "domain": "supergoop.com",
          "title": "Glowscreen SPF 40",
          "status": "flagged",
          "examples": [
            {
              "axis_name": "shade",
              "axis_kind": "shade",
              "value": "sunrise",
              "visual": true
            },
            {
              "axis_name": "shade",
              "axis_kind": "shade",
              "value": "sunrise",
              "visual": true
            },
            {
              "axis_name": "shade",
              "axis_kind": "shade",
              "value": "sunrise",
              "visual": true
            },
            {
              "axis_name": "shade",
              "axis_kind": "shade",
              "value": "dawn",
              "visual": true
            }
          ]
        },
        {
          "external_product_id": "ext_cf0ebf0bb700023746462779",
          "domain": "supergoop.com",
          "title": "Mineral Mattescreen SPF 40",
          "status": "flagged",
          "examples": [
            {
              "axis_name": "shade",
              "axis_kind": "shade",
              "value": "sunrise",
              "visual": true
            },
            {
              "axis_name": "shade",
              "axis_kind": "shade",
              "value": "sunrise",
              "visual": true
            },
            {
              "axis_name": "shade",
              "axis_kind": "shade",
              "value": "sunrise",
              "visual": true
            },
            {
              "axis_name": "shade",
              "axis_kind": "shade",
              "value": "untinted",
              "visual": true
            }
          ]
        },
        {
          "external_product_id": "ext_f79ad746e7214428de0ae942",
          "domain": "supergoop.com",
          "title": "Glowscreen Sunlighter Stick SPF 45",
          "status": "flagged",
          "examples": [
            {
              "axis_name": "shade",
              "axis_kind": "shade",
              "value": "sunrise",
              "visual": true
            },
            {
              "axis_name": "shade",
              "axis_kind": "shade",
              "value": "golden hour",
              "visual": true
            }
          ]
        }
      ]
    }
  }
}
```

## Notes

- DB Serving Ready is stricter than KB presence. Seller-only or limited evidence is not counted as high-quality pass.
- Commerce dry-run used the same catalog serving document builder with `includeNonPublic=false` and market-filtered source rows derived from `external_product_seeds`; no DB/index writes were attempted.
- A row can have high-quality KB and still fail DB serving readiness if identity or commerce doc hydration does not expose it.
- External index publication is tracked separately and is not a blocker for the current DB-backed serving path.
- Next remediation should start from `gap_backlog.csv` ordered by lane and domain impact.
