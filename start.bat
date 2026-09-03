@echo off
chcp 65001 >nul
title XM AI Studio
cd /d %~dp0
echo ============================================
echo   XM AI Studio 启动中...
echo   启动后浏览器访问: http://localhost:3000
echo   关闭本窗口即停止服务
echo ============================================
node server.js
pause
