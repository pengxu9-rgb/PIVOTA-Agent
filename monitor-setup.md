# Pivota Agent 监控设置

## 1. 手动监控

### 健康检查和基础功能监控
```bash
# 运行持续监控（每30秒检查一次）
./monitor-pivota.sh

# 检查后端修复状态
./check-backend-fixes.sh
```

## 2. 定时监控（cron）

### 设置 cron 任务
```bash
# 编辑 crontab
crontab -e

# 添加以下行：
# 每5分钟检查健康状态
*/5 * * * * /Users/pengchydan/Desktop/Pivota\ Agent/monitor-pivota.sh >> /tmp/pivota-monitor.log 2>&1

# 每小时检查后端修复状态
0 * * * * /Users/pengchydan/Desktop/Pivota\ Agent/check-backend-fixes.sh >> /tmp/pivota-fixes.log 2>&1
```

## 3. 日志查看

```bash
# 查看最近的监控日志
tail -f /tmp/pivota-monitor.log

# 查看后端修复检查日志
tail -f /tmp/pivota-fixes.log
```

## 4. Railway 监控

Railway 提供内置监控功能：

1. **Metrics**: 在 Railway 控制面板查看 CPU、内存、响应时间
2. **Logs**: 实时查看应用日志
3. **Alerts**: 设置自定义告警（需要 Pro 计划）

## 5. 建议的监控策略

### 日常监控
- 使用 `monitor-pivota.sh` 进行基础健康检查
- 关注搜索和订单创建功能的可用性

### 问题追踪
- 使用 `check-backend-fixes.sh` 跟踪已知问题的修复状态
- 一旦修复，更新测试文档

### 生产监控（未来）
- 集成专业监控工具（如 Datadog、New Relic）
- 设置 SLA 监控和告警
- 添加业务指标监控（订单成功率、支付成功率等）

## 6. 问题上报流程

1. **发现问题**：监控脚本检测到异常
2. **收集信息**：保存相关日志和错误信息
3. **创建报告**：使用 `PIVOTA_ISSUES_EMAIL.md` 模板
4. **跟进修复**：定期运行 `check-backend-fixes.sh`

## 7. 当前已知问题

- ❌ 支付 API：字段不一致（total vs total_amount）
- ❌ 产品详情 API：store_info 未定义

使用 `./check-backend-fixes.sh` 检查这些问题是否已修复。
