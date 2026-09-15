'use strict';

// Identifies the canonical catalog entity-group resolve statement (get_pdp_v2's
// resolve_catalog_signature) in SQL text. It lives in its own dependency-free module so tests
// that mock `../db` can recognise the statement without loading the resolver (which requires
// the real db module). Tests used to key on the text `WITH offer_stats AS`; that CTE was removed
// because it aggregated every catalog_skus x catalog_offers row on each call. Keying on an
// exported tag means a future rewrite breaks those tests loudly instead of silently turning a
// "this statement must NOT run" assertion into one that can never fail.
const CANONICAL_ENTITY_GROUP_SQL_TAG = '/* canonical_catalog_entity_group_resolve */';

module.exports = { CANONICAL_ENTITY_GROUP_SQL_TAG };
