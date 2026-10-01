# Round 5 review evidence

Fixtures are from Claude's read-only production impact file (29 pairs) and the 09-30 sample log (30 pairs). Brand and title are separate fixture fields. The sample log truncates some titles; no missing text was invented. Codex accessed no production system.

Same-product decision: 25/29 suppressed, 4/29 retained. Rows 14, 24, 26 and 27 move from the round-4 result. Falscara has THREE style pairs in this supplied file. Style/scents/flavours are deliberately outside the same-product reason; existing variant/shade reasons are unchanged.

| Pair | Brand | Anchor title | Candidate title | Suppressed |
|---|---|---|---|---|
| 1 | The Ordinary | Saccharomyces Ferment 30% Milky Toner for Gentle Exfoliation and Hydration | Saccharomyces Ferment 30% Milky Toner | yes |
| 2 | The Ordinary | Salicylic Acid 2% Anhydrous Solution, Gentle Exfoliating Serum for Blemishes | Salicylic Acid 2% Anhydrous Solution | yes |
| 3 | The Ordinary | Salicylic Acid 2% Solution, Exfoliating Serum for Acne | Salicylic Acid 2% Solution | yes |
| 4 | The Ordinary | Granactive Retinoid 2% Emulsion for Wrinkles and Uneven Texture | Granactive Retinoid 2% Emulsion | yes |
| 5 | The Ordinary | Saccharomyces Ferment 30% Milky Toner for Gentle Exfoliation and Hydration | Saccharomyces Ferment 30% Milky Toner | yes |
| 6 | The Ordinary | Salicylic Acid 2% Anhydrous Solution | Salicylic Acid 2% Anhydrous Solution, Gentle Exfoliating Serum for Blemishes | yes |
| 7 | COSRX | [COSRX] Hydrium Watery Toner 150ml | Hydrium Watery Toner | yes |
| 8 | Summer Fridays | Body Butter Balm Vanilla Travel Size | Body Butter Balm Vanilla | yes |
| 9 | The Ordinary | Multi-Active Delivery Essence for Hydration | Multi-Active Delivery Essence | yes |
| 10 | The Ordinary | Multi-Active Delivery Essence | Multi-Active Delivery Essence for Hydration | yes |
| 11 | Summer Fridays | Body Butter Balm Pink Guava Travel Size | Body Butter Balm Pink Guava | yes |
| 12 | Summer Fridays | Body Butter Balm Pistachio Milk Travel Size | Body Butter Balm Pistachio Milk | yes |
| 13 | rare beauty | Find Comfort Body & Hair Fragrance Mist Mini | Find Comfort Body & Hair Fragrance Mist - Awaken Confidence - Awaken Confidence | yes |
| 14 | MAKE UP FOR EVER | Rouge Artist For Ever Matte | Rouge Artist For Ever | no |
| 15 | The Ordinary | Niacinamide 5% Face and Body Emulsion for Dark Spots & Uneven Tone | Niacinamide 5% Face and Body Emulsion | yes |
| 16 | Murad | Gentle Glycolic Acid Resurfacing Serum for Sensitive Skin | Gentle Glycolic Acid Resurfacing Serum for Sensitive Skin Refill | yes |
| 17 | Dear Barber | Conditioner 250ml - Barber | Conditioner 1000ml - Barber | yes |
| 18 | Dear Barber | Conditioner 1000ml - Barber | Conditioner 250ml - Barber | yes |
| 19 | Dear Barber | Mattifier 100ml - Barber | Mattifier 20ml - Barber | yes |
| 20 | Dear Barber | Shampoo 250ml - Barber | Shampoo 1000ml - Barber | yes |
| 21 | Dear Barber | Fibre 100ml - Barber | Fibre 20ml - Barber | yes |
| 22 | Dear Barber | Shampoo 1000ml - Barber | Shampoo 250ml - Barber | yes |
| 23 | Stila Cosmetics | Mini Stay All Day® Liquid Lipstick | Stay All Day® Liquid Lipstick | yes |
| 24 | Falscara | Falscara X WICKED: FOR GOOD \| Go On, You're Free \| DIY False Lash Extensions, Natural, Cluster Lash, Wispy Lashes, 10 Wisps, 8mm-10mm | Falscara X WICKED: FOR GOOD \| Love Without Limits \| DIY False Lash Extensions, Natural, Cluster Lash, Wispy Lashes, 10 Wisps, 8mm-10mm | no |
| 25 | Summer Fridays | Mini Pink Dew™ Gel Cleanser | Pink Dew™ Gel Cleanser | yes |
| 26 | Falscara | Falscara X WICKED: FOR GOOD \| Go On, You're Free \| DIY False Lash Extensions, Natural, Cluster Lash, Wispy Lashes, 10 Wisps, 8mm-10mm | Falscara X WICKED: FOR GOOD \| I Couldn't Be Lovelier \| DIY False Lash Extensions, Natural, Cluster Lash, Wispy Lashes, 10 Wisps, 8mm-10mm | no |
| 27 | Falscara | Falscara X WICKED: FOR GOOD \| Go On, You're Free \| DIY False Lash Extensions, Natural, Cluster Lash, Wispy Lashes, 10 Wisps, 8mm-10mm | Falscara X WICKED: FOR GOOD \| Wickedly Wonderful \| DIY False Lash Extensions, Natural, Cluster Lash, Wispy Lashes, 10 Wisps, 8mm-10mm | no |
| 28 | Dear Barber | Strong Hold Pomade 100ml - Barber | Strong Hold Pomade 20ml - Barber | yes |
| 29 | Summer Fridays | Cloud Dew® Gel Cream Moisturizer | Mini Cloud Dew® Gel Cream Moisturizer | yes |

Sample result: only #12 Find Comfort mist Mini/full listing and #20 Saccharomyces toner duplicate are suppressed. All other 28 pairs remain accepted.

| Sample | Anchor title | Candidate title | Suppressed |
|---|---|---|---|
| 1 | Salicylic Acid 2% Anhydrous Solution, Gentle Exfoliating Serum for Ble | Lactic Acid 10% + HA 2% High-Strength Exfoliating Serum for Uneven Tex | no |
| 2 | Multi-Peptide Rich Cream | Multi-Peptide Moisturizer | no |
| 3 | Creamy Eye Treatment with Avocado - 0.51 oz | All About Eyes Eye Cream with Vitamin C - 0.5 oz | no |
| 4 | Salicylic Acid 2% Anhydrous Solution, Gentle Exfoliating Serum for Ble | Salicylic Acid 2% Solution, Exfoliating Serum for Acne | no |
| 5 | [ISNTREE] Hyaluronic Acid Toner 200ml \| 400ml | [ROUND LAB] Birch Juice Moisturizing Toner 300ml | no |
| 6 | Anthelios Melt-in Milk Body & Face Sunscreen Lotion SPF 100 - 3.0 oz | Anthelios UV Air Daily Supercharged Serum Sunscreen SPF 50 | no |
| 7 | [THE ORDINARY] Retinol 0.2% in Squalane 30ml | [FINDIVE] Bakuchiol Toning Ampoule 30ml | no |
| 8 | Advanced Snail Peptide Eye Cream | Age Defender Eye Repair Cream | no |
| 9 | Natural Moisturizing Factors + HA | Natural Moisturizing Factors + Beta Glucan Lightweight Gel Moisturizer | no |
| 10 | Anthelios Melt-in Milk Body & Face Sunscreen Lotion SPF 100 - 3.0 oz | Anthelios Glow Sunscreen SPF 35 - Bronze | no |
| 11 | Collagen Bank Daily Face Moisturizer with SPF 30 - 2.0 oz | Collagen Bank Vitamin C Face Serum Fragrance Free | no |
| 12 | Find Comfort Body & Hair Fragrance Mist Mini | Find Comfort Body & Hair Fragrance Mist - Awaken Confidence - Awaken C | yes |
| 13 | Anua Heartleaf Succinic Moisture Cleansing Foam (150ml) | [ISNTREE] Hyaluronic Acid Low-pH Cleansing Foam 150ml | no |
| 14 | Anua Heartleaf Succinic Moisture Cleansing Foam (150ml) | [iUNIK] Centella Bubble Cleansing Foam 150ml | no |
| 15 | Clear Face Oil-Free Sunscreen SPF 50 | Every. Single. Face. Watery Lotion SPF 50 Sunscreen | no |
| 16 | Anthelios Glow Sunscreen SPF 35 - Bronze | Anthelios Mineral Tinted Ultra Light Face Sunscreen Fluid SPF 50 | no |
| 17 | Anthelios UV Control Sunscreen SPF 50 with Azelaic Acid | Anthelios UV Air Daily Supercharged Serum Sunscreen SPF 50 | no |
| 18 | Awaken Peptide Eye Gel | Advanced Snail Peptide Eye Cream | no |
| 19 | Acne Control Gel Blemish Treatment | Biome-Balancing Clear & Prevent Acne Treatment Serum | no |
| 20 | Saccharomyces Ferment 30% Milky Toner for Gentle Exfoliation and Hydra | Saccharomyces Ferment 30% Milky Toner | yes |
| 21 | Multi-Peptide + Copper Peptides 1% for Wrinkles and Skin Elasticity | GF 15% Serum for Visible Skin Repair and Wrinkles | no |
| 22 | [VELY VELY] Yuja C Sun Serum SPF 50+ PA++++ 30ml | [VELY VELY] Bakuchiol Super Biome Lifting Ampoule 100ml | no |
| 23 | All About Eyes Brightening Serum Concentrate with Retinoid | All About Eyes Rich Eye Cream with Hyaluronic Acid - 0.5 oz | no |
| 24 | Best-Selling Eye Brush Trio | E55 Eye Shading Brush | no |
| 25 | BB Blur Tinted Moisturizer Broad Spectrum SPF 30 Sunscreen - Medium | Anthelios Mineral Tinted Fluid Face Sunscreen SPF 40 - Medium/Deep | no |
| 26 | Addict Lip Glow Butter - 101 Glazed Pink | Addict Lip Glow Lip Balm - 077 Candy | no |
| 27 | Anthelios Glow Sunscreen SPF 35 - Bronze | Anthelios Mineral Ultra-Light Face Sunscreen Fluid SPF 50 | no |
| 28 | Advanced Snail Peptide Eye Cream | Advanced Night Repair Eye Lift + Sculpt Eye Cream | no |
| 29 | Clear Face Oil-Free Sunscreen SPF 50 | Anthelios Mineral Tinted Fluid Face Sunscreen SPF 40 - Medium/Deep | no |
| 30 | [ROUND LAB] Birch Juice Moisturizing Toner 300ml | [ISNTREE] Hyaluronic Acid Toner 200ml \| 400ml | no |

| Probe pair or tail | Same-product suppression |
|---|---|
| EDP for Women / for Men | no |
| Shampoo for Dry Hair / for Oily Hair | no |
| Cream for Body / for Face | no |
| Cream for Dry Skin / for Kids | no |
| Rouge Artist For Ever: Matte/base, Satin/base, Matte/Satin | no |
| Soft Pinch / Soft Pinch Matte | no |
| Sunscreen SPF 30 / SPF 50 | no |
| Retinol 0.2% / 0.5% | no |
| Cream Night / Day | no |
| Cream Rich / Light | no |
| Lip Sleeping Mask, Hydrating Berry / Vanilla | no |
| Cream, Hydrating Berry / Hydrating Vanilla | no |
| Barrier Cream plus Mini, Travel Size, Refill, 30ml, 1 fl. oz | yes |
| Barrier Cream plus for Gentle Hydration, comma Hydrating Cream, spaced dash A Completely New Description | yes |

All 29 fixtures test both directions. All 30 samples and the probes have executable assertions. Six mutations were killed: symmetric for stripping, symmetric comma stripping, sample-only taglines, missing Refill normalization, missing reader filter and missing label_state projection. Reader mutations run against a real PostgreSQL serving view; the collapsed/uncollapsed paths both test limits and AI-only suppression.

Heap benchmark: separate Node --expose-gc processes, identical 20,000 JSON-decoded rows, 8 KiB per snapshot (two per row), all suppressed. Peak heap before 374.57 MB (369.16 MB above baseline); paged after 45.26 MB (39.85 MB above baseline). Measure at query return and after guard work; explicit GC after each batch makes retained-payload comparison reproducible, and does not promise that production V8 will collect at the same times. Only ids survive; snapshot retention is <=500 rows. Reproduce with `node --expose-gc tests/fixtures/relgraph_serving_scan_heap_bench.cjs before` and `after`.

The rate gate excludes guard-blocked and low-confidence decisions from the denominator. A 40-row artifact with 10 guard blocks, 10 low-confidence verdicts and 6 errors now reports 6/20=30%, audits already-applied approvals, then fails ai_review. The 20-review activation threshold still uses reviewed_count.

Validation: full relationship suites with RELGRAPH_TEST_POSTGRES=1: 34 suites, 656 passed, 1 optional benchmark skipped. Exact canonical-main-postgres command on local PG15: 27 suites, 531 passed, 1 optional benchmark skipped.
