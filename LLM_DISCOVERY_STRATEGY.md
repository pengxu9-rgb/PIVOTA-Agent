# LLM Discovery Strategy - 让AI找到我们

**目标**: 让ChatGPT、Gemini、Claude、Perplexity等LLM能够发现Pivota商家和商品

## 🎯 两层发现策略

### Layer 1: 技术集成（让LLM能调用我们）

#### 1. ChatGPT/OpenAI 🟢 立即可做
```yaml
方式1 - Custom GPT:
  - 登录 ChatGPT
  - Create a GPT → Configure
  - 添加 Action: https://pivota-agent-production.up.railway.app/agent/shop/v1/invoke
  - 导入 tool-schema.json
  - 发布到 GPT Store

方式2 - API集成:
  - 使用 OpenAI Function Calling
  - 参考: docs/integrations/chatgpt.md
```

#### 2. Gemini 🟡 需要申请
```yaml
当前状态: Extensions in Beta
集成方式:
  - 申请 Gemini Extensions API
  - 创建 Extension manifest
  - 提交审核
备选: 通过 Google AI Studio 创建项目
```

#### 3. Claude 🟢 可通过API
```yaml
方式1 - Claude Projects:
  - 创建 Project
  - 添加 Tool definition
  - 使用我们的 API

方式2 - Direct API:
  - 使用 Claude API with tools
  - 集成到第三方应用
```

#### 4. Perplexity 🟡 间接集成
```yaml
当前: 主要通过网页索引
策略:
  - 创建 SEO 优化的商品页面
  - 提交 sitemap
  - 使用结构化数据
```

### Layer 2: 内容发现（让LLM知道商品）

#### 必须创建的内容资源

1. **公开商品目录页** 🚨 最重要
```html
https://pivota.cc/merchants/{merchant_id}/products
- SEO优化的HTML页面
- Schema.org ProductListing标记
- 每个商品有独立URL
- 包含价格、描述、图片
```

2. **API文档页**
```html
https://pivota.cc/developers/api
- OpenAPI规范文档
- 使用示例
- 集成指南
```

3. **商家目录**
```html
https://pivota.cc/merchants
- 所有活跃商家列表
- 商家简介和产品类别
- 更新频率：每日
```

## 📋 实施计划

### Phase 1: Quick Wins (本周)

1. **创建ChatGPT Custom GPT** ✅ 今天
   ```bash
   # 使用现有资源快速创建
   - 使用 docs/tool-schema.json
   - 使用 docs/prompt-system.md
   - 测试基本购物流程
   - 提交到GPT Store
   ```

2. **创建基础商品页面** 📅 Day 2-3
   ```javascript
   // 新增路由 /merchants/:id/products
   app.get('/merchants/:merchant_id/products', async (req, res) => {
     // 返回SEO友好的HTML
     // 包含Schema.org标记
   });
   ```

3. **提交Sitemap** 📅 Day 3
   ```xml
   <urlset>
     <url>
       <loc>https://pivota.cc/merchants/merch_208139f7600dbf42/products</loc>
       <lastmod>2025-11-21</lastmod>
       <changefreq>daily</changefreq>
     </url>
   </urlset>
   ```

### Phase 2: Platform Integration (下周)

1. **Gemini Extension**
   - 准备manifest.json
   - 申请开发者权限
   - 创建demo

2. **Claude Project**
   - 创建专门的Shopping Project
   - 配置tool definitions
   - 测试对话流程

3. **Perplexity优化**
   - 确保所有页面可被爬取
   - 添加FAQ页面
   - 创建商品问答内容

### Phase 3: Advanced Discovery (第三周)

1. **动态推荐系统**
   ```javascript
   // 基于查询的智能推荐
   GET /api/recommendations?query=eco+friendly
   ```

2. **商品Feed**
   ```javascript
   // RSS/Atom feed for new products
   GET /feeds/products.xml
   ```

3. **Webhook通知**
   ```javascript
   // 新品上架通知
   POST /webhooks/new-products
   ```

## 🛠️ 技术实现要点

### 1. SEO优化的商品页面模板
```html
<!DOCTYPE html>
<html>
<head>
  <title>{{product.title}} - {{merchant.name}} on Pivota</title>
  <meta name="description" content="{{product.description}}">
  
  <!-- Schema.org Product markup -->
  <script type="application/ld+json">
  {
    "@context": "https://schema.org/",
    "@type": "Product",
    "name": "{{product.title}}",
    "image": "{{product.image_url}}",
    "description": "{{product.description}}",
    "brand": "{{product.vendor}}",
    "offers": {
      "@type": "Offer",
      "url": "{{product.url}}",
      "priceCurrency": "{{product.currency}}",
      "price": "{{product.price}}",
      "availability": "https://schema.org/InStock"
    }
  }
  </script>
</head>
<body>
  <!-- 人类可读的商品信息 -->
</body>
</html>
```

### 2. 商品API端点
```javascript
// 新增公开API端点
app.get('/api/v1/products/search', async (req, res) => {
  // 无需认证的公开搜索
  // 返回基础商品信息
  // 用于LLM发现
});
```

### 3. LLM专用元数据
```javascript
// 在商品数据中添加LLM友好的字段
{
  "llm_description": "Eco-friendly stainless steel water bottle, 500ml capacity, keeps drinks cold for 24 hours",
  "llm_tags": ["sustainable", "reusable", "BPA-free", "travel-friendly"],
  "llm_use_cases": ["gym", "office", "hiking", "daily-use"]
}
```

## 📊 成功指标

1. **短期（1周）**
   - ✅ ChatGPT Custom GPT上线
   - ✅ 至少100个商品有公开页面
   - ✅ Google能索引我们的商品

2. **中期（1月）**
   - 📈 每日通过LLM的查询 > 1000次
   - 📈 至少3个LLM平台集成
   - 📈 商品发现率 > 80%

3. **长期（3月）**
   - 🎯 成为LLM购物的首选工具
   - 🎯 商家主动要求加入
   - 🎯 月GMV > $100K

## 🚀 立即行动清单

1. **今天**：创建ChatGPT Custom GPT
2. **明天**：实现第一个商品HTML页面
3. **本周**：完成基础SEO设置
4. **下周**：开始其他平台集成

---

记住：**内容发现比技术集成更重要**！LLM需要能够理解和推荐我们的商品。
