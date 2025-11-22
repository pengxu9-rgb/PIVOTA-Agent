#!/bin/bash
# Pivota API 完整测试脚本
# 测试时间: $(date)

API_BASE="https://web-production-fedb.up.railway.app"
API_KEY="ak_live_886c3ccac1e8cbe802d73c716a29f4f983128508c5f64082cf8e5792409035bc"

echo "========================================="
echo "Pivota API 测试报告"
echo "测试时间: $(date)"
echo "========================================="
echo ""

# 1. CORS 支持测试
echo "### 1. CORS 支持测试"
echo "测试 OPTIONS 预检请求..."
CORS_RESULT=$(curl -s -X OPTIONS $API_BASE/agent/v1/products/search \
  -H "Origin: https://app.pivota.cc" \
  -H "Access-Control-Request-Method: GET" \
  -I 2>&1 | grep -i "access-control")

if [ -n "$CORS_RESULT" ]; then
  echo "✅ CORS headers found:"
  echo "$CORS_RESULT"
else
  echo "❌ No CORS headers found"
fi
echo ""

# 2. 服务状态检查
echo "### 2. 服务状态检查"
echo "检查版本信息..."
VERSION=$(curl -s $API_BASE/version 2>&1)
echo "版本响应: $VERSION"

echo "检查健康状态..."
HEALTH=$(curl -s $API_BASE/health 2>&1)
echo "健康状态: $HEALTH"
echo ""

# 3. 错误处理测试
echo "### 3. 错误处理测试"
echo "测试无 API Key..."
NO_KEY_ERROR=$(curl -s $API_BASE/agent/v1/products/search 2>&1)
echo "无Key响应: $NO_KEY_ERROR"

echo "测试 404..."
NOT_FOUND=$(curl -s $API_BASE/nonexistent 2>&1)
echo "404响应: $NOT_FOUND"
echo ""

# 4. 性能测试
echo "### 4. 性能测试"
echo "发送10个请求测试响应时间..."
TOTAL_TIME=0
SUCCESS_COUNT=0

for i in {1..10}; do
  START=$(date +%s%N)
  RESPONSE=$(curl -s -w "\n%{http_code}" \
    -X GET "$API_BASE/agent/v1/products/search?merchant_id=merch_208139f7600dbf42&query=test&limit=1" \
    -H "Authorization: Bearer $API_KEY" 2>&1)
  END=$(date +%s%N)
  
  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  DURATION=$(( ($END - $START) / 1000000 ))
  
  if [ "$HTTP_CODE" = "200" ]; then
    SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
    TOTAL_TIME=$((TOTAL_TIME + DURATION))
    echo "  请求 $i: ${DURATION}ms (HTTP $HTTP_CODE) ✅"
  else
    echo "  请求 $i: ${DURATION}ms (HTTP $HTTP_CODE) ❌"
  fi
done

AVG_TIME=$((TOTAL_TIME / 10))
echo "平均响应时间: ${AVG_TIME}ms"
echo "成功率: $SUCCESS_COUNT/10"
echo ""

# 5. API 文档检查
echo "### 5. API 文档检查"
DOCS_STATUS=$(curl -s -I $API_BASE/docs 2>&1 | grep "HTTP" | head -1)
echo "文档端点: $DOCS_STATUS"
echo ""

# 6. 商品搜索功能测试
echo "### 6. 商品搜索功能测试"
echo "搜索 hoodie..."
SEARCH_RESULT=$(curl -s -X GET "$API_BASE/agent/v1/products/search?merchant_id=merch_208139f7600dbf42&query=hoodie&limit=2" \
  -H "Authorization: Bearer $API_KEY" 2>&1)

PRODUCT_COUNT=$(echo "$SEARCH_RESULT" | jq '.products | length' 2>/dev/null || echo "0")
echo "找到商品数: $PRODUCT_COUNT"
if [ "$PRODUCT_COUNT" -gt "0" ]; then
  echo "✅ 商品搜索正常"
  echo "$SEARCH_RESULT" | jq '.products[0] | {title, price, currency}' 2>/dev/null || echo "$SEARCH_RESULT"
else
  echo "❌ 未找到商品"
  echo "$SEARCH_RESULT"
fi
echo ""

echo "========================================="
echo "测试完成"
echo "========================================="
