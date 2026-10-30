#!/usr/bin/env python3
"""Regenerate tests/fixtures/non_product_listing_parity.json from pivota-backend's own rule.

Usage: python3 scripts/dev/gen-non-product-listing-parity.py <path to pivota-backend
services/index_pipeline_state_service.py>

Runs the backend's _is_non_core_product over the corpus below and writes its verdict for every
row. The gateway twin (src/auroraBff/relationshipCatalogServingGate.js) is tested against those
verdicts. Only the rule's own definitions are executed (no backend imports, no database).
"""
import ast
import json
import pathlib
import re
import sys
from typing import Any, Dict

WANTED = {
    "_NON_CORE_PRODUCT_RE", "_NON_CORE_COMPACT_RE", "_NON_PRODUCT_LISTING_RE", "_DONATION_RE",
    "_DONATION_ADD_ON_RE", "_NON_PRODUCT_TITLE_START_RE", "_NON_PRODUCT_TYPES",
    "_is_non_core_product", "_is_non_product_title",
}

# Rows whose backend verdict comes only from the sample / GWP / packette / sticker arms, which the
# graph deliberately does not mirror (see the gateway module's header).
GRAPH_KEEPS = {
    "Floral Eau De Parfum Sample Vials", "Deluxe Sample Lip Oil", "Free Gift With Purchase Pouch",
    "Serum Packette", "Enamel Stickers Set",
}

TITLES = [
    # Not products (backend #2664 corpus, and the gift-card arm of the old rule).
    "Heart To Tarte Donation", "Donate To The Clara Lionel Foundation", "Add-on Donation",
    "Round Up Donation", "GIFT VOUCHER", "Shipping Protection by Route", "SavedBy Package Protection",
    "Green Package Protection", "Delivery Guarantee", "Gift Certificate", "$50 E-Voucher",
    "Route Insurance", "Order Protection", "Shipping Insurance", "Tip", "Add a Tip", "Tips",
    "Gratuity", "Booking Deposit", "Pre-Order Deposit", "Deposit", "Deposit for Custom Order",
    "Deposit - $50", "Deposit: Custom Order", "Deposit - For Bridal Makeup", "Store Credit",
    "Tip Jar", "$25 Gift Card", "Gift Card", "Pixi E-Gift Card 25",
    # Real products carrying the same words.
    "Pro Filt'r Soft Matte Longwear Foundation", "Liquid Foundation Brush", "Q-Tip Precision Tips Swabs",
    "Fingertip Blending Sponge", "Lip Tip Liquid Lipstick", "Tip Top Nail Polish", "Colour Deposit Mask",
    "Color Depositing Conditioner", "Lipstick (10% of Proceeds Donated to Charity)",
    "Charity Pot Body Lotion", "Holiday Gift Set", "Route 66 Eau de Parfum", "Buy One, Donate One Lip Balm",
    "Deposit Only Hair Color", "Deposit-Only Color Gloss", "Deposit (Color Mask) Red",
    "Lip Gloss + $1 Donation", "Pink Lip Balm (Donation Edition)", "Ocean Donation Edition Sunscreen",
    "Gift Card Holder Pouch", "Gift Cards Holders Set", "Gift Cardigan Scent Candle",
    "Rose Voucher Balm", "Store Creditcard Holder",
    # Unicode around the anchors (Python and JS read \\W / \\b differently outside ASCII).
    "Tipé", "éTip", "Donation édition", "Café Tip", "— Tip —",
    "Tip ", "Donationé", "éDonation", "Deposit - ٥", "Lip Gloss + ١ Donation",
    "Donateé Serum", "Deposit foré",
    # Sample-family rows the graph keeps (GRAPH_KEEPS).
    *sorted(GRAPH_KEEPS),
]

TYPES = ["Donation", "Gift Card", "gift_card", "Gift Cards", "e-gift card", "Insurance", "  Gift Card  ",
         "", "Gift Set", "Gifts", "makeup", "Beauty Product", "Tools", "Tips", "tip", "Deposit"]

URLS = [
    "https://example.com/collections/donations/products/lip-balm",
    "https://example.com/collections/order-protection/products/lip-balm",
    "https://example.com/products/gift-voucher-lip-balm",
    "https://example.com/products/gift-card",
    "https://example.com/products/shippingprotection",
    "https://example.com/products/gift-card-holder",
    "https://example.com/donate",
]


def load_rule(path: pathlib.Path) -> Dict[str, Any]:
    tree = ast.parse(path.read_text())
    keep = []
    for node in tree.body:
        names = []
        if isinstance(node, ast.Assign):
            names = [t.id for t in node.targets if isinstance(t, ast.Name)]
        elif isinstance(node, ast.FunctionDef):
            names = [node.name]
        if WANTED.intersection(names):
            keep.append(node)
    found = {n.name if isinstance(n, ast.FunctionDef) else n.targets[0].id for n in keep}
    missing = WANTED - found
    if missing:
        sys.exit(f"rule definitions not found: {sorted(missing)}")
    scope: Dict[str, Any] = {"re": re, "Dict": Dict, "Any": Any}
    exec(compile(ast.Module(body=keep, type_ignores=[]), str(path), "exec"), scope)
    return scope


def main() -> None:
    rule = load_rule(pathlib.Path(sys.argv[1]))
    verdict = rule["_is_non_core_product"]

    def row(titles, url="https://example.com/products/listing", product_type=""):
        first, second = (titles + [titles[0]])[:2]
        backend = verdict({"seed_title": first, "pdp_title": second, "canonical_url": url,
                           "product_type": product_type}, seed_title=first)
        graph_keeps = bool(set(titles) & GRAPH_KEEPS)
        return {"titles": titles, "url": url, "product_type": product_type, "backend": bool(backend),
                "graph_keeps": graph_keeps, "expected": bool(backend) and not graph_keeps}

    rows = [row([t]) for t in TITLES]
    rows += [row(["Gel-X Sculpted Almond"], product_type=t) for t in TYPES]
    rows += [row(["Lip Balm"], url=u) for u in URLS]
    rows += [row(["Lip Gloss", "Lip Gloss"], url="https://example.com/donate"), row(["Brush", "Tip"]),
             row(["Glow Serum", "Shipping"]), row(["Order", "Protection Serum"])]
    out = pathlib.Path(__file__).resolve().parents[2] / "tests/fixtures/non_product_listing_parity.json"
    out.write_text(json.dumps({
        "_source": "pivota-backend services/index_pipeline_state_service.py (#2664); "
                   "regenerate with scripts/dev/gen-non-product-listing-parity.py",
        "rows": rows,
    }, indent=1, ensure_ascii=False) + "\n")
    print(f"{len(rows)} rows -> {out}")


if __name__ == "__main__":
    main()
