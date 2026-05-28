# KB x Commerce Index Readiness Audit

Generated: 2026-05-28T10:53:07.134Z

Scope: active external seeds, market=US, domain=theinkeylist.com, include_attached=true, limit=500

Report directory: /private/tmp/pivota-agent-product-intel-tail-20260528/reports/markato_expansion_status_20260524/wave48_product_intel_tail_20260528/theinkeylist_domain_audit_before

## Executive Numbers

- Rows scanned: 9
- Terminal hold rows: 0
- Action-required rows: 7
- DB Serving Ready rows: 2 (0.2222)
- DB Serving Ready rows excluding terminal holds: 2 (0.2222)
- External index published rows: 0
- Direct KB displayable rows: 9
- Direct KB high-quality-ready rows: 2
- Identity ready rows: 9
- Public commerce doc groups built by dry-run: 9
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
| kb_blocked | 7 |
| db_serving_ready | 2 |

## Top Domains

| Domain | Seed rows | Terminal holds | DB serving ready | Ready rate | Actionable ready rate | External index published | Top blocker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| theinkeylist.com | 9 | 0 | 2 | 0.2222 | 0.2222 | 0 | kb_blocked |

## Existing PDP/KB Readiness Summary

```json
{
  "scanned": 9,
  "by_market": {
    "US": 9
  },
  "by_domain": [
    {
      "key": "theinkeylist.com",
      "count": 9
    }
  ],
  "by_product_family": [
    {
      "key": "single_formula",
      "count": 9
    }
  ],
  "coverage": {
    "missing_inci": 2,
    "missing_active_raw": 2,
    "missing_details": 2,
    "missing_how_to": 0,
    "missing_faq": 5
  },
  "pivota_insights": {
    "direct": {
      "displayable": 9,
      "high_quality_ready": 2,
      "missing_kb": 0,
      "not_displayable": 0
    },
    "effective": {
      "displayable": 9,
      "high_quality_ready": 2,
      "missing_kb": 0,
      "not_displayable": 0,
      "borrowed_from_sibling": 0
    },
    "effective_issues": [
      {
        "key": "quality_eligible",
        "count": 8
      },
      {
        "key": "missing_card_highlight",
        "count": 7
      },
      {
        "key": "empty_watchouts",
        "count": 3
      },
      {
        "key": "public_sensitive_claim",
        "count": 1
      }
    ],
    "effective_issue_domains": [
      {
        "key": "theinkeylist.com::quality_eligible",
        "count": 8
      },
      {
        "key": "theinkeylist.com::missing_card_highlight",
        "count": 7
      },
      {
        "key": "theinkeylist.com::empty_watchouts",
        "count": 3
      },
      {
        "key": "theinkeylist.com::public_sensitive_claim",
        "count": 1
      }
    ],
    "quality_state": [
      {
        "key": "eligible",
        "count": 8
      },
      {
        "key": "reviewed",
        "count": 1
      }
    ],
    "evidence_profile": [
      {
        "key": "community_supported",
        "count": 5
      },
      {
        "key": "seller_plus_formula",
        "count": 4
      }
    ],
    "samples": {
      "missing_card_highlight": [
        {
          "external_product_id": "ext_0b3d97758bc02698aaf31ed7",
          "domain": "theinkeylist.com",
          "title": "Tranexamic Acid Serum",
          "used_product_id": "ext_0b3d97758bc02698aaf31ed7",
          "quality_state": "eligible",
          "evidence_profile": "community_supported"
        },
        {
          "external_product_id": "ext_378d80a20c6f872e94e9ca86",
          "domain": "theinkeylist.com",
          "title": "Supersize Omega Water Cream - 100ml",
          "used_product_id": "ext_378d80a20c6f872e94e9ca86",
          "quality_state": "eligible",
          "evidence_profile": "community_supported"
        },
        {
          "external_product_id": "ext_3eeaf9c029c24e5a0cbab749",
          "domain": "theinkeylist.com",
          "title": "PDRN Serum",
          "used_product_id": "ext_3eeaf9c029c24e5a0cbab749",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
        },
        {
          "external_product_id": "ext_4e6158b5e6f187c03c87b013",
          "domain": "theinkeylist.com",
          "title": "10% Azelaic Acid Serum for Redness Relief",
          "used_product_id": "ext_4e6158b5e6f187c03c87b013",
          "quality_state": "eligible",
          "evidence_profile": "community_supported"
        },
        {
          "external_product_id": "ext_6f885ffc900b6c99115c25e9",
          "domain": "theinkeylist.com",
          "title": "Supersize Hyaluronic Acid Serum - 100ml",
          "used_product_id": "ext_6f885ffc900b6c99115c25e9",
          "quality_state": "eligible",
          "evidence_profile": "community_supported"
        },
        {
          "external_product_id": "ext_7f2927806c10ab6988776684",
          "domain": "theinkeylist.com",
          "title": "Advanced 0.2% Retinal Serum",
          "used_product_id": "ext_7f2927806c10ab6988776684",
          "quality_state": "eligible",
          "evidence_profile": "community_supported"
        },
        {
          "external_product_id": "ext_fe0c55a05a505ad59ddd7f0c",
          "domain": "theinkeylist.com",
          "title": "360° Acne Clearing Serum",
          "used_product_id": "ext_fe0c55a05a505ad59ddd7f0c",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
        }
      ],
      "public_sensitive_claim": [
        {
          "external_product_id": "ext_3eeaf9c029c24e5a0cbab749",
          "domain": "theinkeylist.com",
          "title": "PDRN Serum",
          "used_product_id": "ext_3eeaf9c029c24e5a0cbab749",
          "quality_state": "eligible",
          "evidence_profile": "seller_plus_formula"
        }
      ]
    }
  },
  "active_ingredients": {
    "regulatory_expected": 0,
    "hero_expected": 9,
    "any_active_items": 8,
    "status": [
      {
        "key": "ready_hero",
        "count": 6
      },
      {
        "key": "missing_hero",
        "count": 1
      },
      {
        "key": "possibly_inci_guess",
        "count": 1
      },
      {
        "key": "ready_other",
        "count": 1
      }
    ],
    "issues": [
      {
        "key": "active_raw_may_be_full_inci",
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
    "issue_domains": [
      {
        "key": "theinkeylist.com::active_raw_may_be_full_inci",
        "count": 3
      },
      {
        "key": "theinkeylist.com::missing_hero",
        "count": 1
      },
      {
        "key": "theinkeylist.com::possibly_inci_guess",
        "count": 1
      }
    ],
    "source_origin": [
      {
        "key": "pdp_section",
        "count": 7
      },
      {
        "key": "active_block",
        "count": 1
      },
      {
        "key": "none",
        "count": 1
      }
    ],
    "samples": {
      "active_raw_may_be_full_inci": [
        {
          "external_product_id": "ext_378d80a20c6f872e94e9ca86",
          "domain": "theinkeylist.com",
          "title": "Supersize Omega Water Cream - 100ml",
          "status": "ready_hero",
          "active_items": [
            "Ceramide Complex",
            "Glycerin",
            "Betaine",
            "Niacinamide"
          ],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_6f885ffc900b6c99115c25e9",
          "domain": "theinkeylist.com",
          "title": "Supersize Hyaluronic Acid Serum - 100ml",
          "status": "ready_hero",
          "active_items": [
            "Hyaluronic Acid",
            "Matrixyl 3000 Peptide"
          ],
          "source_origin": "pdp_section"
        },
        {
          "external_product_id": "ext_ba77f628da48958583f0f49f",
          "domain": "theinkeylist.com",
          "title": "Starter Retinol Serum",
          "status": "ready_hero",
          "active_items": [
            "Retinal",
            "Hydroxypinacolone Retinoate",
            "Retinol"
          ],
          "source_origin": "pdp_section"
        }
      ],
      "possibly_inci_guess": [
        {
          "external_product_id": "ext_3eeaf9c029c24e5a0cbab749",
          "domain": "theinkeylist.com",
          "title": "PDRN Serum",
          "status": "possibly_inci_guess",
          "active_items": [
            "PDRN",
            "Glycerin"
          ],
          "source_origin": "pdp_section"
        }
      ],
      "missing_hero": [
        {
          "external_product_id": "ext_7f2927806c10ab6988776684",
          "domain": "theinkeylist.com",
          "title": "Advanced 0.2% Retinal Serum",
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
