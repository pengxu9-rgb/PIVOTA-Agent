# KB x Commerce Index Readiness Audit

Generated: 2026-05-28T10:47:14.029Z

Scope: active external seeds, market=US, domain=rhodeskin.com, include_attached=true, limit=500

Report directory: /private/tmp/pivota-agent-product-intel-tail-20260528/reports/markato_expansion_status_20260524/wave48_product_intel_tail_20260528/rhode_domain_audit_before

## Executive Numbers

- Rows scanned: 14
- Terminal hold rows: 0
- Action-required rows: 14
- DB Serving Ready rows: 0 (0)
- DB Serving Ready rows excluding terminal holds: 0 (0)
- External index published rows: 0
- Direct KB displayable rows: 14
- Direct KB high-quality-ready rows: 0
- Identity ready rows: 14
- Public commerce doc groups built by dry-run: 14
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
| kb_blocked | 8 |
| seed_content_blocked | 6 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| rhodeskin.com | 14 | 0 | 0 | 0 | 0 | 0 | kb_blocked |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 14,
  "by_market": {
    "US": 14
  },
  "by_domain": [
    {
      "key": "rhodeskin.com",
      "count": 14
    }
  ],
  "by_product_family": [
    {
      "key": "single_formula",
      "count": 10
    },
    {
      "key": "unknown_product",
      "count": 4
    }
  ],
  "coverage": {
    "missing_inci": 0,
    "missing_active_raw": 0,
    "missing_details": 6,
    "missing_how_to": 0,
    "missing_faq": 14
  },
  "pivota_insights": {
    "direct": {
      "displayable": 14,
      "high_quality_ready": 0,
      "missing_kb": 0,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 14,
      "high_quality_ready": 0,
      "missing_kb": 0,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [
      {
        "key": "missing_card_highlight",
        "count": 14
      },
      {
        "key": "quality_eligible",
        "count": 14
      },
      {
        "key": "empty_watchouts",
        "count": 11
      }
    ],
    "effective_issue_domains": [
      {
        "key": "rhodeskin.com::missing_card_highlight",
        "count": 14
      },
      {
        "key": "rhodeskin.com::quality_eligible",
        "count": 14
      },
      {
        "key": "rhodeskin.com::empty_watchouts",
        "count": 11
      }
    ],
    "quality_state": [
      {
        "key": "eligible",
        "count": 14
      }
    ],
    "evidence_profile": [
      {
        "key": "seller_plus_formula",
        "count": 12
      },
      {
        "key": "community_supported",
        "count": 2
      }
    ],
    "samples": {
      "missing_card_highlight": [
        {
          "external_product_id": "ext_03246d53c45c6dcddce7894e",
          "domain": "rhodeskin.com",
          "title": "barrier restore cream",
          "used_product_id": "ext_03246d53c45c6dcddce7894e",
          "quality_state": "eligible",
          "evidence_profile": "community_supported"
        },
        {
          "external_product_id": "ext_1042d177a365881339fa11a9",
          "domain": "rhodeskin.com",
          "title": "peptide lip treatment strawberry glaze",
          "used_product_id": "ext_1042d177a365881339fa11a9",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_2591b74dda0b54e9c70dd47c",
          "domain": "rhodeskin.com",
          "title": "peptide lip tint jelly bean",
          "used_product_id": "ext_2591b74dda0b54e9c70dd47c",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_2a9f633e57e1bd8131d024f8",
          "domain": "rhodeskin.com",
          "title": "pineapple refresh",
          "used_product_id": "ext_2a9f633e57e1bd8131d024f8",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_2aee0dd4eafdbcae677997f0",
          "domain": "rhodeskin.com",
          "title": "peptide lip tint pretzel",
          "used_product_id": "ext_2aee0dd4eafdbcae677997f0",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_4357d33527506b2749d382ed",
          "domain": "rhodeskin.com",
          "title": "barrier butter",
          "used_product_id": "ext_4357d33527506b2749d382ed",
          "quality_state": "eligible",
          "evidence_profile": "community_supported"
        },
        {
          "external_product_id": "ext_4d65feee5bf1b7dc8b0b41f4",
          "domain": "rhodeskin.com",
          "title": "peptide lip boost sugarmint",
          "used_product_id": "ext_4d65feee5bf1b7dc8b0b41f4",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_4e34b75bd56e4802d540069c",
          "domain": "rhodeskin.com",
          "title": "glazing mist",
          "used_product_id": "ext_4e34b75bd56e4802d540069c",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_809e70b6907b6e0fb65cdad5",
          "domain": "rhodeskin.com",
          "title": "peptide lip tint salty tan",
          "used_product_id": "ext_809e70b6907b6e0fb65cdad5",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_843a33f7d9ccb23c6ae227ee",
          "domain": "rhodeskin.com",
          "title": "glazing milk",
          "used_product_id": "ext_843a33f7d9ccb23c6ae227ee",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
        }
      ]
    }
  },
  "active_ingredients": {
    "regulatory_expected": 0,
    "hero_expected": 14,
    "any_active_items": 13,
    "status": [
      {
        "key": "ready_hero",
        "count": 13
      },
      {
        "key": "low_signal_active",
        "count": 1
      }
    ],
    "issues": [
      {
        "key": "active_raw_may_be_full_inci",
        "count": 1
      },
      {
        "key": "low_signal_active",
        "count": 1
      }
    ],
    "issue_domains": [
      {
        "key": "rhodeskin.com::active_raw_may_be_full_inci",
        "count": 1
      },
      {
        "key": "rhodeskin.com::low_signal_active",
        "count": 1
      }
    ],
    "source_origin": [
      {
        "key": "pdp_section",
        "count": 14
      }
    ],
    "samples": {
      "low_signal_active": [
        {
          "external_product_id": "ext_2a9f633e57e1bd8131d024f8",
          "domain": "rhodeskin.com",
          "title": "pineapple refresh",
          "status": "low_signal_active",
          "active_items": [],
          "source_origin": "pdp_section"
        }
      ],
      "active_raw_may_be_full_inci": [
        {
          "external_product_id": "ext_4e34b75bd56e4802d540069c",
          "domain": "rhodeskin.com",
          "title": "glazing mist",
          "status": "ready_hero",
          "active_items": [
            "Ceramide NP",
            "Panthenol (B5)"
          ],
          "source_origin": "pdp_section"
        }
      ]
    }
  },
  "variants": {
    "status": [
      {
        "key": "ready",
        "count": 14
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
