# XM AI Studio 云平台部署指南（完整版，AI 功能可用）

本项目需要一个 Node.js 后端（代理火山方舟 API），推荐 **Render**（免费、无需信用卡、5 分钟搞定）。
Railway / Fly.io / Zeabur 同理。

## 一、Render 部署（推荐）

### 1. 准备 Git 仓库
```bash
cd materALL-ai-studio
git init
# 重要：排除 node_modules，创建 .gitignore
echo "node_modules/" > .gitignore
git add .
git commit -m "XM AI Studio"
```
推到 GitHub / Gitee（新建一个仓库，按平台提示 push）。

### 2. Render 配置
打开 https://render.com 注册 → New → **Web Service** → 连接你的仓库：

| 配置项 | 填写 |
|---|---|
| Name | xm-ai-studio |
| Runtime | Node |
| Build Command | `npm install` |
| Start Command | `node server.js` |
| Instance Type | Free |

### 3. 环境变量（可选，推荐）
在 Render 的 Environment 中添加：
```
ARK_API_KEY = 你的火山方舟 API Key（sk-开头）
```
配置后所有访问者共用这个 Key（免填）；不配则每个用户在自己浏览器里填自己的 Key。

### 4. 部署
点 Create Web Service → 等 2-3 分钟 → 得到公网地址：
```
https://xm-ai-studio.onrender.com
```
把这个链接发给任何人（全球可访问），AI 生图/生视频/创意助手全部可用。

## 二、其他平台速查

| 平台 | 免费额度 | 要点 |
|---|---|---|
| Render | 750h/月 | 上文步骤 |
| Railway | 试用额度 | Start Command 同样 `node server.js` |
| Zeabur（国内友好） | 有免费额度 | 选 Node 服务，同样配置 |
| 腾讯云轻量服务器 | 约 ¥50/月起 | `node server.js` + pm2 守护 + nginx 反代 3000 端口 |

## 三、上线注意事项

1. **Key 安全**：ARK_API_KEY 配在平台环境变量里最安全（用户看不到）；用户前端填 Key 仅存各自浏览器
2. **免费版会休眠**：Render 免费版 15 分钟无访问会休眠，首次访问需等 ~30s 唤醒；介意可升级或选付费档
3. **剪辑引擎**：智能剪辑/包框合成在**访问者浏览器**里跑（ffmpeg.wasm），不占服务器资源——服务端只代理 AI API，免费额度完全够用
4. **COOP/COEP 头**：server.js 已配置（ffmpeg.wasm 需要），各平台均可正常工作
