# 连接真实商品数据指南

**问题**: Agent搜索不到真实商户的商品（如white hoodie）  
**原因**: Gateway在MOCK模式，只返回预定义的10个测试商品  
**解决**: 切换到HYBRID或REAL模式，连接真实Pivota后端

## 🎯 目标

让Gateway能访问merchant.pivota.cc上的真实商品：
- NeoFit Performance Tee ($24.99)
- CloudFit Hoodie ($59.00)
- AeroFlex Joggers ($48.00)
- 以及所有其他真实商品

## 🔧 配置步骤

### Step 1: 获取Pivota API密钥

您需要从Pivota后端团队获取API密钥。

可能的获取方式：
1. 登录 merchant.pivota.cc
2. 进入 Settings → Integrations → API Keys
3. 或联系后端团队直接提供

### Step 2: 在Railway配置环境变量

1. **访问Railway项目**:
   - https://railway.app (登录)
   - 找到 pivota-agent-production 项目

2. **添加环境变量**:
   点击 Variables 标签，添加：

   ```
   API_MODE=HYBRID
   PIVOTA_API_BASE=https://web-production-fedb.up.railway.app
   PIVOTA_API_KEY=your-actual-api-key-here
   ```

3. **保存并重新部署**:
   - Railway会自动重启服务
   - 等待1-2分钟

### Step 3: 验证连接

测试API是否能访问真实商品：

```bash
curl -X POST https://pivota-agent-production.up.railway.app/agent/shop/v1/invoke \
  -H "Content-Type: application/json" \
  -d '{
    "operation": "find_products",
    "payload": {
      "search": {
        "merchant_id": "merch_208139f7600dbf42",
        "query": "hoodie"
      }
    }
  }' | jq .
```

应该返回真实的hoodie商品！

### Step 4: 验证健康状态

```bash
curl https://pivota-agent-production.up.railway.app/healthz | jq .
```

应该显示：
```json
{
  "ok": true,
  "api_mode": "HYBRID",
  "modes": {
    "mock": false,
    "hybrid": true,
    "real_api_enabled": true
  },
  "backend": {
    "api_base": "https://web-production-fedb.up.railway.app",
    "api_key_configured": true
  }
}
```

## 🎯 模式说明

### MOCK模式（当前）
```
API_MODE=MOCK
```
- 使用内置的10个测试商品
- 适合演示和开发
- ✅ 优点：无需API密钥，稳定
- ❌ 缺点：商品有限，无法搜索真实商品

### HYBRID模式（推荐）
```
API_MODE=HYBRID
PIVOTA_API_BASE=https://web-production-fedb.up.railway.app
PIVOTA_API_KEY=your-key
```
- 商品搜索用真实API（能找到所有真实商品）
- 支付用mock（安全测试）
- ✅ 优点：真实商品数据，支付安全
- ⚠️ 需要：API密钥

### REAL模式（生产环境）
```
API_MODE=REAL
PIVOTA_API_BASE=https://web-production-fedb.up.railway.app
PIVOTA_API_KEY=your-key
```
- 所有操作都用真实API
- 真实支付和订单
- ✅ 优点：完整真实体验
- ⚠️ 需要：API密钥 + 生产环境测试

## ⚠️ 已知的后端问题

根据 PIVOTA_BACKEND_ISSUES_REPORT.md，真实后端有以下问题：

1. **支付API字段不一致**
   - 订单返回 `total`，但支付期望 `total_amount`
   - Gateway已做适配，应该能工作

2. **产品详情API错误**
   - `store_info` 未定义
   - 可能影响商品详情查询

建议先使用**HYBRID模式**测试商品搜索，避开支付问题。

## 🚀 快速测试流程

1. **配置Railway环境变量**（HYBRID模式）
2. **等待1-2分钟重启**
3. **在agent.pivota.cc搜索** "white hoodie"
4. **应该能看到** CloudFit Hoodie等真实商品
5. **测试添加到购物车**
6. **测试订单创建**（会用真实API）
7. **测试支付**（会用mock，安全）

## 📞 如果需要API密钥

联系Pivota后端团队或查看：
- Pivota merchant后台
- 或之前的API密钥记录
- 或env配置文件

---

**配置完成后，Agent就能搜索到merchant.pivota.cc上的所有真实商品了！** 🎉

需要我创建一个详细的Railway环境变量配置截图指南吗？
