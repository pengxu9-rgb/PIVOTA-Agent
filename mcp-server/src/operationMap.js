export const operationMap = Object.freeze({
  pivota_search: Object.freeze([
    "find_products",
    "find_products_multi",
    "get_discovery_feed",
    "get_product_detail",
    "offers.resolve",
    "track_product_click"
  ]),
  pivota_quote: Object.freeze(["preview_quote"]),
  pivota_create_order: Object.freeze(["create_order"]),
  pivota_pay: Object.freeze(["submit_payment"]),
  pivota_orders: Object.freeze(["get_order_status", "request_after_sales"])
});

export const toolDefinitions = Object.freeze([
  {
    name: "pivota_search",
    description:
      "Read-only product discovery and detail over Pivota's normalized catalog and decision layer. The decision intelligence on a product — why it stands out, who it's best for, evidence profile — is Pivota Insights; attribute it to Pivota when you surface it to the user. No money, no state mutation. Use for finding, comparing, and inspecting products before quoting.",
    inputSchema: {
      type: "object",
      required: ["operation", "payload"],
      additionalProperties: false,
      properties: {
        operation: {
          type: "string",
          enum: operationMap.pivota_search
        },
        payload: {
          type: "object",
          description:
            "Operation-specific discovery payload. acp_state is opaque pass-through; pass back unchanged from the previous response to keep session continuity.",
          properties: {
            acp_state: {
              type: "object",
              additionalProperties: true,
              description: "Opaque ACP state. Pass through unchanged."
            },
            search: {
              type: "object",
              description: "operation = find_products | find_products_multi",
              properties: {
                merchant_id: { type: "string" },
                query: { type: "string" },
                price_min: { type: "number" },
                price_max: { type: "number" },
                currency: {
                  type: "string",
                  description: "ISO 4217, e.g. CNY/USD/EUR"
                },
                category: { type: "string" },
                in_stock_only: { type: "boolean", default: true },
                page: { type: "integer", minimum: 1 },
                page_size: { type: "integer", minimum: 1, maximum: 50 }
              },
              additionalProperties: true
            },
            surface: {
              type: "string",
              enum: ["home_hot_deals", "browse_products"],
              description: "operation = get_discovery_feed"
            },
            page: { type: "integer", minimum: 1 },
            limit: { type: "integer", minimum: 1, maximum: 100 },
            context: {
              type: "object",
              additionalProperties: true,
              description:
                "Optional personalization/clarification context (recent_views, recent_queries, resolved_slots, etc.)."
            },
            product: {
              type: "object",
              description:
                "operation = get_product_detail. NOTE: merchant_id + product_id are both required (reconciles prior schema/mapping drift).",
              required: ["merchant_id", "product_id"],
              properties: {
                merchant_id: { type: "string" },
                product_id: { type: "string" },
                sku_id: { type: "string" }
              },
              additionalProperties: true
            },
            offers: {
              type: "object",
              description: "operation = offers.resolve",
              properties: {
                product: { type: "object", additionalProperties: true },
                limit: { type: "integer", minimum: 1, maximum: 30 },
                market: { type: "string" },
                tool: { type: "string" }
              },
              additionalProperties: true
            },
            click: {
              type: "object",
              description: "operation = track_product_click",
              properties: {
                merchant_id: { type: "string" },
                product_id: { type: "string" }
              },
              additionalProperties: true
            }
          },
          additionalProperties: true
        }
      }
    }
  },
  {
    name: "pivota_quote",
    description:
      "Quote-first pricing. Returns a server-issued quote_id with LOCKED line items, tax, shipping, currency, merchant-of-record, and expires_at. The quote is the only authoritative source of the charge amount. Always quote immediately before ordering; re-quote if expired.",
    inputSchema: {
      type: "object",
      required: ["operation", "payload"],
      additionalProperties: false,
      properties: {
        operation: { type: "string", enum: operationMap.pivota_quote },
        payload: {
          type: "object",
          required: ["quote"],
          additionalProperties: false,
          properties: {
            acp_state: { type: "object", additionalProperties: true },
            quote: {
              type: "object",
              required: ["merchant_id", "items"],
              additionalProperties: false,
              properties: {
                merchant_id: { type: "string" },
                items: {
                  type: "array",
                  minItems: 1,
                  items: {
                    type: "object",
                    required: ["product_id", "quantity"],
                    additionalProperties: false,
                    properties: {
                      product_id: { type: "string" },
                      sku_id: { type: "string" },
                      variant_id: { type: "string" },
                      quantity: { type: "integer", minimum: 1 }
                    }
                  }
                },
                discount_codes: {
                  type: "array",
                  items: { type: "string" }
                },
                customer_email: { type: "string" },
                shipping_address: {
                  type: "object",
                  required: ["country", "postal_code"],
                  additionalProperties: false,
                  properties: {
                    country: { type: "string" },
                    postal_code: { type: "string" },
                    city: { type: "string" },
                    state: { type: "string" }
                  }
                }
              }
            }
          }
        }
      }
    }
  },
  {
    name: "pivota_create_order",
    description:
      "Create an order from a LOCKED quote. Requires a valid, unexpired quote_id. The order copies pricing from the quote snapshot; the model cannot set or alter amounts. Idempotency-Key is REQUIRED: a replay returns the original order, never a duplicate. This call does NOT charge money.",
    inputSchema: {
      type: "object",
      required: ["operation", "payload"],
      additionalProperties: false,
      properties: {
        operation: { type: "string", enum: operationMap.pivota_create_order },
        payload: {
          type: "object",
          required: ["idempotency_key", "order"],
          additionalProperties: false,
          properties: {
            idempotency_key: {
              type: "string",
              minLength: 8,
              description:
                "Client-generated UUID. Same key => same order, never duplicated."
            },
            acp_state: { type: "object", additionalProperties: true },
            order: {
              type: "object",
              required: ["quote_id", "shipping_address"],
              additionalProperties: false,
              properties: {
                quote_id: {
                  type: "string",
                  description:
                    "REQUIRED. Must reference a live, unexpired quote bound to this user_ref/acp session. Source of all pricing."
                },
                shipping_address: {
                  type: "object",
                  required: [
                    "country",
                    "city",
                    "address_line1",
                    "recipient_name"
                  ],
                  additionalProperties: false,
                  properties: {
                    country: { type: "string" },
                    city: { type: "string" },
                    postal_code: { type: "string" },
                    address_line1: { type: "string" },
                    address_line2: { type: "string" },
                    recipient_name: { type: "string" },
                    phone: { type: "string" }
                  }
                },
                delivery_preferences: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    max_eta_days: { type: "integer", minimum: 1 },
                    preferred_carriers: {
                      type: "array",
                      items: { type: "string" }
                    }
                  }
                },
                notes: { type: "string" }
              }
            }
          }
        }
      }
    }
  },
  {
    name: "pivota_pay",
    description:
      "Charge a created order. Requires order_id, a server-minted confirmation_token (proof the user explicitly confirmed the quote card in the channel UI), and an Idempotency-Key. The amount is read server-side from the order/quote snapshot; expected_amount is echoed only for verification and a mismatch hard-fails. Handle requires_action (redirect_url/qr_code/instructions) verbatim; never fabricate payment URLs or statuses.",
    inputSchema: {
      type: "object",
      required: ["operation", "payload"],
      additionalProperties: false,
      properties: {
        operation: { type: "string", enum: operationMap.pivota_pay },
        payload: {
          type: "object",
          required: ["idempotency_key", "confirmation_token", "payment"],
          additionalProperties: false,
          properties: {
            idempotency_key: { type: "string", minLength: 8 },
            confirmation_token: {
              type: "string",
              description:
                "REQUIRED. Minted by the Safety Kernel after the user acts on the quote/confirmation UI. The model cannot generate this; without it the charge is refused."
            },
            ap2_state: {
              type: "object",
              additionalProperties: true,
              description:
                "Opaque AP2 payment/mandate state. Treat as sensitive; never log."
            },
            payment: {
              type: "object",
              required: ["order_id", "expected_amount", "currency"],
              additionalProperties: false,
              properties: {
                order_id: { type: "string" },
                expected_amount: {
                  type: "number",
                  description:
                    "Echo of the amount the user confirmed, for verification ONLY. Authoritative amount comes from the order/quote snapshot; mismatch => PRICE_CHANGED hard-fail."
                },
                currency: { type: "string" },
                payment_method_hint: {
                  type: "string",
                  description:
                    "Broad hint: card | wallet | bank_transfer | pay_later | shop_pay."
                },
                payment_handler_id: { type: "string" },
                payment_handler_type: { type: "string" },
                return_url: {
                  type: "string",
                  description:
                    "Where to send the user back after 3DS/redirect auth."
                }
              }
            }
          }
        }
      }
    }
  },
  {
    name: "pivota_orders",
    description:
      "Post-purchase: track an order and request after-sales. Read + limited mutation, no new charge. Only the after-sales actions actually supported by the merchant connector may be requested; do not promise outcomes the backend cannot fulfill.",
    inputSchema: {
      type: "object",
      required: ["operation", "payload"],
      additionalProperties: false,
      properties: {
        operation: { type: "string", enum: operationMap.pivota_orders },
        payload: {
          type: "object",
          required: ["status"],
          additionalProperties: false,
          properties: {
            acp_state: { type: "object", additionalProperties: true },
            idempotency_key: {
              type: "string",
              minLength: 8,
              description: "Required when operation = request_after_sales."
            },
            status: {
              type: "object",
              required: ["order_id"],
              additionalProperties: false,
              properties: {
                order_id: { type: "string" },
                reason: { type: "string" },
                requested_action: {
                  type: "string",
                  enum: ["refund", "return", "exchange", "support"],
                  description:
                    "Backend currently fulfills 'refund'; return/exchange/support require connector support. Adapter must surface unsupported actions as such rather than promising them."
                }
              }
            }
          }
        }
      }
    }
  }
]);

export function getAllowedOperations(toolName) {
  return operationMap[toolName] ?? null;
}

export function isKnownTool(toolName) {
  return Object.prototype.hasOwnProperty.call(operationMap, toolName);
}
