# FastStudy Chrome Plugin — Spec v1.0

> 项目名 `FastStudy Chrome Plugin`（日语生词收藏 Chrome 扩展，集成 jp.frank2025.com 后端）。
> 文档状态：v1.0 MVP 锁 spec；后续以本文件为单一事实源。

---

## 1. 目标

零摩擦日语生词收藏 Chrome 扩展：在任意网页选中日语 → 右键 → 收藏为生词 → 自动保存到 jp.frank2025.com 词汇库。

**成功标准（MVP）**：用户在 Chrome 任意网页选中日语单词 → 右键 → "收藏为生词" → Toast "✓ 已收藏" → 打开 jp.frank2025.com/vocabulary 能看到。

---

## 2. MVP 范围

### ✅ 包含

- Manifest V3 + TypeScript + Vite + crxjs
- chrome.contextMenus（selection 上下文）→ 右键菜单"收藏为生词"
- 选中文字 + 页面 URL + 页面标题
- 离线队列（chrome.storage.local pendingVocabulary）
- Popup：连接状态 / 今日收藏数 / 本周收藏数 / 跳转词汇库 / 设置
- Extension Token 认证（Bearer token，连 jp.frank2025.com 后端）
- Toast 反馈（已收藏 / 已收藏过 / 未连接 / 网络错误 / 401 失效）
- 重复检测（后端基于 word + reading + user_id）
- i18n：en / zh_CN / zh_TW / ja
- 一次性连接码 + token 撤销/重新生成（jp.frank2025.com Settings 页）

### ❌ 不包含（v2+）

- AI 自动翻译 / 例句 / JLPT / 词性（异步占位字段后端先预留）
- content script 浮窗（划词浮窗 UI）
- 批量收藏
- 快捷键 Alt+Shift+F
- YouTube 字幕解析
- 页面全文解析
- 自动翻译注入

---

## 3. 技术选型

| 维度 | 选择 | 理由 |
|---|---|---|
| Manifest | Chrome MV3 | 当前标准 |
| 语言 | TypeScript | 类型安全 |
| 构建 | Vite + crxjs | HMR + MV3 开箱即用 |
| 后端 API | jp.frank2025.com | 已 Supabase + Next.js + 已有 vocabulary |
| 认证 | Bearer Extension Token（SHA-256 hash 存后端） | 避免明文 + 撤销能力 |
| 存储 | chrome.storage.local（待同步队列 + 设置） | 简单；离线队列 |
| Popup UI | React + lucide-react | 复用熟悉栈 |
| i18n | chrome.i18n + _locales/{en,zh_CN,zh_TW,ja} | Chrome 标准 |
| 测试 | Vitest | 复用 lib/phraseExtractor 测试 |

---

## 4. 架构

```
FastStudy-ChromePlugin/
├── manifest.json (MV3, contextMenus, host_permissions, permissions)
├── vite.config.ts
├── tsconfig.json
├── package.json
│
├── src/
│   ├── background/
│   │   └── background.ts    ← service worker；contextMenus + fetch POST /api/vocabulary
│   ├── popup/
│   │   ├── popup.html       ← extension popup entry
│   │   ├── popup.tsx        ← React UI
│   │   └── popup.css        ← styles
│   ├── lib/
│   │   ├── db.ts            ← chrome.storage.local wrapper + pendingVocabulary queue
│   │   ├── settings.ts      ← chrome.storage.local settings (extensionToken, sourceLabel)
│   │   ├── types.ts         ← Vocabulary, Source, PendingItem
│   │   ├── phraseExtractor.ts ← 多词短语提取（保留自原 FastStudy，V2 用）
│   │   └── srs.ts           ← SM-2 算法（保留，V2 用）
│   └── _locales/
│       ├── en/messages.json
│       ├── zh_CN/messages.json
│       ├── zh_TW/messages.json
│       └── ja/messages.json
│
├── public/
│   └── icons/{16,32,48,128}.png + icon.svg
│
├── scripts/
│   └── rasterize-icons.mjs
│
└── tests/
    └── phraseExtractor.test.ts
```

---

## 5. 关键数据流

```
用户在 Chrome 网页中选中日语
        ↓
右键 → "收藏为生词"
        ↓
background.ts 监听 onClicked → info.selectionText + info.pageUrl + info.pageTitle
        ↓
读 chrome.storage.local.extensionToken
        ↓
token 缺失？
  ↓ Yes
  Toast: "请先连接 FastStudy" + [连接] 按钮 → 打开 jp.frank2025.com/settings/browser-extension
  ↓ No
fetch POST https://jp.frank2025.com/api/vocabulary
  Headers: Authorization: Bearer <token>
  Body: { word, source: "chrome-extension", sourceUrl, sourceTitle }
        ↓
响应：
  201 成功 → Toast "✓ 已收藏 厄介"
  200 重复 → Toast "✓ 已收藏过 厄介"
  401/403 token 失效 → Toast "连接已失效 [重新连接]"
  422 参数错误 → Toast "收藏失败"
  429 限流 → Toast "请求过于频繁，请稍后再试"
  5xx 服务器错误 → 存 pendingVocabulary → Toast "已存到待同步队列"
        ↓
网络失败 → 存 pendingVocabulary → Toast "收藏失败，已存到待同步队列"
```

### 离线同步

- 网络恢复后由 background 检测 `navigator.onLine === true` 或 alarm 触发 `syncPendingQueue()`
- pendingVocabulary: `Array<{word, sourceUrl, sourceTitle, sourceFavicon?, createdAt}>`
- 同步成功后从队列移除；同步失败保留
- Popup 显示"待同步：N"

---

## 6. manifest.json 关键字段

```json
{
  "manifest_version": 3,
  "name": "FastStudy 日语生词收藏",
  "version": "1.0.0",
  "description": "Save Japanese vocabulary to FastStudy (jp.frank2025.com).",
  "permissions": ["contextMenus", "storage", "alarms"],
  "host_permissions": ["https://jp.frank2025.com/*"],
  "background": {
    "service_worker": "src/background/background.ts",
    "type": "module"
  },
  "action": {
    "default_popup": "src/popup/popup.html",
    "default_title": "FastStudy",
    "default_icon": { "16": "icons/icon-16.png", "32": "icons/icon-32.png", "48": "icons/icon-48.png" }
  },
  "icons": {
    "16": "icons/icon-16.png",
    "32": "icons/icon-32.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  },
  "default_locale": "en"
}
```

---

## 7. 里程碑

| 阶段 | 时长 | 交付物 | 验证 |
|---|---|---|---|
| M0 项目骨架 | 0.5 天 | 改 workspace\FastStudy 为日语生词收藏扩展；spec.md + package.json + vite.config + manifest 通过 | `npm run build` 装载 Chrome |
| M1 contextMenus | 0.5 天 | 右键菜单"收藏为生词"（selection 上下文） | 任意网页选中文字 → 右键看到菜单 |
| M2 Token 认证 | 1 天 | Settings 页生成连接码；扩展输入码 → 颁发 token | jp.frank2025.com/settings/browser-extension 流程跑通 |
| M3 fetch POST | 1 天 | background fetch POST /api/vocabulary + Toast | 选中厄介 → 弹 "✓ 已收藏" → vocabulary 页面看到 |
| M4 重复检测 | 0.5 天 | 后端返 200 duplicate → Toast "已收藏过" | 重复收藏厄介 → "已收藏过" |
| M5 离线队列 | 1 天 | 网络失败 → 存 chrome.storage.local + Toast + 后台同步 | 断网收藏 → 联网后自动同步 |
| M6 Popup UI | 1 天 | 连接状态 + 今日/本周收藏数 + 跳转词汇库 + 设置 | chrome://extensions 看 popup |
| M7 i18n | 0.5 天 | en + zh_CN + zh_TW + ja | 切换语言 |
| M8 测试 + 文档 | 1 天 | phraseExtractor 测试 + README + 验收 | 全部 spec §1 成功标准达成 |

**总计：~7 工作日**

---

## 8. 风险 & 缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| Chrome MV3 service worker 60s 生命周期 | 中 | 高 | 用 chrome.alarms 保持心跳 |
| 后端 401/403 频繁 | 中 | 中 | Toast 明确提示 + "重新连接" 按钮 |
| offline queue 数据丢失 | 低 | 中 | chrome.storage.local 持久化 + 启动时 sync |
| 用户误关 token | 中 | 低 | Settings 页可重新生成 token |
| Chrome Web Store 审核驳回 | 中 | 中 | MVP 不发布；先开发者模式本地测 |

---

## 9. 决策记录

| 日期 | 决策 | 理由 |
|---|---|---|
| 2026-08-21 | 复制 workspace\FastStudy 资产到 F:\GooglePlugin\ | vite.config.ts + i18n + icons + srs + phraseExtractor + db wrapper 全部现成，省 1-2 天 |
| 2026-08-21 | 不 fork 原 FastStudy repo | 原 repo 是 YouTube MVP，独立演进 |
| 2026-08-21 | 不复制 memory/、dist/、node_modules/ | workspace 私有 + 构建产物 |
| 2026-08-21 | MVP 不做 AI（异步占位字段后端预留） | 需求三十一明确 |
| 2026-08-21 | MVP 不做 content script | 需求三十三 V3 才加浮窗 |
| 2026-08-21 | Extension Token 长度 = 32 字节 base64url (≈43 字符) + SHA-256 hash | 足够安全；hash 防明文泄露 |

---

## 10. Open Questions

- [x] 项目命名：FastStudy-ChromePlugin（已确定）
- [x] 本地路径：F:\GooglePlugin\（Frank 指定）
- [x] GitHub repo：dingfeng901228-oss/FastStudy-ChromePlugin（Frank 创建）
- [ ] 是否需要 Chrome Web Store 发布？（MVP 先开发者模式本地测）
- [ ] 是否需要在 popup 显示"待同步：N"统计？