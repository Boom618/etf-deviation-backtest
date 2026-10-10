@echo off
chcp 65001 > nul
title 偏离率回测系统
cd /d "%~dp0"

echo.
echo   ============================================
echo    偏离率回测系统
echo   ============================================
echo.

rem 优先用 python，找不到则用 py 启动器
set "PY="
where python > nul 2>nul && set "PY=python"
if "%PY%"=="" (
    where py > nul 2>nul && set "PY=py"
)

if "%PY%"=="" (
    echo   [错误] 未检测到 Python，请先安装 Python 3.8 或以上版本
    echo   下载地址： https://www.python.org/downloads/
    echo.
    pause
    exit /b 1
)

rem 二维码功能为可选依赖
"%PY%" -c "import segno" > nul 2>nul
if errorlevel 1 (
    echo   [提示] 未安装二维码库，桌面端将不显示二维码（不影响其他功能）
    echo          如需二维码： "%PY%" -m pip install segno
    echo.
)

echo   正在启动服务...
echo   启动后请用浏览器打开下方地址
echo.
%PY% -u server.py

echo.
echo   服务已停止
pause
