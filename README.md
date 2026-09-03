# XM AI Studio — AI 创作平台

> 以「低门槛 · 高效率 · 强智能」为核心，整合 **AI 生图 · AI 生视频 · 智能剪辑 · AI 创意辅助**，覆盖 UA 素材生产、快速验证创意、创意设计辅助全场景，实现 **"思考-创作-剪辑-输出"全流程智能化**，内置**流水线生产（小龙虾自动化模式）**：一句话创意 → 自动成片。

![架构](https://img.shields.io/badge/架构-五层设计-6c5ce7) ![API](https://img.shields.io/badge/API-火山方舟Ark-4f7cff) ![剪辑](https://img.shields.io/badge/剪辑-ffmpeg.wasm本地合成-22d3ee)

---

## ✨ 核心能力

| 模块 | 能力 | 技术实现 |
|---|---|---|
| 🧠 AI 创意助手 | 脚本策划 / 分镜拆解 / 提示词优化 / 文案字幕 | 豆包大模型（chat completions），产出可一键流转 |
| 🖼️ AI 生图 | 文生图 / 图生图 / 多图参考 / 4K | 火山方舟 Seedream（doubao-seedream 系列） |
| 🎬 AI 生视频 | 文生视频 / 图生视频（首帧）/ 同步音频 | 火山方舟 Seedance（doubao-seedance 系列） |
| 📋 故事板 Storyboard | 可视化剧本 / 场景编排 / 拖拽排序 / 批量生成 | 本地持久化 + 批量任务队列 |
| 🏭 流水线生产 | **小龙虾自动化**：创意→拆解分镜→批量生图→批量生视频→自动成片 | AI 拆解 + 批量并发 + 自动轮询 |
| ✂️ 智能剪辑 | 时间线 / 转场（淡入淡出）/ 文字卡 / BGM / 变速 / 导出 MP4 | ffmpeg.wasm（浏览器本地合成，零成本） |
| 🗂️ 作品中心 | 图片 / 视频 / 成片统一管理，随时复用流转 | IndexedDB 本地持久化 |

**技术架构（五层）**：前端交互层（轻量化操作界面、功能分区、参数自定义面板、作品管理中心、故事板）→ 核心能力引擎层（生图/生视频/对话/剪辑）→ 数据算法层（火山方舟模型）→ 资源素材层（TOS 素材 / 本地素材 / 文字卡）→ 安全管控层（Key 仅在本地服务持有，前端不暴露）。

---

## 🚀 快速开始

### 1. 准备环境

- [Node.js](https://nodejs.org) 18+（推荐 20/22）

### 2. 获取火山方舟 API Key

1. 注册/登录 [火山引擎](https://www.volcengine.com/) 并实名认证
2. 进入 [火山方舟 → API Key 管理](https://console.volcengine.com/ark/region:ark+cn-beijing/apikey)，创建 API Key
3. 在 [模型广场](https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement) 开通以下模型服务：
   - **生图**：Doubao-Seedream（4.0 / 5.0 任一）
   - **生视频**：Doubao-Seedance（1.5 / 2.0 / 2.5 任一）
   - **对话**：豆包通用模型（doubao-seed-evolving / doubao-seed-2-1 系列等）
   > 各模型通常有免费额度（如 Seedream 4.5 有 200 次免费调用）

### 3. 启动平台

```bash
cd materALL-ai-studio
npm install

# 方式 A：写入环境变量（推荐）
# 复制 .env.example 为 .env，填入 ARK_API_KEY 后：
npm start

# 方式 B：不配置环境变量，启动后在前端左下角「连接设置」中填写 API Key
```

浏览器打开 **http://localhost:3000** 即可开始创作。

---

## 🎯 推荐工作流

### 工作流一：创意 → 成片（全自动，小龙虾模式）

1. 进入 **流水线生产**
2. 输入一句话创意（如：*一条 15 秒的夏日冰饮种草视频…*）
3. 点击「🚀 启动流水线」——AI 自动拆解分镜 → 批量生图 → 批量生视频 → 就绪后点「打开智能剪辑」→ 导出成片 🎉

### 工作流二：手动精细控制

1. **创意助手**：策划脚本 / 生成分镜 JSON → 一键「发往故事板」
2. **故事板**：完善每个场景的画面描述 → 「批量生图」→「批量生视频」
3. **智能剪辑**：拖入成片片段、加文字卡（片头/片尾）、上传 BGM → 导出 MP4

### 工作流三：素材流转

- AI 生图 →「🎬 生视频」（设为首帧）→ 图生视频 →「✂️ 剪辑」→ 成片
- 作品中心统一管理，随时复用

---

## ⚙️ API 配置说明

| 项 | 说明 |
|---|---|
| `ARK_API_KEY` | 环境变量（`.env` 文件），或前端「连接设置」填写（前端 Key 优先） |
| `PORT` | 服务端口，默认 3000 |

所有方舟请求经本地后端代理（`server.js`）转发，**API Key 不暴露给浏览器外的任何第三方**。

### 对接的火山方舟接口

| 接口 | 端点 |
|---|---|
| 生图 | `POST /api/v3/images/generations`（Seedream） |
| 创建视频任务 | `POST /api/v3/contents/generations/tasks`（Seedance） |
| 查询视频任务 | `GET /api/v3/contents/generations/tasks/{id}` |
| 对话 | `POST /api/v3/chat/completions`（豆包） |

---

## 🧩 项目结构

```
materALL-ai-studio/
├── server.js            # Express 后端：静态托管 + 方舟 API 代理 + 素材下载代理
├── .env.example         # 环境变量模板
├── package.json
├── public/
│   ├── index.html       # 应用骨架（SPA）
│   ├── css/style.css    # 设计系统（深色 AI 创作风格）
│   ├── vendor/ffmpeg/   # 内置剪辑引擎（ffmpeg.wasm，本地加载无需外网）
│   └── js/
│       ├── app.js       # 主控：导航 / 事件分发 / 设置 / 状态
│       ├── api.js       # 后端 API 封装
│       ├── store.js     # 作品中心（IndexedDB）
│       ├── ui.js        # 组件库（toast / modal / 图标 / markdown）
│       ├── chat.js      # AI 创意助手
│       ├── image.js     # AI 生图
│       ├── video.js     # AI 生视频（任务轮询）
│       ├── storyboard.js# 故事板
│       ├── pipeline.js  # 流水线生产（小龙虾模式）
│       ├── editor.js    # 智能剪辑（ffmpeg.wasm）
│       └── gallery.js   # 作品中心
```

---

## 💡 常见问题

**Q：点击生成提示 API Key 错误？**
A：先在左下角「连接设置」填写 Key 并检测；确认已在模型广场开通对应模型。

**Q：视频生成很慢？**
A：Seedance 为云端异步生成，1-5 分钟属正常；可选用 Seedance 1.0 Fast 模型提速。

**Q：智能剪辑首次导出较慢？**
A：剪辑引擎（ffmpeg.wasm 约 25MB）已**内置在项目本地**（`public/vendor/ffmpeg/`），加载快且不受外网影响；剪辑在浏览器本地完成，不产生云端费用。建议 720P 导出。

**Q：本地图片做图生视频失败？**
A：方舟需要公网可访问的图片 URL。推荐：先用「AI 生图」生成图片（自带公网 URL），再流转为图生视频；或用图床/对象存储上传后使用公网链接。

**Q：剪辑时 BGM 与画面声音混音？**
A：支持。片段原声会保留，BGM 以可调音量混入（默认 35%）。

---

## 🔒 安全说明

- API Key 仅存储在本机浏览器 localStorage，并经本机后端转发，不向第三方暴露
- 作品数据（图片 URL / 视频 URL / 时间线）全部保存在浏览器本地（IndexedDB / localStorage）
- 本工具仅调用火山方舟官方 API，请在模型服务条款允许范围内使用生成内容
