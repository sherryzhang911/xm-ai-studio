# 通用 Node 部署镜像（Render / Hugging Face Spaces / Koyeb / Back4app 均可用）
FROM node:20-slim

WORKDIR /app

# 先装依赖（利用层缓存）
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# 再拷贝源码（含 public 静态资源与 ffmpeg-core.wasm）
COPY . .

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
