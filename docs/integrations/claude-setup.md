# Claude AI Integration Guide

**Target**: Integrate Pivota Shopping Assistant with Claude AI  
**Status**: Ready for implementation  
**Platform**: Anthropic Claude

## 📋 Prerequisites

- Claude Pro or Claude API access
- Pivota Gateway API: `https://pivota-agent-production.up.railway.app`
- Test merchant: `merch_208139f7600dbf42`

## 🚀 Integration Methods

### Method 1: Claude Projects (Recommended)

Claude Projects allows you to create custom AI assistants with tool access.

#### Step 1: Create New Project
1. Open Claude.ai
2. Click "Projects" in sidebar
3. Click "Create Project"
4. Name: "Pivota Shopping Assistant"

#### Step 2: Configure Project Knowledge
Add this to Project Instructions:

```
You are a shopping assistant powered by Pivota. You help users find and purchase products through natural conversation.

## Your Capabilities:
- Search for products
- Show product details
- Create orders
- Process payments
- Track orders
- Handle returns

## Available Tools:
Use the provided tools to interact with the Pivota API.

## Default Merchant:
Always use merchant_id: merch_208139f7600dbf42

## Behavior Guidelines:
- Be friendly and helpful
- Show product images when available
- Confirm order details before proceeding
- Guide users through the checkout process step by step
```

#### Step 3: Add Tools (MCP Integration)

Claude uses the Model Context Protocol (MCP) for tool integration.

Create `pivota-mcp-config.json`:

```json
{
  "mcpServers": {
    "pivota-shopping": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-fetch"],
      "env": {
        "ALLOWED_DOMAINS": "pivota-agent-production.up.railway.app,agent.pivota.cc"
      }
    }
  }
}
```

#### Step 4: Define Tool Functions

In Project Settings, add these tool definitions:

```typescript
// find_products
{
  name: "find_products",
  description: "Search for products by query, price range, or category",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      price_max: { type: "number", description: "Maximum price" },
      price_min: { type: "number", description: "Minimum price" },
      category: { type: "string", description: "Product category" }
    }
  }
}

// create_order
{
  name: "create_order",
  description: "Create a shopping order with customer information",
  input_schema: {
    type: "object",
    required: ["customer_email", "items", "shipping_address"],
    properties: {
      customer_email: { type: "string" },
      items: { type: "array" },
      shipping_address: { type: "object" }
    }
  }
}

// submit_payment
{
  name: "submit_payment",
  description: "Process payment for an order",
  input_schema: {
    type: "object",
    required: ["order_id", "total_amount", "currency"],
    properties: {
      order_id: { type: "string" },
      total_amount: { type: "number" },
      currency: { type: "string", default: "USD" }
    }
  }
}
```

### Method 2: Claude API Integration

For programmatic integration using Claude's API:

```python
import anthropic
import requests

client = anthropic.Anthropic(api_key="your-api-key")

tools = [
    {
        "name": "find_products",
        "description": "Search for products on Pivota",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query"}
            },
            "required": ["query"]
        }
    }
]

def call_pivota_api(operation, payload):
    response = requests.post(
        "https://pivota-agent-production.up.railway.app/agent/shop/v1/invoke",
        json={"operation": operation, "payload": payload}
    )
    return response.json()

message = client.messages.create(
    model="claude-3-5-sonnet-20241022",
    max_tokens=1024,
    tools=tools,
    messages=[{"role": "user", "content": "Find me a water bottle under $30"}]
)

# Handle tool calls
if message.stop_reason == "tool_use":
    tool_use = next(block for block in message.content if block.type == "tool_use")
    result = call_pivota_api(tool_use.name, tool_use.input)
    # Continue conversation with result...
```

## 🧪 Testing

### Test Scenarios:
1. **Product Search**
   - "Find water bottles under $30"
   - "Show me kitchen products"
   - "I need a gift for someone who loves cooking"

2. **Complete Purchase**
   - Select a product
   - Provide shipping info
   - Complete payment

3. **Order Tracking**
   - "Track my order ORD_123456"
   - "Where is my package?"

## 📊 Comparison: Claude vs ChatGPT

| Feature | ChatGPT | Claude |
|---------|---------|--------|
| Custom GPT | ✅ Yes | ✅ Projects |
| Tool Calling | ✅ Function calling | ✅ Tool use |
| Context Window | 128K | 200K |
| Best for | Quick demos | Complex reasoning |
| Pricing | Plus: $20/mo | Pro: $20/mo |

## 🎯 Next Steps

1. Create Claude Project with Pivota tools
2. Test shopping workflows
3. Collect user feedback
4. Optimize instructions based on usage

## 🔗 Resources

- Claude Projects: https://claude.ai/projects
- MCP Documentation: https://modelcontextprotocol.io
- Anthropic API Docs: https://docs.anthropic.com
- Pivota GitHub: https://github.com/pengxu9-rgb/PIVOTA-Agent

---

**Ready to integrate?** Follow the steps above to create your Claude-powered shopping assistant!
