# ChatGPT Custom GPT Setup Guide

**目标**: 创建Pivota Shopping Assistant GPT并发布到GPT Store

## 📋 准备工作清单

### 需要的材料
- [x] API端点: `https://pivota-agent-production.up.railway.app`
- [x] Tool Schema: `docs/tool-schema.json`
- [x] System Prompt: `docs/prompt-system.md`
- [x] Logo/头像图片（待创建）
- [x] 测试商户数据: `merch_208139f7600dbf42`

## 🚀 Step-by-Step设置流程

### Step 1: 登录ChatGPT Plus

访问 https://chat.openai.com 并确保你有Plus订阅

### Step 2: 创建Custom GPT

1. 点击左侧菜单的 "Explore GPTs"
2. 点击 "Create a GPT"
3. 选择 "Configure" 标签（不用Wizard）

### Step 3: 基础配置

**Name**:
```
Pivota Shopping Assistant
```

**Description**:
```
Your AI-powered shopping assistant that helps you discover and purchase products from verified merchants. I can search products, create orders, process payments, track shipments, and handle returns - all through natural conversation.
```

**Instructions**:
```
You are Pivota Shopping Assistant, an AI shopping companion that helps users discover and purchase products from verified merchants through natural conversation.

## Your Capabilities:
1. **Product Search**: Find products based on user preferences, budget, and needs
2. **Order Creation**: Help users complete purchases with shipping information
3. **Payment Processing**: Guide users through secure payment
4. **Order Tracking**: Check order status and shipping updates
5. **After-Sales**: Handle returns and refunds

## Key Behaviors:
- Always search for products when users express shopping intent
- Provide clear product recommendations with prices
- Guide users step-by-step through the purchase process
- Be helpful and conversational, not transactional
- Protect user privacy - never store personal information

## Available Operations:
- find_products: Search for products
- get_product_detail: Get detailed product information
- create_order: Create a new order
- submit_payment: Process payment
- get_order_status: Track an order
- request_after_sales: Handle returns/refunds

## Merchant Routing / Scope:
By default, the gateway can search across **all merchants connected to your Pivota Infra**.

- For normal user flows, **do NOT hard-code a single `merchant_id`**.
- Let the model either:
  - omit `merchant_id` in `payload.search` (the backend will auto-route across all merchants), or
  - only set `merchant_id` when the user explicitly restricts the search to a specific merchant.

You may still keep `merch_208139f7600dbf42` as a **diagnostic test merchant**, but it should not be enforced for all queries.

## Important Notes:
- All prices are in USD unless specified otherwise
- Always confirm order details before submission
- For payments, guide users through the secure process
- Be transparent about shipping times and costs
```

**Conversation starters**:
```
1. "🛍️ Help me find eco-friendly products under $50"
2. "💻 I need a good portable charger for travel"
3. "🎁 Find a unique gift for someone who loves cooking"
4. "📦 Track my recent order"
```

### Step 4: 添加Actions

点击 "Add actions" 按钮，然后：

**1. Schema方式1 - 直接粘贴**:

将以下OpenAPI schema复制粘贴到Schema输入框：

```json
{
  "openapi": "3.0.0",
  "info": {
    "title": "Pivota Shopping Assistant API",
    "version": "1.0.0",
    "description": "API for shopping operations"
  },
  "servers": [
    {
      "url": "https://pivota-agent-production.up.railway.app"
    }
  ],
  "paths": {
    "/agent/shop/v1/invoke": {
      "post": {
        "summary": "Execute shopping operation",
        "operationId": "invokeShoppingOperation",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["operation", "payload"],
                "properties": {
                  "operation": {
                    "type": "string",
                    "enum": ["find_products", "get_product_detail", "create_order", "submit_payment", "get_order_status", "request_after_sales"]
                  },
                  "payload": {
                    "type": "object"
                  }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Success"
          }
        }
      }
    }
  }
}
```

**2. Schema方式2 - 导入URL** (推荐):

使用完整的schema文件:
```
https://raw.githubusercontent.com/pengxu9-rgb/PIVOTA-Agent/main/chatgpt-gpt-openapi-schema.json
```

**3. Authentication设置**:

选择 "None" (API是公开的)

### Step 5: 添加Logo

**创建简单的Logo** (如果还没有):
1. 使用Canva或其他工具
2. 建议尺寸: 512x512px
3. 颜色方案: 蓝色/绿色表示可信赖的购物体验
4. 包含购物相关元素（购物车、包裹等）

### Step 6: 测试你的GPT

**测试对话示例**:

```
User: Help me find a water bottle under $20
GPT: I'll help you find water bottles under $20. Let me search for available options.

[Calls find_products with query "water bottle" and price_max: 20]

I found several water bottles under $20:
1. Stainless Steel Water Bottle - $15.99
   - Eco-friendly and durable
   - 500ml capacity
   - Available in multiple colors
   
Would you like to see more details or proceed with ordering?

User: I'll take the stainless steel one
GPT: Great choice! To complete your order, I'll need your shipping information...
```

**关键测试场景**:
1. ✅ 产品搜索
2. ✅ 创建订单
3. ✅ 支付流程
4. ✅ 订单查询

### Step 7: 发布到GPT Store

**发布前检查清单**:
- [ ] Logo已上传
- [ ] 名称和描述清晰
- [ ] Instructions完整
- [ ] Actions已配置并测试
- [ ] Conversation starters设置好

**发布步骤**:
1. 点击右上角 "Save" 保存GPT
2. 选择发布范围:
   - "Only me" - 仅自己使用
   - "Anyone with a link" - 链接分享
   - "Everyone" - 发布到GPT Store (推荐)
3. 如果选择"Everyone"，需要:
   - 验证域名所有权
   - 同意使用条款
   - 等待审核（通常24小时内）

## 🔧 常见问题排查

### 1. Action调用失败
**问题**: GPT显示"Error talking to [API]"
**解决**: 
- 检查API endpoint是否正确
- 确认服务是否在线: `curl https://pivota-agent-production.up.railway.app/healthz`

### 2. 找不到商品
**问题**: 搜索总是返回空结果
**优先检查**:
- 确认请求里 **没有被硬编码单一 `merchant_id`**，让后端可以跨所有商家搜索
- 只在用户明确指定某个商家时才设置 `merchant_id`
- 如果在开发/排查阶段需要，用 `merch_208139f7600dbf42` 做单商家诊断测试

### 3. Schema验证失败
**问题**: OpenAPI schema无法导入
**解决**:
- 使用简化版schema（上面提供的）
- 或直接从GitHub URL导入

## 📊 发布后优化

### 1. 收集用户反馈
- 监控使用情况
- 收集常见问题
- 优化conversation starters

### 2. 更新Instructions
根据用户使用模式，持续优化:
- 添加更多使用示例
- 优化错误处理话术
- 增强购物建议能力

### 3. 扩展功能
- 添加多语言支持
- 集成更多商家
- 增加个性化推荐

## 🎉 完成！

恭喜！你的Pivota Shopping Assistant GPT已经准备好了。用户现在可以通过自然对话完成整个购物流程。

**分享链接格式**:
```
https://chat.openai.com/g/g-[YOUR-GPT-ID]/pivota-shopping-assistant
```

## 📝 后续维护

1. **定期检查**:
   - API健康状态
   - 商品库存更新
   - 用户反馈处理

2. **版本更新**:
   - 新功能发布时更新schema
   - 优化Instructions
   - 添加新的对话示例

3. **营销推广**:
   - 在社交媒体分享
   - 创建使用教程视频
   - 与商家合作推广

---

**需要帮助？** 查看完整文档: https://github.com/pengxu9-rgb/PIVOTA-Agent
