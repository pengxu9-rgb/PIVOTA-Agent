# Pivota Backend Issues Report

**报告日期**: 2025-11-21  
**报告人**: Pivota Agent Gateway Team  
**优先级**: 高（影响核心支付功能）

## Executive Summary

在集成 Pivota Agent Gateway 与 Pivota Infrastructure API 的过程中，我们发现了两个需要后端修复的问题，其中支付功能问题影响用户完成购买流程。

## Issue 1: 支付 API 字段不一致问题 🔴 高优先级

### 问题描述
支付 API 在处理支付请求时，尝试从订单对象读取 `total_amount` 字段，但订单创建 API 返回和存储的是 `total` 字段，导致支付失败。

### 错误信息
```json
{
  "detail": "Payment processing failed: 'total_amount'"
}
```

### 重现步骤

1. **创建订单**
```bash
curl -X POST https://web-production-fedb.up.railway.app/agent/v1/orders/create \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "merchant_id": "merch_208139f7600dbf42",
    "customer_email": "test@pivota.cc",
    "items": [{
      "merchant_id": "merch_208139f7600dbf42",
      "product_id": "B08N5WRWN2",
      "product_title": "Test Product",
      "quantity": 2,
      "unit_price": 15.99,
      "subtotal": 31.98
    }],
    "shipping_address": {
      "name": "Test User",
      "address_line1": "123 Test St",
      "city": "Shanghai",
      "country": "CN",
      "postal_code": "200000"
    }
  }'
```

**响应**（注意返回 `total` 字段）:
```json
{
  "status": "success",
  "order_id": "ORD_764304CC722590D2",
  "total": "31.98",  // <-- 这里是 "total"
  "currency": "USD"
}
```

2. **提交支付**
```bash
curl -X POST https://web-production-fedb.up.railway.app/agent/v1/payments \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "order_id": "ORD_764304CC722590D2",
    "total_amount": 31.98,  // <-- API 期望 "total_amount"
    "currency": "USD",
    "payment_method": {
      "type": "card"
    }
  }'
```

**错误响应**:
```json
{
  "detail": "Payment processing failed: 'total_amount'"
}
```

### 技术分析

问题出现在支付处理逻辑中，可能的代码片段：
```python
# 支付处理中可能的问题代码
def process_payment(payment_request):
    order = get_order(payment_request.order_id)
    
    # 这里尝试读取 total_amount，但订单中只有 total
    order_total = order['total_amount']  # KeyError!
    
    # 验证金额
    if payment_request.total_amount != order_total:
        raise ValueError("Amount mismatch")
```

### 建议的修复方案

#### 方案 1: 快速修复（推荐）
```python
# 在支付处理中添加兼容逻辑
def process_payment(payment_request):
    order = get_order(payment_request.order_id)
    
    # 兼容两种字段名
    order_total = order.get('total_amount') or order.get('total')
    
    if not order_total:
        raise ValueError("Order total not found")
```

#### 方案 2: 统一字段名
- 订单创建时同时保存 `total` 和 `total_amount`
- 或统一使用 `total_amount`

### 测试数据
- 测试订单 ID: ORD_764304CC722590D2, ORD_EF3A9E72E61112D7, ORD_CED11B78EBACE64D
- 测试商户 ID: merch_208139f7600dbf42
- 所有订单都创建成功但支付失败

---

## Issue 2: 产品详情 API 错误 🟡 中优先级

### 问题描述
调用产品详情 API 时返回后端错误，提示 `store_info` 未定义。

### 错误信息
```json
{
  "detail": "Failed to get product: name 'store_info' is not defined"
}
```

### 重现步骤
```bash
curl -X GET https://web-production-fedb.up.railway.app/agent/v1/products/merchants/merch_208139f7600dbf42/product/B08N5WRWN2 \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### 技术分析
后端代码中可能引用了未定义的 `store_info` 变量：
```python
# 可能的问题代码
def get_product_detail(merchant_id, product_id):
    product = fetch_product(merchant_id, product_id)
    
    # store_info 可能未定义或未导入
    product['store'] = store_info  # NameError!
    
    return product
```

### 建议的修复方案
1. 检查 `store_info` 变量的定义和导入
2. 如果是商户信息，从正确的源获取
3. 添加异常处理

---

## 影响范围

### 业务影响
- **支付功能**: 100% 失败率，用户无法完成购买
- **产品详情**: 功能不可用，但可通过产品搜索获取基本信息

### 受影响的系统
- Pivota Agent Gateway
- 所有使用支付 API 的集成
- 未来的 LLM 平台集成（ChatGPT、Claude 等）

## 建议的行动计划

1. **立即行动**（1-2天）
   - 修复支付 API 的字段读取逻辑
   - 部署到生产环境

2. **短期行动**（1周内）
   - 修复产品详情 API
   - 添加集成测试覆盖这些场景

3. **长期改进**（1-2周）
   - 统一字段命名规范
   - 创建 API 字段映射文档
   - 建立 API 版本管理机制

## 附录：Gateway 适配情况

Gateway 已经正确适配了字段映射：
- ✅ 订单创建：映射所有必填字段
- ✅ 支付提交：发送 `total_amount` 
- ✅ 产品搜索：处理查询参数
- ❌ 产品详情：后端错误
- ❌ 支付处理：后端字段不一致

## 联系方式

如需更多信息或测试协助，请联系 Pivota Agent Gateway 团队。

---

**附件**：
- 完整测试日志
- API 请求/响应示例
- Gateway 源代码参考
