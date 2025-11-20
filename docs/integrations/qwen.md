# Qwen (通义千问) Integration Guide

**Version: 1.0**  
*Integration guide for Pivota Shopping Agent with Alibaba Qwen*

## Status: TODO

This integration is planned but not yet implemented.

## Overview

Qwen (通义千问) is Alibaba's large language model with function calling capabilities. This guide will cover:
- Setting up Qwen API access via Alibaba Cloud
- Configuring function definitions in Qwen format
- Implementing bilingual shopping experiences
- Leveraging Qwen's e-commerce optimizations

## Prerequisites

1. **Alibaba Cloud Account** with Model Service activated
2. **Qwen API Key** from Alibaba Cloud console
3. **Pivota Agent Gateway** deployed and accessible
4. **DashScope SDK** or API access

## Implementation Notes

### Qwen-Specific Features
- Native Chinese language understanding
- E-commerce domain expertise
- Alibaba ecosystem integration
- Multi-modal capabilities (Qwen-VL)

### Planned Features
- [ ] Basic function calling setup
- [ ] Bilingual support (中文/English)
- [ ] DashScope SDK integration
- [ ] Cross-border shopping scenarios

## Code Structure (Placeholder)

```javascript
// TODO: Implement Qwen integration
// Using DashScope API

const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY;
const QWEN_MODEL = "qwen-turbo"; // or qwen-plus, qwen-max

// Define function for Qwen
const functionDefinition = {
  name: "pivota_shopping_tool",
  description: "统一购物工具，支持商品搜索、下单、支付、查询订单等功能",
  parameters: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        description: "操作类型",
        enum: [
          "find_products",    // 搜索商品
          "get_product_detail", // 获取商品详情
          "create_order",     // 创建订单
          "submit_payment",   // 提交支付
          "get_order_status", // 查询订单状态
          "request_after_sales" // 申请售后
        ]
      },
      payload: {
        type: "object",
        description: "操作相关的具体参数"
      }
    }
  }
};

// Main conversation flow
async function runQwenAgent(userMessage) {
  // TODO: Implement DashScope API calls
  const response = await fetch('https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${DASHSCOPE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: QWEN_MODEL,
      input: {
        messages: [{
          role: "user",
          content: userMessage
        }]
      },
      parameters: {
        tools: [functionDefinition]
      }
    })
  });
  
  // Handle function calling responses
}
```

## Bilingual Shopping Examples

```javascript
// Chinese shopping query
"我想买一双耐克运动鞋，预算800元以内，送到上海"

// English shopping query  
"I want to buy Nike running shoes under 800 CNY, ship to Shanghai"

// Mixed language support
"帮我search一下Nike的running shoes，价格不超过800块"
```

## Integration Considerations

### Language Handling
- Auto-detect user language
- Maintain language consistency
- Translate product information as needed
- Handle currency and unit conversions

### E-commerce Optimizations
- Leverage Qwen's understanding of Chinese e-commerce
- Support for platform-specific terms (淘宝, 天猫, etc.)
- Handle Chinese address formats
- Support local payment methods

## Resources

- [DashScope Documentation](https://help.aliyun.com/product/2400256.html)
- [Qwen Models](https://github.com/QwenLM/Qwen)
- [Alibaba Cloud Console](https://www.aliyun.com/)
- [通义千问官网](https://tongyi.aliyun.com/)

## Contributing

To implement this integration:
1. Register for DashScope API access
2. Study Qwen's function calling format
3. Create bilingual demo scenarios
4. Test with Chinese and English queries
5. Optimize for cross-border shopping
