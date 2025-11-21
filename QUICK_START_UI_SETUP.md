# 快速启动：Pivota Agent UI项目

**立即开始！只需15分钟搭建基础框架** 🚀

## 📋 前置准备
- Node.js 18+ 已安装
- Git 已配置
- 有Vercel账号（用于部署）

## 🏃‍♂️ 5分钟快速开始

### Step 1: 创建项目
```bash
# 创建项目目录
mkdir pivota-agent-ui && cd pivota-agent-ui

# 使用Next.js模板快速初始化
npx create-next-app@latest . --typescript --tailwind --app --src-dir --import-alias "@/*"

# 安装额外依赖
npm install @radix-ui/themes lucide-react zustand axios
npm install -D @types/node
```

### Step 2: 创建基础聊天界面
```bash
# 创建核心组件
mkdir -p src/components/chat src/components/product src/app/api
```

创建 `src/components/chat/ChatInterface.tsx`:
```tsx
'use client'

import { useState } from 'react'
import { Send } from 'lucide-react'

export default function ChatInterface() {
  const [messages, setMessages] = useState([
    { role: 'assistant', content: 'Hi! I\'m your Pivota shopping assistant. What are you looking for today?' }
  ])
  const [input, setInput] = useState('')

  const handleSend = () => {
    if (!input.trim()) return
    
    setMessages([...messages, { role: 'user', content: input }])
    setInput('')
    
    // 模拟AI响应
    setTimeout(() => {
      setMessages(prev => [...prev, { 
        role: 'assistant', 
        content: 'I found some great options for you!' 
      }])
    }, 1000)
  }

  return (
    <div className="flex flex-col h-screen max-w-4xl mx-auto">
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-xs lg:max-w-md px-4 py-2 rounded-lg ${
              msg.role === 'user' 
                ? 'bg-blue-500 text-white' 
                : 'bg-gray-200 text-gray-800'
            }`}>
              {msg.content}
            </div>
          </div>
        ))}
      </div>
      
      <div className="border-t p-4">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleSend()}
            placeholder="Ask me anything about shopping..."
            className="flex-1 px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            onClick={handleSend}
            className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
          >
            <Send size={20} />
          </button>
        </div>
      </div>
    </div>
  )
}
```

### Step 3: 更新主页
替换 `src/app/page.tsx`:
```tsx
import ChatInterface from '@/components/chat/ChatInterface'

export default function Home() {
  return (
    <main className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm border-b">
        <div className="max-w-4xl mx-auto px-4 py-4">
          <h1 className="text-2xl font-bold text-gray-800">Pivota Shopping AI</h1>
        </div>
      </header>
      <ChatInterface />
    </main>
  )
}
```

### Step 4: 创建商品卡片组件
创建 `src/components/product/ProductCard.tsx`:
```tsx
interface ProductCardProps {
  title: string
  price: number
  image?: string
  description?: string
  onBuy?: () => void
}

export default function ProductCard({ 
  title, 
  price, 
  image = '/placeholder.png', 
  description,
  onBuy 
}: ProductCardProps) {
  return (
    <div className="bg-white rounded-lg shadow-md p-4 max-w-sm">
      <img 
        src={image} 
        alt={title} 
        className="w-full h-48 object-cover rounded-md mb-4"
      />
      <h3 className="font-semibold text-lg mb-2">{title}</h3>
      {description && (
        <p className="text-gray-600 text-sm mb-3">{description}</p>
      )}
      <div className="flex justify-between items-center">
        <span className="text-xl font-bold text-blue-600">
          ${price.toFixed(2)}
        </span>
        <button
          onClick={onBuy}
          className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
        >
          Buy Now
        </button>
      </div>
    </div>
  )
}
```

### Step 5: 快速部署到Vercel
```bash
# 初始化Git仓库
git init
git add .
git commit -m "Initial Pivota Agent UI"

# 创建GitHub仓库并推送
# (在GitHub创建新仓库后)
git remote add origin https://github.com/YOUR_USERNAME/pivota-agent-ui.git
git push -u origin main

# 部署到Vercel
npm i -g vercel
vercel

# 配置自定义域名
# 在Vercel Dashboard中添加 agent.pivota.cc
```

## 🎨 快速美化（5分钟）

### 添加渐变背景
更新 `src/app/globals.css`:
```css
@layer base {
  body {
    @apply bg-gradient-to-br from-blue-50 to-indigo-100 min-h-screen;
  }
}
```

### 添加动画效果
```css
@layer utilities {
  .animate-slide-up {
    animation: slideUp 0.3s ease-out;
  }
  
  @keyframes slideUp {
    from {
      transform: translateY(20px);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }
}
```

## 📱 移动端优化（3分钟）

更新 `src/app/layout.tsx`:
```tsx
export const metadata = {
  title: 'Pivota Shopping AI - Your Personal Shopping Assistant',
  description: 'AI-powered shopping made simple',
  viewport: 'width=device-width, initial-scale=1, maximum-scale=1',
}
```

## 🔗 连接到后端（准备就绪时）

创建 `src/lib/api.ts`:
```typescript
const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'https://pivota-agent-production.up.railway.app'

export async function sendMessage(message: string) {
  const response = await fetch(`${API_BASE}/agent/shop/v1/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      operation: 'find_products',
      payload: { 
        search: { 
          merchant_id: 'merch_208139f7600dbf42',
          query: message 
        }
      }
    })
  })
  return response.json()
}
```

## ⚡ 立即可见的成果

执行完以上步骤后，你将拥有：
1. ✅ 一个运行在 localhost:3000 的聊天界面
2. ✅ 响应式设计，支持手机访问
3. ✅ 部署在 agent.pivota.cc 的生产版本
4. ✅ 可以立即展示给团队的原型

## 🚀 下一步行动

1. **今天**: 完成基础UI并部署
2. **明天**: 添加更多交互细节
3. **本周**: 集成真实API数据

---

**需要帮助？**
- Tailwind CSS文档: https://tailwindcss.com
- Next.js文档: https://nextjs.org
- Vercel部署指南: https://vercel.com/docs
