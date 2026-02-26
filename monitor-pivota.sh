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

# Thresholds (seconds): tune via env vars when needed.
LATENCY_ALERT_ENABLED="${LATENCY_ALERT_ENABLED:-true}"
TLS_WARN_THRESHOLD_SEC="${TLS_WARN_THRESHOLD_SEC:-2.5}"
TTFB_WARN_THRESHOLD_SEC="${TTFB_WARN_THRESHOLD_SEC:-2.5}"
TOTAL_WARN_THRESHOLD_SEC="${TOTAL_WARN_THRESHOLD_SEC:-3.0}"
LATENCY_ALERT_CONSECUTIVE="${LATENCY_ALERT_CONSECUTIVE:-3}"

# Global metrics for latest health request.
LAST_TLS_TIME=""
LAST_TTFB_TIME=""
LAST_TOTAL_TIME=""
LATENCY_BREACH_STREAK=0
LATENCY_ALERT_ACTIVE=0

is_true() {
    case "$(echo "${1:-}" | tr '[:upper:]' '[:lower:]')" in
        1|true|yes|y|on) return 0 ;;
        *) return 1 ;;
    esac
}

is_number() {
    [[ "${1:-}" =~ ^[0-9]+([.][0-9]+)?$ ]]
}

float_gt() {
    awk -v a="${1:-0}" -v b="${2:-0}" 'BEGIN { exit((a+0) > (b+0) ? 0 : 1) }'
}

# 监控函数
monitor_health() {
    RESPONSE=$(curl -s -w "\n__META__ %{http_code} %{time_appconnect} %{time_starttransfer} %{time_total}" "$GATEWAY/healthz/lite" 2>/dev/null)
    META=$(echo "$RESPONSE" | tail -n1)
    BODY=$(echo "$RESPONSE" | sed '$d')
    HTTP_CODE=$(echo "$META" | awk '{print $2}')
    TLS_TIME=$(echo "$META" | awk '{print $3}')
    TTFB_TIME=$(echo "$META" | awk '{print $4}')
    TOTAL_TIME=$(echo "$META" | awk '{print $5}')
    LAST_TLS_TIME="$TLS_TIME"
    LAST_TTFB_TIME="$TTFB_TIME"
    LAST_TOTAL_TIME="$TOTAL_TIME"
    
    TIMESTAMP=$(date "+%Y-%m-%d %H:%M:%S")
    
    if [ "$HTTP_CODE" = "200" ] && echo "$BODY" | grep -q '"ok":true'; then
        echo -e "[$TIMESTAMP] ${GREEN}✅ Health Check: OK${NC} (tls=${TLS_TIME}s ttfb=${TTFB_TIME}s total=${TOTAL_TIME}s)" | tee -a "$LOG_FILE"
        return 0
    else
        echo -e "[$TIMESTAMP] ${RED}❌ Health Check: FAILED (HTTP $HTTP_CODE)${NC} (tls=${TLS_TIME:-n/a}s ttfb=${TTFB_TIME:-n/a}s total=${TOTAL_TIME:-n/a}s)" | tee -a "$LOG_FILE"
        return 1
    fi
}

check_latency_thresholds() {
    if ! is_true "$LATENCY_ALERT_ENABLED"; then
        return 0
    fi
    if ! is_number "$LAST_TLS_TIME" || ! is_number "$LAST_TTFB_TIME" || ! is_number "$LAST_TOTAL_TIME"; then
        return 0
    fi

    local breaches=()
    if float_gt "$LAST_TLS_TIME" "$TLS_WARN_THRESHOLD_SEC"; then
        breaches+=("tls=${LAST_TLS_TIME}s>${TLS_WARN_THRESHOLD_SEC}s")
    fi
    if float_gt "$LAST_TTFB_TIME" "$TTFB_WARN_THRESHOLD_SEC"; then
        breaches+=("ttfb=${LAST_TTFB_TIME}s>${TTFB_WARN_THRESHOLD_SEC}s")
    fi
    if float_gt "$LAST_TOTAL_TIME" "$TOTAL_WARN_THRESHOLD_SEC"; then
        breaches+=("total=${LAST_TOTAL_TIME}s>${TOTAL_WARN_THRESHOLD_SEC}s")
    fi

    if [ "${#breaches[@]}" -gt 0 ]; then
        LATENCY_BREACH_STREAK=$((LATENCY_BREACH_STREAK + 1))
        echo -e "${YELLOW}⚠️  Latency threshold breached${NC} (streak=${LATENCY_BREACH_STREAK}/${LATENCY_ALERT_CONSECUTIVE}): ${breaches[*]}" | tee -a "$LOG_FILE"
        if [ "$LATENCY_BREACH_STREAK" -ge "$LATENCY_ALERT_CONSECUTIVE" ] && [ "$LATENCY_ALERT_ACTIVE" -eq 0 ]; then
            echo -e "${RED}🚨 ALERT: Latency thresholds breached ${LATENCY_BREACH_STREAK} consecutive checks${NC}" | tee -a "$LOG_FILE"
            LATENCY_ALERT_ACTIVE=1
        fi
    else
        if [ "$LATENCY_ALERT_ACTIVE" -eq 1 ]; then
            echo -e "${GREEN}✅ Latency recovered below thresholds${NC}" | tee -a "$LOG_FILE"
        fi
        LATENCY_BREACH_STREAK=0
        LATENCY_ALERT_ACTIVE=0
    fi
}

test_search() {
    TIMESTAMP=$(date "+%Y-%m-%d %H:%M:%S")
    RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$GATEWAY/agent/shop/v1/invoke" \
        -H "Content-Type: application/json" \
        -d '{"operation":"find_products","payload":{"search":{"page":1,"page_size":1}}}' 2>/dev/null)
    
    HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
    BODY=$(echo "$RESPONSE" | sed '$d')
    
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
INTERVAL="${MONITOR_INTERVAL_SEC:-60}"
ERROR_COUNT=0
MAX_ERRORS="${MAX_ERRORS:-3}"

while true; do
    echo -e "\n--- Checking at $(date) ---"
    
    # 健康检查
    if monitor_health; then
        ERROR_COUNT=0
        check_latency_thresholds
    else
        ((ERROR_COUNT++))
        LATENCY_BREACH_STREAK=0
        LATENCY_ALERT_ACTIVE=0
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
