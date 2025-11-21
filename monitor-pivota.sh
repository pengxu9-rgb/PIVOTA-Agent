#!/bin/bash

# Pivota Agent 监控脚本
# 用法: ./monitor-pivota.sh

GATEWAY="https://pivota-agent-production.up.railway.app"
LOG_DIR="./logs"
LOG_FILE="$LOG_DIR/pivota-monitor-$(date +%Y%m%d).log"

# 创建日志目录
mkdir -p "$LOG_DIR"

# 颜色定义
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

# 监控函数
monitor_health() {
    RESPONSE=$(curl -s -w "\n%{http_code}" "$GATEWAY/healthz" 2>/dev/null)
    HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
    BODY=$(echo "$RESPONSE" | head -n-1)
    
    TIMESTAMP=$(date "+%Y-%m-%d %H:%M:%S")
    
    if [ "$HTTP_CODE" = "200" ] && echo "$BODY" | grep -q '"ok":true'; then
        echo -e "[$TIMESTAMP] ${GREEN}✅ Health Check: OK${NC}" | tee -a "$LOG_FILE"
        return 0
    else
        echo -e "[$TIMESTAMP] ${RED}❌ Health Check: FAILED (HTTP $HTTP_CODE)${NC}" | tee -a "$LOG_FILE"
        return 1
    fi
}

test_search() {
    TIMESTAMP=$(date "+%Y-%m-%d %H:%M:%S")
    RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$GATEWAY/agent/shop/v1/invoke" \
        -H "Content-Type: application/json" \
        -d '{"operation":"find_products","payload":{"search":{"page":1,"page_size":1}}}' 2>/dev/null)
    
    HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
    BODY=$(echo "$RESPONSE" | head -n-1)
    
    if [ "$HTTP_CODE" = "200" ] && echo "$BODY" | grep -q '"status":"success"'; then
        PRODUCT_COUNT=$(echo "$BODY" | python3 -c "import json,sys; print(len(json.load(sys.stdin).get('products',[])))" 2>/dev/null || echo "0")
        echo -e "[$TIMESTAMP] ${GREEN}✅ Search API: OK (Found products)${NC}" | tee -a "$LOG_FILE"
        return 0
    else
        echo -e "[$TIMESTAMP] ${RED}❌ Search API: FAILED (HTTP $HTTP_CODE)${NC}" | tee -a "$LOG_FILE"
        return 1
    fi
}

# 主监控循环
echo "=== Pivota Agent Monitor Started ==="
echo "Gateway: $GATEWAY"
echo "Logs: $LOG_FILE"
echo "Press Ctrl+C to stop"
echo ""

# 监控间隔（秒）
INTERVAL=60
ERROR_COUNT=0
MAX_ERRORS=3

while true; do
    echo -e "\n--- Checking at $(date) ---"
    
    # 健康检查
    if monitor_health; then
        ERROR_COUNT=0
    else
        ((ERROR_COUNT++))
    fi
    
    # 每5分钟进行一次完整测试
    if [ $(($(date +%s) % 300)) -lt 60 ]; then
        test_search
    fi
    
    # 错误告警
    if [ $ERROR_COUNT -ge $MAX_ERRORS ]; then
        echo -e "${RED}⚠️  ALERT: Service has failed $ERROR_COUNT consecutive health checks!${NC}" | tee -a "$LOG_FILE"
        # 这里可以添加告警通知（邮件、钉钉、企业微信等）
    fi
    
    # 等待下次检查
    echo "Next check in $INTERVAL seconds..."
    sleep $INTERVAL
done
