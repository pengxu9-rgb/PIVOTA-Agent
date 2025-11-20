# Pivota Agent Real API Hotfix

## 问题总结

1. 真实 Pivota API 需要 `merchant_id` 参数进行产品搜索
2. 创建订单需要额外的必填字段：`merchant_id`, `customer_email`, `product_title`, `unit_price`, `subtotal`
3. 地址字段名称不匹配：API 需要 `name` 而不是 `recipient_name`

## 已应用的修复

### 1. 更新了 server.js 路由映射

- ✅ `find_products`: 添加了 `merchant_id` 支持，移除了 city→merchant_id 的临时映射
- ✅ `create_order`: 添加了所有必填字段的自动填充和映射
- ✅ 处理了字段名称差异（recipient_name → name）

### 2. 更新了 tool-schema.json

- ✅ 在 search 对象中添加了 `merchant_id` 字段说明
- ✅ 添加了 `category` 和 `in_stock_only` 参数

## 正确的测试命令

### 1. 首先获取可用的商户

```bash
# 如果你有商户 ID，跳过此步
curl https://web-production-fedb.up.railway.app/agent/v1/merchants \
  -H "Authorization: Bearer YOUR_PIVOTA_API_KEY"
```

### 2. 搜索产品（无需指定商户）

```bash
# 搜索所有商户的产品
curl -X POST https://pivota-agent-production.up.railway.app/agent/shop/v1/invoke \
  -H "Content-Type: application/json" \
  -d '{
    "operation": "find_products",
    "payload": {
      "search": {
        "query": "Nike shoes",
        "price_min": 100,
        "price_max": 1000,
        "in_stock_only": true,
        "page": 1,
        "page_size": 10
      }
    }
  }'
```

### 3. 搜索特定商户的产品

```bash
# 使用具体的 merchant_id
curl -X POST https://pivota-agent-production.up.railway.app/agent/shop/v1/invoke \
  -H "Content-Type: application/json" \
  -d '{
    "operation": "find_products",
    "payload": {
      "search": {
        "merchant_id": "YOUR_MERCHANT_ID",
        "query": "shoes",
        "price_max": 1000
      }
    }
  }'
```

### 4. 获取产品详情

```bash
# 使用从搜索结果中获得的 merchant_id 和 product_id
curl -X POST https://pivota-agent-production.up.railway.app/agent/shop/v1/invoke \
  -H "Content-Type: application/json" \
  -d '{
    "operation": "get_product_detail",
    "payload": {
      "product": {
        "merchant_id": "ACTUAL_MERCHANT_ID",
        "product_id": "ACTUAL_PRODUCT_ID"
      }
    }
  }'
```

### 5. 创建订单（修复版）

```bash
# 网关会自动填充缺失的必填字段
curl -X POST https://pivota-agent-production.up.railway.app/agent/shop/v1/invoke \
  -H "Content-Type: application/json" \
  -d '{
    "operation": "create_order",
    "payload": {
      "order": {
        "customer_email": "test@example.com",
        "items": [{
          "merchant_id": "ACTUAL_MERCHANT_ID",
          "product_id": "ACTUAL_PRODUCT_ID",
          "product_title": "Nike Air Max",
          "quantity": 1,
          "unit_price": 599
        }],
        "shipping_address": {
          "recipient_name": "Test User",
          "address_line1": "123 Test Street",
          "city": "Shanghai",
          "country": "CN",
          "postal_code": "200000",
          "phone": "+86 138 0000 0000"
        },
        "notes": "Please deliver between 9am-5pm"
      }
    }
  }'
```

## 部署更新

将这些更改推送到 GitHub 以触发 Railway 自动部署：

```bash
cd "/Users/pengchydan/Desktop/Pivota Agent"
git add -A
git commit -m "fix: Update gateway routing for real Pivota API requirements

- Add merchant_id support for product search
- Map all required fields for order creation
- Handle field name differences (recipient_name -> name)
- Update documentation"
git push origin main
```

## 调试提示

如果仍然遇到错误：

1. **检查响应中的错误详情** - Pydantic 验证错误会明确指出缺少哪些字段
2. **查看 Railway 日志** - 了解网关如何处理请求
3. **使用真实的测试数据** - 确保 merchant_id 和 product_id 存在

## 下一步

1. 监控 Railway 部署状态
2. 部署完成后重新测试
3. 如果需要，继续调整字段映射
