# Pivota Agent UI优化计划

**创建时间**: 2025-11-21  
**目标**: 在正式接入LLM前，创建一个现代化、用户友好的购物助手界面

## 🎨 UI设计原则

### 1. **对话式界面**
- 类似ChatGPT的聊天界面
- 清晰的消息气泡区分用户和助手
- 支持富文本展示（商品卡片、图片、按钮等）

### 2. **视觉风格**
- 现代、简洁、可信赖
- 主色调：Pivota品牌色（蓝/绿色系）
- 响应式设计，支持移动端

### 3. **核心功能模块**
- 🗨️ 对话界面
- 🛍️ 商品展示卡片
- 🛒 购物车预览
- 📦 订单跟踪
- 💳 支付流程

## 📐 技术架构建议

### 前端框架选择
```
推荐: React + Next.js
原因: 
- SEO友好（对商品页面很重要）
- 优秀的性能和开发体验
- 丰富的UI组件库支持
```

### UI组件库
```
推荐: Tailwind CSS + shadcn/ui
备选: Ant Design / Material-UI
```

### 状态管理
```
推荐: Zustand（轻量级）
备选: Redux Toolkit
```

## 🖼️ 核心页面设计

### 1. 主页（agent.pivota.cc）
```
┌─────────────────────────────────────┐
│        Pivota Shopping AI           │
│                                     │
│   👋 Hi! I'm your shopping assistant│
│                                     │
│   ┌─────────────────────────────┐   │
│   │  Try: "Find me a water bottle"│  │
│   │       "Track my order"        │  │
│   │       "Best laptop under $800"│  │
│   └─────────────────────────────┘   │
│                                     │
│   [Start Shopping] [How it Works]   │
└─────────────────────────────────────┘
```

### 2. 聊天界面
```
┌─────────────────────────────────────┐
│ < Back    Pivota Assistant    ⚙️     │
├─────────────────────────────────────┤
│                                     │
│ AI: Hi! What can I help you find?  │
│                                     │
│ You: I need a good water bottle    │
│                                     │
│ AI: I found these options for you: │
│     ┌───────────────────┐          │
│     │ [Product Card 1]  │          │
│     │ $15.99 - Buy Now │          │
│     └───────────────────┘          │
│                                     │
├─────────────────────────────────────┤
│ Type your message...           Send │
└─────────────────────────────────────┘
```

### 3. 商品卡片组件
```jsx
<ProductCard>
  - 商品图片
  - 标题和描述
  - 价格显示
  - "Add to Cart" / "View Details" 按钮
  - 评分和评论数（如有）
</ProductCard>
```

## 🚀 实施步骤

### Phase 1: 基础框架搭建（2-3天）
1. [ ] 初始化Next.js项目
2. [ ] 配置Tailwind CSS和基础样式
3. [ ] 创建基础布局组件
4. [ ] 设置路由结构

### Phase 2: 核心功能开发（3-4天）
1. [ ] 实现聊天界面组件
2. [ ] 创建商品展示卡片
3. [ ] 添加购物流程页面
4. [ ] 集成模拟数据进行测试

### Phase 3: 优化和完善（2-3天）
1. [ ] 响应式设计优化
2. [ ] 添加加载状态和错误处理
3. [ ] 性能优化（图片懒加载等）
4. [ ] 部署到agent.pivota.cc

## 🔧 域名配置

### 1. DNS设置
```
Type: CNAME
Name: agent
Value: [部署平台的域名]
TTL: 300
```

### 2. SSL证书
- 使用Let's Encrypt自动证书
- 或通过部署平台（Vercel/Railway）自动配置

### 3. 部署选项
- **推荐**: Vercel（对Next.js优化最好）
- **备选**: Railway / Netlify

## 📊 成功指标

### 技术指标
- [ ] Lighthouse性能分数 > 90
- [ ] 移动端响应时间 < 3秒
- [ ] SEO分数 > 95

### 用户体验指标
- [ ] 用户可在30秒内理解如何使用
- [ ] 完成一次购物流程 < 2分钟
- [ ] 界面加载无明显卡顿

## 🎯 与LLM集成的准备

### 预留接口
```typescript
interface AgentAPI {
  // 对话处理
  sendMessage(message: string): Promise<Response>
  
  // 商品操作
  searchProducts(query: string): Promise<Product[]>
  getProductDetail(id: string): Promise<Product>
  
  // 订单操作
  createOrder(items: CartItem[]): Promise<Order>
  trackOrder(orderId: string): Promise<OrderStatus>
}
```

### Mock数据结构
在后端修复期间，使用符合API规范的模拟数据，确保后续无缝切换。

## 🌟 设计灵感参考

1. **ChatGPT** - 对话界面设计
2. **Perplexity Shopping** - 商品展示方式
3. **Amazon Rufus** - 购物助手交互
4. **Google Shopping** - 商品卡片设计

## 📝 注意事项

1. **不要过度设计** - 保持简洁，专注核心功能
2. **移动优先** - 确保在手机上也有良好体验
3. **预留扩展性** - 为未来功能留出接口
4. **注重性能** - 快速响应是AI助手的关键

---

**下一步行动**: 
1. 创建GitHub仓库
2. 初始化Next.js项目
3. 开始实现基础UI组件
