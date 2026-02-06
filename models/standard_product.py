from __future__ import annotations

from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator


class ProductStatus(str, Enum):
    ACTIVE = "active"
    INACTIVE = "inactive"
    DRAFT = "draft"
    DELETED = "deleted"


class StandardProduct(BaseModel):
    """
    Minimal "standard product" model shared by similarity + shopping gateway.

    Notes:
    - Many call sites treat `product_id` and `id` interchangeably.
    - We allow extra fields to avoid failing on upstream cache shape changes.
    """

    model_config = ConfigDict(extra="allow")

    # Identifiers
    id: Optional[str] = None
    product_id: Optional[str] = Field(default=None, alias="product_id")
    platform_product_id: Optional[str] = None

    # Commerce metadata
    platform: Optional[str] = None
    merchant_id: Optional[str] = None
    title: Optional[str] = None
    description: Optional[str] = None
    product_type: Optional[str] = None
    price: Optional[float] = None
    currency: Optional[str] = None
    sku: Optional[str] = None
    status: Optional[ProductStatus] = None
    inventory_quantity: Optional[int] = None
    in_stock: Optional[bool] = None

    # Media
    image_url: Optional[str] = None
    images: List[str] = Field(default_factory=list)

    # Arbitrary platform metadata (creator_id, deals, etc.)
    platform_metadata: Dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _normalize_ids(self) -> "StandardProduct":
        # Ensure `product_id` is populated for code paths/tests that key dicts by it.
        if not self.product_id and self.id:
            self.product_id = self.id
        if not self.id and self.product_id:
            self.id = self.product_id
        return self

