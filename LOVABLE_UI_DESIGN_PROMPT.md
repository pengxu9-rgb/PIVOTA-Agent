# Pivota Shopping AI - Lovable UI 设计 Prompt

> 复制下面的完整内容发送给 Lovable.dev

---

## 🎯 项目概述

我需要设计一个**超现代、高端的AI购物助手界面**，比Apple Store和Stripe的设计更精致。

**项目名称**: Pivota Shopping AI  
**核心定位**: AI驱动的对话式购物平台  
**用户群**: 追求效率和品质的现代消费者  
**技术栈**: Next.js 15, React 18, TypeScript, Tailwind CSS

---

## 🎨 设计风格要求

### 整体风格
- **现代奢华**: 像Apple.com和Stripe.com的结合
- **极简主义**: 大量留白，干净利落
- **高端感**: 精致的渐变、柔和的阴影、流畅的动画
- **专业但友好**: 既有科技感又温暖亲切

### 色彩方案
**主色调**:
- 深邃的蓝紫渐变: `from-indigo-600 via-purple-600 to-blue-600`
- 或现代的灰度系统: `from-slate-900 via-slate-800 to-slate-900`

**辅助色**:
- 强调色: 鲜艳的青色 `#00D9FF` 或霓虹绿 `#00FF88`
- 成功: `#00C853` 
- 警告: `#FFB300`
- 错误: `#FF3D71`
- 背景: 深色模式 `#0A0A0F` 或浅色 `#FAFBFC`

### 视觉元素
- **玻璃态拟态** (Glassmorphism): 半透明卡片，模糊背景
- **柔和阴影**: 多层阴影营造深度
- **圆角**: 统一使用 `rounded-2xl` 或 `rounded-3xl`
- **渐变**: 精致的多色渐变，不要太强烈
- **动画**: Framer Motion，流畅的过渡和微交互

### 字体系统
- **标题**: Inter 或 Outfit (粗体)
- **正文**: Inter 或 DM Sans
- **等宽**: JetBrains Mono（代码/数据）
- **字重变化**: 从200到800，创造层次感

---

## 📱 核心页面设计

### 1. 主页 (/) - Hero + Chat Interface

#### Hero Section (占屏50%)
```
布局：
┌─────────────────────────────────────────┐
│  [大标题] AI-Powered Shopping            │
│  [副标题] Shop smarter through conversation │
│  [渐变背景动画] 3D流体动画或粒子效果         │
│  [悬浮的商品卡片预览] 轻微漂浮动画            │
└─────────────────────────────────────────┘
```

**设计要点**:
- 大号标题 (text-6xl或text-7xl)，渐变文字效果
- 背景使用动态渐变或3D元素
- 包含"Try it now" CTA按钮（玻璃态，悬停发光）
- 展示3-4个商品卡片在背景中轻微漂浮

#### Chat Interface (占屏50%)
```
布局：
┌────────────────────────────────────────┐
│  ┌─────────── Chat Header ──────────┐  │
│  │ 🤖 AI Assistant  [●在线]  [...]  │  │
│  └──────────────────────────────────┘  │
│                                        │
│  ┌─ Messages ─────────────────────┐   │
│  │ AI: Hi! What are you looking...│   │
│  │ [商品卡片 - 玻璃态悬浮卡片]       │   │
│  │ You: Show me hoodies           │   │
│  │ AI: Found 2 options...         │   │
│  └────────────────────────────────┘   │
│                                        │
│  ┌─ Input ───────────────────────┐    │
│  │ [输入框 + 发送按钮]              │    │
│  │ [快速建议泡泡: Water Bottle]    │    │
│  └────────────────────────────────┘   │
└────────────────────────────────────────┘
```

**设计要点**:
- 聊天容器：玻璃态卡片，背景模糊效果
- 消息气泡：AI用渐变背景，用户用纯色
- 商品卡片：内嵌在对话中，悬浮效果，hover放大
- 输入框：大而明显，带focus发光效果
- 快速建议：圆角pill形状，hover变色

---

### 2. 商品列表页 (/products) - Masonry Layout

```
布局：
┌──────────── Header（固定顶部）──────────┐
│ [Logo] Pivota    [搜索框]    [分类筛选] │
└─────────────────────────────────────────┘

┌────────── Filters (侧边栏) ──────────┐
│ □ Price Range (滑块)                 │
│ □ Category                          │
│ □ Rating                            │
│ □ In Stock                          │
└─────────────────────────────────────┘

┌─────── Products Grid ──────────────────┐
│ [Product 1]  [Product 2]  [Product 3]  │
│             [Product 4]  [Product 5]    │
│ [Product 6]  [Product 7]                │
│                                         │
│ 瀑布流布局，不同高度自然排列               │
└─────────────────────────────────────────┘
```

**商品卡片设计**:
```
┌─────────────────┐
│ [大图 - 悬停缩放] │
│                 │
│ [收藏心形图标]    │
│                 │
│ Title           │
│ ★★★★★ 4.5      │
│                 │
│ $59.00          │
│ [Add to Cart] [→]│
└─────────────────┘
```

- 卡片: 白色背景（浅色）或深灰（深色），柔和阴影
- Hover: 向上提升，阴影加深，边框发光
- 图片: 全宽，比例16:10，圆角
- 按钮: 渐变填充，悬停扩展动画

---

### 3. 商品详情页 (/products/[id]) - Split Layout

```
布局：
┌─────────────────────────────────────────────────┐
│ [← Back]              Pivota                    │
└─────────────────────────────────────────────────┘

┌──────────────┬──────────────────────────────────┐
│              │  CloudFit Hoodie                 │
│              │  ★★★★★ 4.5 (127 reviews)        │
│              │                                  │
│  [大图展示]   │  $59.00                          │
│  图片画廊     │  ✓ In Stock • Free Shipping      │
│  可切换       │                                  │
│  缩放查看     │  [商品描述 - 优雅排版]             │
│              │                                  │
│              │  Size: [S] [M] [L] [XL]          │
│              │                                  │
│              │  [Add to Cart - 大号按钮]         │
│              │  [Buy Now - 渐变按钮]             │
│              │                                  │
│              │  [特性图标: 运输/退货/保修]         │
└──────────────┴──────────────────────────────────┘

[相关商品轮播 - 水平滚动]
```

**设计要点**:
- 左侧图片: 占50%，sticky，可点击放大查看
- 右侧信息: 优雅的排版，清晰的层次
- Size选择器: 大号圆形按钮，选中后填充渐变
- Add to Cart: 次要按钮，outline风格
- Buy Now: 主要按钮，渐变背景，发光效果

---

### 4. 购物车 - 侧滑抽屉 (Drawer)

```
┌─────────────────────────────────────┐
│ Shopping Cart              [X]      │
├─────────────────────────────────────┤
│                                     │
│ ┌─────────────────────────────┐    │
│ │[图] CloudFit Hoodie  [$59] │    │
│ │    Size: M                  │    │
│ │    [- 1 +]           [删除]  │    │
│ └─────────────────────────────┘    │
│                                     │
│ ┌─────────────────────────────┐    │
│ │[图] Water Bottle     [$25] │    │
│ │    [- 2 +]           [删除]  │    │
│ └─────────────────────────────┘    │
│                                     │
├─────────────────────────────────────┤
│ Subtotal:             $109.00       │
│ Shipping:             FREE          │
│ ────────────────────────────────    │
│ Total:                $109.00       │
│                                     │
│ [Checkout - 全宽渐变按钮]             │
└─────────────────────────────────────┘
```

**设计要点**:
- 从右侧滑入，带模糊背景遮罩
- 商品项：紧凑但不拥挤，清晰分隔
- 数量调整：大号 +/- 按钮
- 总计：大号粗体，突出显示
- Checkout按钮：渐变，动画，impossible to miss

---

### 5. Checkout流程 (/order) - 多步骤表单

```
进度条：
○━━━━━○━━━━━○━━━━━○
Review  Ship   Pay   Done

┌────────────────────────────────────┐
│ Step 1: Review Your Order          │
│                                    │
│ [商品列表 - 精简版]                  │
│                                    │
│ Subtotal: $109.00                  │
│ Shipping: FREE                     │
│ Total:    $109.00                  │
│                                    │
│ [Continue →] 大号渐变按钮            │
└────────────────────────────────────┘
```

**设计要点**:
- 顶部进度条：现代感，当前步骤高亮发光
- 每步：单一聚焦，大号清晰
- 表单：宽松间距，大号input，清晰label
- 按钮：巨大的CTA，不可能错过

---

## 🎭 高级UI元素

### 商品卡片（Chat中）
```css
/* 玻璃态悬浮卡片 */
backdrop-filter: blur(20px)
background: rgba(255, 255, 255, 0.7)
border: 1px solid rgba(255, 255, 255, 0.3)
box-shadow: 
  0 8px 32px rgba(0, 0, 0, 0.1),
  inset 0 1px 0 rgba(255, 255, 255, 0.5)
```

**Hover效果**:
- 向上提升 8px
- 阴影扩大
- 边框发光
- 轻微放大 (scale: 1.02)
- 过渡动画 300ms cubic-bezier

### Toast通知
```
┌────────────────────────────┐
│ ✓ Added to cart!           │
│ CloudFit Hoodie            │
│                 [View Cart]│
└────────────────────────────┘
```

**设计**:
- 从顶部滑入
- 玻璃态背景
- 成功用绿色渐变左边框
- 可点击查看购物车
- 4秒后优雅淡出

### Loading状态
- **骨架屏**: 渐变动画从左到右扫过
- **Spinner**: 3D旋转的购物袋图标
- **Progress**: 细长的渐变进度条

---

## 💫 动画和微交互

### 页面过渡
- 淡入淡出 + 轻微位移
- 使用 Framer Motion
- duration: 400ms
- easing: cubic-bezier(0.4, 0, 0.2, 1)

### 按钮交互
```javascript
// Hover
scale: 1.05
brightness: 1.1
shadow: 扩大

// Active
scale: 0.98

// Focus
ring: 2px渐变边框
```

### 商品卡片
```javascript
// Hover
translateY: -8px
shadow: 0 20px 40px rgba(0,0,0,0.2)
image: scale(1.05)
border: 渐变发光

// Click
ripple effect: 从点击点扩散
```

---

## 📐 具体页面设计需求

### 主页 Hero Section

**Vision**:
想象用户打开页面，立即被惊艳的视觉效果吸引。

**元素**:
1. **超大标题**:
   ```
   Shop Anything
   Through Conversation
   ```
   - 文字渐变效果
   - 轻微的发光（text-shadow）
   - 打字机动画或淡入动画

2. **3D背景**:
   - 流动的渐变背景
   - 或漂浮的3D几何图形
   - 或粒子效果
   - 轻微的视差滚动

3. **悬浮的商品预览卡片**:
   - 3-4张商品图片
   - 随机位置，轻微旋转
   - 上下漂浮动画
   - 玻璃态效果

4. **CTA按钮**:
   ```
   [Start Shopping with AI →]
   ```
   - 大号（py-6 px-12）
   - 渐变背景
   - 悬浮阴影
   - Hover发光效果
   - 点击ripple动画

### 聊天界面

**容器**:
- 最大宽度 1200px
- 玻璃态卡片
- 圆角 3xl
- 轻微的边框发光

**消息气泡**:
```css
/* AI消息 */
background: linear-gradient(135deg, #667eea 0%, #764ba2 100%)
color: white
border-radius: 24px 24px 24px 4px
padding: 16px 20px
box-shadow: 0 4px 12px rgba(102, 126, 234, 0.3)

/* 用户消息 */
background: rgba(255, 255, 255, 0.1)
backdrop-filter: blur(10px)
border: 1px solid rgba(255, 255, 255, 0.2)
border-radius: 24px 24px 4px 24px
```

**商品卡片（内嵌）**:
```
┌─────────────────────────────────┐
│ ┌────┐                          │
│ │图片│ CloudFit Hoodie           │
│ │    │ Ultra-soft fleece...      │
│ │200x│ $59.00  ★4.5             │
│ │200 │ [Buy Now] [Add to Cart]  │
│ └────┘                          │
└─────────────────────────────────┘
```

- 水平布局
- 图片左侧，圆角
- 信息紧凑但易读
- 按钮小而精致
- Hover: 整个卡片发光

**输入区域**:
```
┌────────────────────────────────────┐
│ [I'm looking for...]               │
│                            [发送↑] │
│ 💡 Water bottle  🎧 Headphones     │
└────────────────────────────────────┘
```

- 大号input (py-4)
- 圆角2xl
- 浅色边框，focus时渐变发光
- 快速建议：pill形状，渐变背景
- 发送按钮：圆形，渐变，图标

### 商品列表页

**顶部搜索栏**:
```
┌──────────────────────────────────────┐
│ [🔍 Search products...]   [Filter]   │
│                                      │
│ Trending: Hoodies・Water Bottles・Tech│
└──────────────────────────────────────┘
```

**产品网格**: 
- 使用Masonry布局（Pinterest风格）
- 或规则网格但卡片高度可变
- 4列（桌面），2列（平板），1列（手机）
- 间距：gap-6或gap-8

**产品卡片**（升级版）:
```
┌──────────────┐
│              │
│  [大图]       │ 
│              │
│ ♡           │ ← 收藏图标（右上角）
├──────────────┤
│ Title        │
│ ★★★★★       │
│ $59.00       │
│              │
│ [Add to Cart]│
│ [Quick View] │ ← Hover显示
└──────────────┘
```

- 图片比例: 3:4（适合服装）
- Quick View: hover显示，点击弹出模态框
- 价格: 大号粗体，渐变色
- 评分: 金色星星，悬浮效果

### 商品详情页

**图片画廊**（左侧）:
- 主图：大而清晰
- 缩略图：底部横向排列
- 点击：平滑切换，淡入淡出
- 放大镜功能：hover显示放大区域

**信息区域**（右侧）:
```
CloudFit Hoodie
★★★★★ 4.5 (127 reviews)

$59.00
✓ In Stock • Ships in 1-2 days
──────────────────────

Description:
Ultra-soft fleece hoodie with...

Features:
🚚 Free Shipping
↩️ 30-Day Returns
🛡️ Secure Checkout

Size: ○ S  ● M  ○ L  ○ XL

Color: [黑] [白] [灰]

Quantity: [- 1 +]

[Add to Cart - 次要按钮，全宽]
[Buy Now - 主要按钮，渐变，全宽]

♡ Add to Wishlist
```

**设计细节**:
- Size按钮：圆形，选中后填充渐变
- Color按钮：显示实际颜色，边框高亮选中
- 数量调整：大号按钮，easy to tap
- 主按钮：不可忽视的大，渐变，动画

### Checkout页面

**进度指示器**:
```
●━━━━━○━━━━━○━━━━━○
Review  Ship   Pay   Done
```

- 圆点：当前步骤大而发光
- 线条：渐变，已完成部分亮色
- 动画：步骤切换时滑动高亮

**表单设计**:
```
┌─────────────────────┐
│ Shipping Address    │
│                     │
│ Full Name           │
│ [input - 大号]       │
│                     │
│ Email               │
│ [input - 大号]       │
│                     │
│ Address             │
│ [input - 大号]       │
│                     │
│ [← Back] [Continue→]│
└─────────────────────┘
```

- Input: 高度 56px，圆角lg
- Label: 小而清晰，上方或内部
- 验证: 实时，图标+颜色反馈
- 按钮: 底部固定，一直可见

---

## 🎨 组件库需求

### 按钮变体
```javascript
// Primary - 渐变
<Button variant="gradient">Buy Now</Button>
// 渐变背景 + 白色文字 + 阴影 + hover发光

// Secondary - 描边
<Button variant="outline">Add to Cart</Button>
// 透明背景 + 渐变边框 + hover填充

// Ghost - 幽灵
<Button variant="ghost">Cancel</Button>
// 无背景 + hover浅色背景

// Icon - 图标
<Button variant="icon" size="sm">♡</Button>
// 圆形 + 图标 + hover旋转
```

### 输入框
```javascript
<Input 
  label="Email"
  placeholder="you@example.com"
  icon={<Mail />}
  validation="email"
/>
```

- 大号（h-14）
- 左侧图标（可选）
- 浮动label或上方label
- Focus: 渐变边框发光
- Error: 红色边框 + shake动画

### 卡片
```javascript
<Card variant="glass">
  // 玻璃态
</Card>

<Card variant="elevated">
  // 立体阴影
</Card>

<Card variant="bordered">
  // 渐变边框
</Card>
```

---

## 🌈 深色/浅色模式

### 浅色模式
- 背景: `#FAFBFC` 到 `#F5F7FA` 渐变
- 卡片: 白色 `#FFFFFF`
- 文字: `#1A1A1A`
- 边框: `#E5E7EB`

### 深色模式
- 背景: `#0A0A0F` 到 `#1A1A2E` 渐变
- 卡片: `#1E1E2E` 半透明
- 文字: `#FFFFFF`
- 边框: `#2A2A3E` 发光

**切换器**: 右上角，太阳/月亮图标，平滑过渡

---

## 📱 响应式设计

### 桌面 (1280px+)
- 聊天占50%屏幕
- 商品4列网格
- 侧边栏筛选器

### 平板 (768px-1279px)
- 聊天占60%
- 商品2列
- 筛选器折叠

### 手机 (< 768px)
- 聊天全屏
- 商品1列
- 底部导航栏
- 购物车全屏模态

---

## ✨ 独特功能

### 1. AI思考动画
搜索时显示：
```
🤖 Thinking...
[三个点跳动动画]
或 [渐变加载条]
```

### 2. 商品出现动画
搜索结果返回时：
- 卡片依次淡入
- 从下到上滑入
- stagger效果（间隔100ms）

### 3. 空状态
```
┌──────────────────┐
│  [大图标]         │
│  No items yet    │
│  Start shopping! │
│  [Browse →]      │
└──────────────────┘
```

- 可爱但专业的插图
- 明确的CTA

### 4. 成功动画
支付成功后：
- Confetti动画
- 或check mark展开动画
- 或涟漪扩散效果

---

## 🎯 参考设计

**风格参考**:
- **Apple.com**: 极简、大气、留白
- **Stripe.com**: 现代、专业、渐变
- **Linear.app**: 速度感、流畅动画
- **Vercel.com**: 深色模式、锐利

**避免**:
- ❌ 过于花哨的动画
- ❌ 太多颜色（保持2-3主色）
- ❌ 复杂的布局
- ❌ 小而密集的文字

**追求**:
- ✅ 大胆的留白
- ✅ 清晰的视觉层次
- ✅ 流畅的交互
- ✅ Wow factor

---

## 🛠️ 技术要求

### 必须使用
- **Next.js 15** + App Router
- **TypeScript** - 完整类型
- **Tailwind CSS** - 样式
- **Framer Motion** - 动画
- **Lucide Icons** - 图标
- **Zustand** - 状态管理

### UI组件库（可选）
- Radix UI (headless组件)
- Shadcn UI (美观组件)
- 或完全自定义

### 性能要求
- Lighthouse Score > 90
- 首次加载 < 2秒
- 所有动画 60fps

---

## 📦 交付要求

### 需要的页面
1. ✅ 主页（Hero + Chat）
2. ✅ 商品列表
3. ✅ 商品详情
4. ✅ 购物车（Drawer）
5. ✅ Checkout（3步）
6. ✅ 订单成功页面

### 需要的组件
- Button（多种变体）
- Input / Textarea
- ProductCard
- Toast
- Loading / Skeleton
- Modal / Drawer
- Badge / Tag

### 文件结构
```
src/
├── app/
│   ├── page.tsx (主页)
│   ├── products/
│   ├── order/
│   └── ...
├── components/
│   ├── ui/ (基础组件)
│   ├── product/
│   ├── cart/
│   └── checkout/
├── lib/
└── styles/
```

---

## 🎨 色彩方案示例

### Option 1: 现代紫蓝
```css
--primary: #6366F1 (indigo-500)
--secondary: #8B5CF6 (violet-500)
--accent: #06B6D4 (cyan-500)
--background: #FAFBFC
--surface: #FFFFFF
```

### Option 2: 深邃暗黑
```css
--primary: #00D9FF (cyan neon)
--secondary: #BD00FF (purple neon)
--accent: #00FF88 (green neon)
--background: #0A0A0F
--surface: #1A1A2E
```

### Option 3: 高级灰度
```css
--primary: #2563EB (blue-600)
--secondary: #7C3AED (purple-600)
--accent: #059669 (emerald-600)
--background: #F8FAFC
--surface: #FFFFFF
```

**我倾向**: Option 1 或 Option 2（根据整体感觉选择）

---

## 💡 灵感关键词

- Glassmorphism（玻璃态）
- Neumorphism（新拟态）
- Gradient mesh（渐变网格）
- Floating elements（悬浮元素）
- Micro-interactions（微交互）
- Smooth animations（流畅动画）
- Premium feel（高端感）
- Conversion-focused（注重转化）

---

## 🎯 最终目标

创建一个让用户：
1. **第一眼被吸引** - Wow, this looks amazing!
2. **立即理解** - I know exactly what to do
3. **享受使用** - This is so smooth!
4. **完成购买** - That was easier than I thought!

**比肩标准**: 
- 设计质量 = Apple Store
- 动画流畅度 = Linear.app
- 用户体验 = Stripe Checkout
- 创新性 = Better than all of them

---

**开始设计吧！期待看到惊艳的结果！** ✨

---

## 附录：当前API集成信息

### API端点
```
商品搜索: POST https://pivota-agent-production.up.railway.app/agent/shop/v1/invoke
操作: find_products, create_order, submit_payment
```

### 数据格式
```typescript
interface Product {
  id: string
  title: string
  description: string
  price: number
  currency: string
  image_url: string
  inventory_quantity: number
}
```

Lovable设计时可以先用mock数据，我们会在搬迁时连接真实API。
