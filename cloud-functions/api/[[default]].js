// EdgeOne Pages Node 函数入口（框架模式）
// 所有 /api/* 请求交给项目根目录的 Express 应用（server.js）处理
// 部署时需在 EdgeOne 项目环境变量中设置 EO_FUNCTIONS=1，并配置 ARK_API_KEY / BILI_API_KEY / ACCESS_CODE
import app from '../../server.js';

export default app;
