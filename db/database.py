from __future__ import annotations

import os
from typing import Any, Mapping, Optional, Sequence

try:
    from databases import Database  # type: ignore
except Exception:  # pragma: no cover
    Database = None  # type: ignore


class _NullDatabase:
    """
    Safe default when DATABASE_URL is not configured.

    Callers generally wrap queries in try/except and treat failures as "no data".
    """

    async def connect(self) -> None:  # noqa: D401
        return None

    async def disconnect(self) -> None:  # noqa: D401
        return None

    async def fetch_one(self, _query: str, _values: Optional[Mapping[str, Any]] = None) -> None:
        return None

    async def fetch_all(self, _query: str, _values: Optional[Mapping[str, Any]] = None) -> Sequence[Mapping[str, Any]]:
        return []


def _build_database() -> Any:
    url = (
        os.getenv("DATABASE_URL")
        or os.getenv("POSTGRES_URL")
        or os.getenv("POSTGRES_PRISMA_URL")
        or ""
    ).strip()

    if not url:
        return _NullDatabase()

    if Database is None:  # pragma: no cover
        # If databases isn't installed, fall back to null DB rather than crashing imports.
        return _NullDatabase()

    return Database(url)


# Singleton used by Python services/routes.
database = _build_database()

