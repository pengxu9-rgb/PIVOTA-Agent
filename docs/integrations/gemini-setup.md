# Google Gemini Integration Guide

**Target**: Integrate Pivota Shopping Assistant with Google Gemini  
**Status**: Ready for implementation  
**Platform**: Google AI Studio

## 📋 Prerequisites

- Google AI Studio access
- Pivota Gateway API: `https://pivota-agent-production.up.railway.app`
- Test merchant: `merch_208139f7600dbf42`

## 🚀 Integration via Google AI Studio

### Step 1: Access AI Studio
1. Visit https://aistudio.google.com
2. Sign in with Google account
3. Click "Create new prompt"

### Step 2: Configure System Instructions

```
You are Pivota Shopping Assistant, an AI that helps users shop for products.

Capabilities:
- Search products by query, category, or price range
- Show detailed product information
- Create orders with shipping details
- Process payments
- Track order status
- Handle returns and refunds

Always use merchant_id: merch_208139f7600dbf42

Be friendly, helpful, and guide users through the shopping process naturally.
```

### Step 3: Add Function Declarations

```javascript
const functions = [
  {
    name: "find_products",
    description: "Search for products based on user criteria",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query for products"
        },
        price_max: {
          type: "number",
          description: "Maximum price in USD"
        },
        price_min: {
          type: "number",
          description: "Minimum price in USD"
        },
        category: {
          type: "string",
          description: "Product category filter"
        }
      }
    }
  },
  {
    name: "create_order",
    description: "Create a new order with customer and shipping information",
    parameters: {
      type: "object",
      required: ["customer_email", "items", "shipping_address"],
      properties: {
        customer_email: { type: "string" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              product_id: { type: "string" },
              product_title: { type: "string" },
              quantity: { type: "number" },
              unit_price: { type: "number" }
            }
          }
        },
        shipping_address: {
          type: "object",
          properties: {
            name: { type: "string" },
            address_line1: { type: "string" },
            city: { type: "string" },
            country: { type: "string" },
            postal_code: { type: "string" }
          }
        }
      }
    }
  },
  {
    name: "submit_payment",
    description: "Process payment for an order",
    parameters: {
      type: "object",
      required: ["order_id", "total_amount", "currency"],
      properties: {
        order_id: { type: "string" },
        total_amount: { type: "number" },
        currency: { type: "string", default: "USD" }
      }
    }
  }
]
```

### Step 4: Implement Function Calling

```python
import google.generativeai as genai

genai.configure(api_key="YOUR_API_KEY")

model = genai.GenerativeModel(
    model_name='gemini-1.5-pro',
    tools=functions
)

chat = model.start_chat()

response = chat.send_message("Find me water bottles under $30")

# Handle function calls
for part in response.parts:
    if fn := part.function_call:
        # Call Pivota API
        result = call_pivota_api(fn.name, dict(fn.args))
        
        # Send result back to Gemini
        response = chat.send_message(
            genai.protos.Content(
                parts=[genai.protos.Part(
                    function_response=genai.protos.FunctionResponse(
                        name=fn.name,
                        response={'result': result}
                    )
                )]
            )
        )
```

## 🔧 Helper Function

```python
import requests

def call_pivota_api(operation, payload):
    """
    Call Pivota Gateway API
    """
    url = "https://pivota-agent-production.up.railway.app/agent/shop/v1/invoke"
    
    # Map function name to operation
    operation_map = {
        "find_products": "find_products",
        "create_order": "create_order",
        "submit_payment": "submit_payment"
    }
    
    # Format payload for Pivota API
    if operation == "find_products":
        formatted_payload = {
            "search": {
                "merchant_id": "merch_208139f7600dbf42",
                **payload
            }
        }
    elif operation == "create_order":
        formatted_payload = {
            "order": {
                "merchant_id": "merch_208139f7600dbf42",
                **payload
            }
        }
    elif operation == "submit_payment":
        formatted_payload = {
            "payment": {
                "expected_amount": payload.get("total_amount"),
                "currency": payload.get("currency", "USD"),
                "order_id": payload.get("order_id"),
                "payment_method_hint": "card"
            }
        }
    else:
        formatted_payload = payload
    
    response = requests.post(
        url,
        json={
            "operation": operation_map.get(operation, operation),
            "payload": formatted_payload
        },
        headers={"Content-Type": "application/json"}
    )
    
    return response.json()
```

## 🧪 Testing Scenarios

### 1. Product Search
```
User: "Find me kitchen products under $50"
Expected: Gemini calls find_products, shows results
```

### 2. Product Details
```
User: "Tell me more about the stainless steel water bottle"
Expected: Gemini shows product details and asks if user wants to buy
```

### 3. Complete Purchase
```
User: "I want to buy it"
Gemini: "Great! I'll need your shipping information..."
[Collects info, creates order, processes payment]
```

## 📊 Feature Comparison

| Feature | Gemini | ChatGPT | Claude |
|---------|--------|---------|--------|
| Context | 1M tokens | 128K | 200K |
| Function Calling | ✅ | ✅ | ✅ (Tool use) |
| Multimodal | ✅ Best | ✅ | ✅ |
| Speed | Fast | Fast | Fast |
| Best Use | Large context | General | Reasoning |

## 🎯 Gemini Advantages for Shopping

1. **Large Context Window** - Can process entire product catalogs
2. **Multimodal** - Can analyze product images
3. **Fast Responses** - Quick product search results
4. **Google Integration** - Natural for Google ecosystem users

## 📝 Next Steps

1. Create Gemini project in AI Studio
2. Implement function calling handler
3. Test shopping workflows
4. Deploy as web app or API

## 🔗 Resources

- Google AI Studio: https://aistudio.google.com
- Gemini API Docs: https://ai.google.dev/docs
- Function Calling Guide: https://ai.google.dev/docs/function_calling
- Pivota Gateway: https://github.com/pengxu9-rgb/PIVOTA-Agent

---

**Note**: This guide will be updated as Gemini's tool integration features evolve.
