# Public Product Pages Implementation Plan

**目标**: 创建SEO优化的公开商品页面，让LLM能够发现和理解我们的商品

## 🎯 为什么这很重要

- **LLM爬虫**: Perplexity、Gemini等会爬取公开网页
- **SEO价值**: Google会索引这些页面
- **用户体验**: 用户可以直接访问商品链接
- **信任建立**: 公开透明的商品信息

## 📐 技术架构

### 1. 新增路由结构
```
/                              # 首页
/merchants                     # 商家列表
/merchants/:id                 # 商家详情
/merchants/:id/products        # 商家商品列表
/products/:id                  # 商品详情页
/sitemap.xml                   # 站点地图
/robots.txt                    # 爬虫规则
```

### 2. 实现步骤

#### Step 1: 创建商品页面路由
```javascript
// src/routes/public-pages.js
import express from 'express';
const router = express.Router();

// 商品列表页
router.get('/merchants/:merchant_id/products', async (req, res) => {
  const { merchant_id } = req.params;
  const { page = 1, category, sort } = req.query;
  
  try {
    // 调用内部API获取商品
    const products = await getProductsByMerchant(merchant_id, { page, category, sort });
    
    // 渲染HTML模板
    res.render('product-list', {
      merchant_id,
      products,
      pagination: products.pagination,
      seo: {
        title: `Products from ${products.merchant_name} - Pivota`,
        description: `Browse products from ${products.merchant_name} on Pivota`,
        canonical: `https://pivota.cc/merchants/${merchant_id}/products`
      }
    });
  } catch (error) {
    res.status(404).render('404', { message: 'Merchant not found' });
  }
});

// 商品详情页
router.get('/products/:product_id', async (req, res) => {
  const { product_id } = req.params;
  
  try {
    const product = await getProductDetail(product_id);
    
    res.render('product-detail', {
      product,
      seo: {
        title: `${product.title} - ${product.price} ${product.currency}`,
        description: product.description || `Buy ${product.title} on Pivota`,
        image: product.image_url,
        price: product.price,
        currency: product.currency
      }
    });
  } catch (error) {
    res.status(404).render('404', { message: 'Product not found' });
  }
});
```

#### Step 2: HTML模板 (使用EJS)
```html
<!-- views/product-detail.ejs -->
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title><%= seo.title %></title>
  <meta name="description" content="<%= seo.description %>">
  
  <!-- Open Graph / Facebook -->
  <meta property="og:type" content="product">
  <meta property="og:title" content="<%= seo.title %>">
  <meta property="og:description" content="<%= seo.description %>">
  <meta property="og:image" content="<%= seo.image %>">
  <meta property="product:price:amount" content="<%= seo.price %>">
  <meta property="product:price:currency" content="<%= seo.currency %>">
  
  <!-- Schema.org Structured Data -->
  <script type="application/ld+json">
  {
    "@context": "https://schema.org/",
    "@type": "Product",
    "name": "<%= product.title %>",
    "image": "<%= product.image_url %>",
    "description": "<%= product.description %>",
    "brand": {
      "@type": "Brand",
      "name": "<%= product.vendor || product.merchant_name %>"
    },
    "offers": {
      "@type": "Offer",
      "url": "https://pivota.cc/products/<%= product.id %>",
      "priceCurrency": "<%= product.currency %>",
      "price": "<%= product.price %>",
      "availability": "<%= product.inventory_quantity > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock' %>",
      "seller": {
        "@type": "Organization",
        "name": "<%= product.merchant_name %>"
      }
    }
  }
  </script>
  
  <!-- Tailwind CSS for quick styling -->
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body>
  <div class="container mx-auto px-4 py-8">
    <!-- Product Header -->
    <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
      <!-- Product Image -->
      <div>
        <img src="<%= product.image_url %>" 
             alt="<%= product.title %>" 
             class="w-full rounded-lg shadow-lg">
      </div>
      
      <!-- Product Info -->
      <div>
        <h1 class="text-3xl font-bold mb-4"><%= product.title %></h1>
        <p class="text-2xl text-green-600 mb-4">
          <%= product.currency %> <%= product.price %>
        </p>
        
        <% if (product.description) { %>
          <p class="text-gray-600 mb-6"><%= product.description %></p>
        <% } %>
        
        <!-- Stock Status -->
        <div class="mb-6">
          <% if (product.inventory_quantity > 0) { %>
            <span class="text-green-500">✓ In Stock</span>
          <% } else { %>
            <span class="text-red-500">✗ Out of Stock</span>
          <% } %>
        </div>
        
        <!-- Buy Button (links to chat) -->
        <a href="/chat?product_id=<%= product.id %>&action=buy" 
           class="bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700 inline-block">
          Buy with AI Assistant
        </a>
        
        <!-- Product Details -->
        <div class="mt-8">
          <h2 class="text-xl font-semibold mb-4">Product Details</h2>
          <dl class="space-y-2">
            <% if (product.vendor) { %>
              <div>
                <dt class="inline font-medium">Brand:</dt>
                <dd class="inline ml-2"><%= product.vendor %></dd>
              </div>
            <% } %>
            <% if (product.sku) { %>
              <div>
                <dt class="inline font-medium">SKU:</dt>
                <dd class="inline ml-2"><%= product.sku %></dd>
              </div>
            <% } %>
            <div>
              <dt class="inline font-medium">Merchant:</dt>
              <dd class="inline ml-2">
                <a href="/merchants/<%= product.merchant_id %>" class="text-blue-600 hover:underline">
                  <%= product.merchant_name %>
                </a>
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </div>
  </div>
</body>
</html>
```

#### Step 3: Sitemap生成
```javascript
// src/routes/sitemap.js
router.get('/sitemap.xml', async (req, res) => {
  res.header('Content-Type', 'application/xml');
  
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://pivota.cc/</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://pivota.cc/merchants</loc>
    <changefreq>daily</changefreq>
    <priority>0.8</priority>
  </url>
  ${await generateProductUrls()}
</urlset>`;
  
  res.send(sitemap);
});

async function generateProductUrls() {
  const products = await getAllProducts({ limit: 1000 });
  return products.map(p => `
  <url>
    <loc>https://pivota.cc/products/${p.id}</loc>
    <lastmod>${p.updated_at || new Date().toISOString()}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.6</priority>
  </url>`).join('');
}
```

#### Step 4: Robots.txt
```text
# robots.txt
User-agent: *
Allow: /

# Allow AI crawlers
User-agent: GPTBot
Allow: /

User-agent: Claude-Web
Allow: /

User-agent: PerplexityBot
Allow: /

# Sitemap location
Sitemap: https://pivota.cc/sitemap.xml
```

## 🚀 部署计划

### Phase 1: 基础实现 (Day 1-2)
1. ✅ 创建路由和模板系统
2. ✅ 实现商品列表页
3. ✅ 实现商品详情页
4. ✅ 添加Schema.org标记

### Phase 2: SEO优化 (Day 3)
1. ✅ 生成sitemap.xml
2. ✅ 配置robots.txt
3. ✅ 提交到Google Search Console
4. ✅ 测试结构化数据

### Phase 3: 增强功能 (Day 4-5)
1. ✅ 添加商品图片轮播
2. ✅ 实现相关商品推荐
3. ✅ 添加面包屑导航
4. ✅ 实现搜索功能

## 📊 成功指标

1. **技术指标**:
   - Google能索引所有商品页面
   - 结构化数据验证通过
   - 页面加载速度 < 2秒

2. **业务指标**:
   - LLM能准确描述我们的商品
   - 搜索引擎流量增长
   - 用户停留时间提升

## 🔧 实现细节

### 缓存策略
```javascript
// 使用Redis缓存商品数据
const cache = require('./cache');

async function getProductWithCache(product_id) {
  const cached = await cache.get(`product:${product_id}`);
  if (cached) return JSON.parse(cached);
  
  const product = await fetchProductFromDB(product_id);
  await cache.set(`product:${product_id}`, JSON.stringify(product), 'EX', 3600);
  return product;
}
```

### 性能优化
- 使用CDN for静态资源
- 启用Gzip压缩
- 实现lazy loading for图片
- 使用Server-Side Rendering (SSR)

## 下一步行动

1. **立即**: 在现有Express服务中添加public routes
2. **今天**: 部署第一个商品页面
3. **本周**: 完成所有页面模板
4. **下周**: 提交到搜索引擎并监控索引情况
