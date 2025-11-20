# ChatGPT / OpenAI Integration Guide

**Version: 1.0**  
*Complete guide for integrating Pivota Shopping Agent with ChatGPT and OpenAI API*

## Overview

This guide explains how to integrate the Pivota Shopping Agent with:
- ChatGPT (via Custom GPTs)
- OpenAI API (programmatic access)
- OpenAI Assistants API

## Prerequisites

1. **Pivota Agent Gateway** deployed and accessible
2. **OpenAI API Key** from [platform.openai.com](https://platform.openai.com/api-keys)
3. **Tool Schema** from `docs/tool-schema.json` (v1.0)
4. **System Prompt** from `docs/prompt-system.md` (v1.0)

## Quick Start

### Step 1: Set Up the Gateway

Ensure your Pivota Agent Gateway is running:
```bash
# Clone and install
git clone https://github.com/pengxu9-rgb/PIVOTA-Agent.git
cd PIVOTA-Agent
npm install

# Configure environment
cp env.example .env
# Edit .env with your PIVOTA_API_KEY and OPENAI_API_KEY

# Start the gateway
npm start  # Gateway runs on http://localhost:3000
```

### Step 2: Test with OpenAI API

Use the provided demo script:
```bash
npm run demo:openai
```

Or implement your own:
```javascript
import OpenAI from "openai";
import axios from "axios";
import { readFile } from "fs/promises";

// Load tool schema
const toolSchema = JSON.parse(
  await readFile("docs/tool-schema.json", "utf8")
);

// Initialize OpenAI client
const openai = new OpenAI({ 
  apiKey: process.env.OPENAI_API_KEY 
});

// Gateway endpoint
const GATEWAY_URL = "https://your-gateway.com/agent/shop/v1/invoke";

// Tool calling function
async function callPivotaTool(args) {
  const response = await axios.post(GATEWAY_URL, args, {
    headers: { "Content-Type": "application/json" }
  });
  return response.data;
}

// Main conversation loop
async function runAgent(userMessage) {
  const messages = [
    {
      role: "system",
      content: "You are the Pivota Shopping Agent. Use the pivota_shopping_tool for shopping tasks."
    },
    {
      role: "user",
      content: userMessage
    }
  ];

  const completion = await openai.chat.completions.create({
    model: "gpt-4-turbo-preview",
    messages: messages,
    tools: [{
      type: "function",
      function: toolSchema
    }],
    tool_choice: "auto"
  });

  // Handle tool calls
  const message = completion.choices[0].message;
  if (message.tool_calls) {
    for (const toolCall of message.tool_calls) {
      const args = JSON.parse(toolCall.function.arguments);
      const result = await callPivotaTool(args);
      
      // Continue conversation with tool results
      messages.push(message);
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
        content: JSON.stringify(result)
      });
    }
    
    // Get final response
    const finalResponse = await openai.chat.completions.create({
      model: "gpt-4-turbo-preview",
      messages: messages
    });
    
    return finalResponse.choices[0].message.content;
  }
  
  return message.content;
}
```

## Tool Configuration

### Tool Schema Structure
```json
{
  "name": "pivota_shopping_tool",
  "version": "1.0",
  "description": "Unified shopping tool for product search, ordering, payments, tracking, and after-sales",
  "parameters": {
    "type": "object",
    "properties": {
      "operation": {
        "type": "string",
        "enum": [
          "find_products",
          "get_product_detail",
          "create_order",
          "submit_payment",
          "get_order_status",
          "request_after_sales"
        ]
      },
      "payload": {
        "type": "object",
        "properties": {
          "acp_state": { /* pass through */ },
          "ap2_state": { /* pass through */ },
          "search": { /* for find_products */ },
          "product": { /* for get_product_detail */ },
          "order": { /* for create_order */ },
          "payment": { /* for submit_payment */ },
          "status": { /* for get_order_status, request_after_sales */ }
        }
      }
    }
  }
}
```

### System Prompt Best Practices

Use a concise version of the system prompt:
```
You are the Pivota Shopping Agent. Use the `pivota_shopping_tool` for all shopping tasks:
- Product discovery: find_products
- Order creation: create_order  
- Payment processing: submit_payment
- Order tracking: get_order_status
- After-sales: request_after_sales

Always pass acp_state and ap2_state from previous responses to maintain session continuity.
```

## Custom GPT Configuration

For ChatGPT Plus users creating a Custom GPT:

### 1. Instructions
```
You are the Pivota Shopping Agent, helping users with their shopping needs through the Pivota platform.

Use the pivota_shopping_tool for:
- Finding products based on user preferences
- Creating orders with proper shipping details
- Processing payments securely
- Tracking order status
- Handling refunds and after-sales requests

Always maintain conversation state by passing acp_state and ap2_state between operations.
```

### 2. Actions Configuration
```yaml
openapi: 3.0.0
info:
  title: Pivota Shopping Agent API
  version: 1.0.0
servers:
  - url: https://your-gateway-domain.com
paths:
  /agent/shop/v1/invoke:
    post:
      operationId: pivota_shopping_tool
      summary: Unified shopping operations
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/InvokeRequest'
      responses:
        '200':
          description: Success
          content:
            application/json:
              schema:
                type: object
components:
  schemas:
    InvokeRequest:
      type: object
      required:
        - operation
        - payload
      properties:
        operation:
          type: string
          enum: [find_products, get_product_detail, create_order, submit_payment, get_order_status, request_after_sales]
        payload:
          type: object
```

### 3. Authentication

Configure your Custom GPT with:
- **Type**: API Key
- **Auth Type**: Bearer
- **Header Name**: Authorization
- **API Key**: Your gateway API key (if required)

## Common Integration Patterns

### Shopping Flow Example
```javascript
// 1. Search for products
const searchResult = await callPivotaTool({
  operation: "find_products",
  payload: {
    search: {
      query: "Nike running shoes",
      price_max: 800,
      currency: "CNY",
      city: "Shanghai"
    }
  }
});

// 2. Get product details (optional)
const productDetail = await callPivotaTool({
  operation: "get_product_detail",
  payload: {
    product: {
      merchant_id: "merch_123",
      product_id: "prod_456"
    },
    acp_state: searchResult.acp_state
  }
});

// 3. Create order
const order = await callPivotaTool({
  operation: "create_order",
  payload: {
    order: {
      items: [{
        merchant_id: "merch_123",
        product_id: "prod_456",
        quantity: 1,
        price: 759
      }],
      shipping_address: {
        recipient_name: "John Doe",
        address_line1: "123 Main St",
        city: "Shanghai",
        country: "CN",
        postal_code: "200000"
      }
    },
    acp_state: productDetail.acp_state
  }
});

// 4. Submit payment
const payment = await callPivotaTool({
  operation: "submit_payment",
  payload: {
    payment: {
      order_id: order.order_id,
      expected_amount: order.amount_total,
      currency: "CNY"
    },
    ap2_state: order.ap2_state
  }
});
```

### Error Handling
```javascript
try {
  const result = await callPivotaTool(args);
  
  // Handle specific payment states
  if (result.payment_status === "requires_action") {
    // Show redirect URL or instructions to user
    if (result.redirect_url) {
      console.log("Please complete payment at:", result.redirect_url);
    }
  }
} catch (error) {
  if (error.response) {
    // API returned an error
    console.error("API Error:", error.response.data);
  } else if (error.code === "ECONNABORTED") {
    // Timeout
    console.error("Request timed out");
  } else {
    // Network or other error
    console.error("Error:", error.message);
  }
}
```

## Rate Limits and Best Practices

1. **OpenAI Rate Limits**
   - GPT-4: 40k tokens/min, 200 requests/min
   - GPT-3.5: 60k tokens/min, 3,500 requests/min
   - Plan your integration accordingly

2. **Gateway Considerations**
   - Default timeout: 10 seconds
   - Implement retries for transient failures
   - Use exponential backoff

3. **State Management**
   - Always preserve `acp_state` and `ap2_state`
   - Don't modify state objects
   - Include state in every related operation

4. **Security**
   - Never expose API keys in client code
   - Use environment variables
   - Implement proper authentication for production

## Testing Your Integration

### Test Scenarios

1. **Happy Path**
   ```
   User: "Find me Nike shoes under $100"
   → Search → Show results
   User: "Buy the first one"
   → Create order → Process payment
   ```

2. **Price Comparison**
   ```
   User: "Compare running shoes from different brands"
   → Multiple searches → Present options
   ```

3. **Order Tracking**
   ```
   User: "Where is my order ORDER123?"
   → Get order status → Show tracking info
   ```

4. **Refund Request**
   ```
   User: "I want to return my order"
   → Request after-sales → Guide through process
   ```

### Debug Tips

Enable detailed logging:
```javascript
// Log all tool calls
console.log("Tool call:", JSON.stringify(args, null, 2));
console.log("Tool response:", JSON.stringify(result, null, 2));

// Log OpenAI interactions
console.log("GPT response:", completion.choices[0].message);
```

## Production Deployment

### Checklist
- [ ] Gateway deployed with HTTPS
- [ ] API keys secured in environment variables
- [ ] Error handling implemented
- [ ] Rate limiting configured
- [ ] Monitoring/logging enabled
- [ ] Test with real merchant account

### Monitoring
Track these metrics:
- Tool call success/failure rates by operation
- Average response times
- Payment success rates
- User conversation completion rates

## Troubleshooting

### Common Issues

1. **"Tool not found" error**
   - Verify tool schema is properly loaded
   - Check function name matches exactly

2. **Gateway connection errors**
   - Confirm gateway URL is accessible
   - Check CORS settings if browser-based

3. **State continuity issues**
   - Ensure state objects are passed between calls
   - Don't stringify state objects twice

4. **Payment failures**
   - Verify test mode is enabled
   - Check currency and amount formatting

## Support and Resources

- **GitHub Repository**: https://github.com/pengxu9-rgb/PIVOTA-Agent
- **API Documentation**: See `docs/pivota-api-mapping.md`
- **Protocol Specs**: See `docs/acp-spec-bridge.md` and `docs/ap2-spec-bridge.md`

For additional support, please open an issue in the GitHub repository.
