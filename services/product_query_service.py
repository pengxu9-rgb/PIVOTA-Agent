from __future__ import annotations

import json
from typing import Any, List, Optional, Tuple

from db.database import database
from models.standard_product import StandardProduct


async def get_products_hybrid(
    *,
    merchant_id: str,
    limit: int,
    agent_id: str,
    background_tasks: Any = None,
) -> Tuple[List[StandardProduct], str, Optional[str]]:
    """
    Best-effort product fetch for the Python Shopping Gateway routes.

    This implementation intentionally stays minimal:
    - Prefer cache reads from `products_cache` when DB is available.
    - If DB isn't configured/connected, return an empty list with an error note.
    """
    _ = agent_id
    _ = background_tasks

    query = """
        SELECT product_data
        FROM products_cache
        WHERE merchant_id = :merchant_id
        ORDER BY cached_at DESC
        LIMIT :limit
    """
    try:
        rows = await database.fetch_all(query, {"merchant_id": merchant_id, "limit": limit})
    except Exception as e:
        return [], "cache", f"DB unavailable: {e.__class__.__name__}"

    products: List[StandardProduct] = []
    for row in rows or []:
        pdata = row.get("product_data") if isinstance(row, dict) else None
        if isinstance(pdata, str):
            try:
                pdata = json.loads(pdata)
            except Exception:
                continue
        if not isinstance(pdata, dict):
            continue
        try:
            p = StandardProduct(**pdata)
            if not p.merchant_id:
                p.merchant_id = merchant_id
            products.append(p)
        except Exception:
            continue

    return products, "cache", None

