#!/bin/bash

# Pivota Backend 修复状态检查脚本
# 用于监控已知问题是否被修复

GATEWAY="https://pivota-agent-production.up.railway.app"
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

echo "=== Pivota Backend Issues Check ==="
echo "Time: $(date)"
echo ""

# 1. 检查支付功能
echo "1. Checking Payment API Fix..."
# 创建测试订单
ORDER_RESP=$(curl -s -X POST "$GATEWAY/agent/shop/v1/invoke" \
  -H "Content-Type: application/json" \
  -d '{
    "operation": "create_order",
    "payload": {
      "order": {
        "customer_email": "backend-fix-test@pivota.cc",
        "items": [{
          "merchant_id": "merch_208139f7600dbf42",
          "product_id": "B08N5WRWN2",
          "product_title": "Fix Test Product",
          "quantity": 1,
          "unit_price": 9.99
        }],
        "shipping_address": {
          "recipient_name": "Fix Test",
          "address_line1": "123 Test",
          "city": "Shanghai",
          "country": "CN",
          "postal_code": "200000"
        }
      }
    }
  }')

ORDER_ID=$(echo "$ORDER_RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('order_id',''))" 2>/dev/null)

if [ ! -z "$ORDER_ID" ]; then
  # 尝试支付
  PAYMENT_RESP=$(curl -s -X POST "$GATEWAY/agent/shop/v1/invoke" \
    -H "Content-Type: application/json" \
    -d "{
      \"operation\": \"submit_payment\",
      \"payload\": {
        \"payment\": {
          \"order_id\": \"$ORDER_ID\",
          \"expected_amount\": 9.99,
          \"currency\": \"USD\"
        }
      }
    }")
  
  if echo "$PAYMENT_RESP" | grep -q "total_amount"; then
    echo -e "${RED}❌ Payment API: Still broken${NC}"
    echo "   Error: Payment processing failed: 'total_amount'"
  elif echo "$PAYMENT_RESP" | grep -q "payment_id"; then
    echo -e "${GREEN}✅ Payment API: FIXED!${NC}"
  else
    echo -e "${YELLOW}⚠️  Payment API: Unknown status${NC}"
    echo "   Response: $PAYMENT_RESP"
  fi
else
  echo -e "${YELLOW}⚠️  Could not create test order${NC}"
fi

# 2. 检查产品详情 API
echo -e "\n2. Checking Product Detail API Fix..."
PRODUCT_RESP=$(curl -s -X POST "$GATEWAY/agent/shop/v1/invoke" \
  -H "Content-Type: application/json" \
  -d '{
    "operation": "get_product_detail",
    "payload": {
      "product": {
        "merchant_id": "merch_208139f7600dbf42",
        "product_id": "B08N5WRWN2"
      }
    }
  }')

if echo "$PRODUCT_RESP" | grep -q "store_info"; then
  echo -e "${RED}❌ Product Detail API: Still broken${NC}"
  echo "   Error: name 'store_info' is not defined"
elif echo "$PRODUCT_RESP" | grep -q '"id"'; then
  echo -e "${GREEN}✅ Product Detail API: FIXED!${NC}"
else
  echo -e "${YELLOW}⚠️  Product Detail API: Unknown status${NC}"
fi

# 3. 总结
echo -e "\n=== Summary ==="
echo "Run this script periodically to check if backend fixes are deployed."
echo "Once both issues are fixed, update the test documentation."
