# Pivota Agent - 测试支付流程协调文档

**发送方**: Pivota Agent Gateway Team  
**接收方**: Pivota Infrastructure Team  
**日期**: 2025-11-21  
**优先级**: 中 - 不阻塞上线，但影响完整测试

---

## 📋 Executive Summary

Pivota Shopping AI Agent已成功上线（agent.pivota.cc），所有核心功能运行正常。在测试完整购物流程时，我们发现支付订单在merchant portal显示为"Processing"状态，无法自动更新为"Paid"。

**目的**: 确认测试环境中支付确认的标准流程，确保能完整测试端到端的购物体验。

---

## ✅ 当前运行状态

### Agent Gateway配置
```
API_MODE: REAL
PIVOTA_API_BASE: https://web-production-fedb.up.railway.app
PIVOTA_API_KEY: ak_live_886c3ccac1e8cbe802d73c716a29f4f983128508c5f64082cf8e5792409035bc
测试商户: merch_208139f7600dbf42
```

### 已验证的功能
- ✅ 商品搜索：正常（能搜索到真实商品）
- ✅ 订单创建：正常（调用 `/agent/v1/orders/create`）
- ✅ 支付提交：正常（调用 `/agent/v1/payments`）
- ✅ API响应：正常（返回 payment_id 和 status）
- ⏳ 支付状态：停留在 Processing

## 🔍 观察到的行为

### 测试场景
1. 用户在agent.pivota.cc选择商品
2. 填写配送信息
3. 点击支付（Test Payment）
4. Gateway调用支付API：

```bash
POST https://web-production-fedb.up.railway.app/agent/v1/payments
{
  "order_id": "ORD_XXX",
  "total_amount": 59.00,
  "currency": "USD",
  "payment_method": {
    "type": "card"
  }
}
```

### 返回响应
```json
{
  "status": "success",
  "payment_id": "PAY_XXX",
  ...
}
```

### Merchant Portal状态
- 订单出现在订单列表 ✅
- 订单状态: **Processing** ⏳
- 预期状态: **Paid** ✅

## ❓ 需要确认的问题

### 1. 测试支付的标准流程
**问题**: 在测试环境中，支付从Processing → Paid需要什么操作？

**选项**:
- A. 手动在merchant portal点击"确认支付"？
- B. 自动在X分钟后更新？
- C. 需要配置测试Stripe webhook？
- D. 需要调用额外的API确认支付？
- E. 其他流程？

### 2. 测试模式 vs 生产模式
**问题**: 当前使用的API Key (`ak_live_xxx`) 是生产环境还是测试环境？

**背景**:
- 如果是生产环境，我们希望确保不会产生真实扣款
- 如果是测试环境，希望了解如何模拟完整支付流程

### 3. Webhook配置
**问题**: Pivota后端是否需要Gateway提供webhook端点来接收支付状态更新？

**如果需要**:
- Gateway端点: `https://pivota-agent-production.up.railway.app/webhooks/payment`
- 我们可以立即实现
- 需要知道webhook的payload格式

### 4. 订单状态流转
**问题**: 订单的完整状态流转是什么？

**当前理解**:
```
Pending → Processing → Paid → Shipped → Delivered
```

**需要确认**:
- 每个状态转换的触发条件
- 是否有中间状态
- 哪些状态需要外部触发，哪些自动更新

## 💡 我们的建议

### 短期方案：测试环境自动确认
**建议**: 在测试环境中，支付API返回成功后自动将订单更新为Paid

**好处**:
- 可以完整测试端到端流程
- 不需要手动操作
- 用户体验更顺畅

**实现**: 
- 在后端添加环境变量 `AUTO_CONFIRM_TEST_PAYMENTS=true`
- 或者在Gateway提交支付时添加参数 `test_mode: true`

### 长期方案：完整Webhook集成
**建议**: Gateway实现完整的webhook处理

**我们可以实现**:
```javascript
// Gateway接收支付状态更新
POST /webhooks/payment
{
  "payment_id": "PAY_XXX",
  "order_id": "ORD_XXX",
  "status": "paid",
  "paid_at": "2025-11-21T..."
}
```

**好处**:
- 支持异步支付确认
- 符合生产环境标准
- 可扩展到其他webhook（发货、退款等）

## 🎯 期望的结果

### 理想的测试流程
1. Agent调用支付API
2. 后端返回成功
3. **订单自动更新为Paid**（测试环境）
4. Agent收到确认，显示成功页面
5. 用户看到"Order Confirmed"

### 或者
1. Agent调用支付API
2. 后端返回"需要手动确认"
3. **我们在merchant portal确认**
4. 订单更新为Paid
5. （可选）webhook通知Agent

## 📊 测试数据参考

### 最近的测试订单
- Merchant ID: `merch_208139f7600dbf42`
- 测试订单ID: [请提供最近几个]
- 支付金额: $59.00 (CloudFit Hoodie)
- 当前状态: Processing

### API调用日志
可以在Railway查看Gateway的完整请求日志。

## 🤝 需要您的帮助

请帮助我们了解：

1. **测试支付的推荐流程**是什么？
2. **如何让Processing订单变成Paid**？
3. **是否需要配置Webhook**？如需要，格式是什么？
4. **测试API Key** 和 **生产API Key** 的区别？
5. **是否有测试支付的文档**我们可以参考？

## 📅 时间计划

### 紧急程度
- **不阻塞上线**: Agent可以正常演示和使用
- **但影响完整测试**: 无法验证支付确认后的用户体验
- **希望1周内解决**: 完善测试流程

### 我们的配合
- 可立即实现所需的webhook端点
- 可调整支付API的调用参数
- 可配置额外的环境变量
- 响应时间: 24小时内

## 📞 联系方式

**Slack**: [您的Slack账号]  
**Email**: [您的邮箱]  
**GitHub**: https://github.com/pengxu9-rgb/PIVOTA-Agent

**可随时联系讨论技术细节**

---

## 附录：当前支付API调用示例

### 请求
```bash
curl -X POST https://web-production-fedb.up.railway.app/agent/v1/payments \
  -H "Authorization: Bearer ak_live_886c3ccac1e8cbe802d73c716a29f4f983128508c5f64082cf8e5792409035bc" \
  -H "Content-Type: application/json" \
  -d '{
    "order_id": "ORD_1234567890",
    "total_amount": 59.00,
    "currency": "USD",
    "payment_method": {
      "type": "card"
    }
  }'
```

### 响应
```json
{
  "status": "success",
  "payment_id": "PAY_XXXXXXXXXXXX"
}
```

### Merchant Portal显示
- 订单状态: Processing
- 支付ID: PAY_XXXXXXXXXXXX
- 金额: $59.00

---

**期待您的回复，感谢配合！** 🙏

---

## 补充：API改进建议

我们已经准备了一份完整的API改进建议文档（`API_IMPROVEMENT_SUGGESTIONS.md`），包括：
- CORS配置建议
- 字段命名一致性
- 支付字段统一
- 等8项建议

如有兴趣，可以一并查看讨论。
