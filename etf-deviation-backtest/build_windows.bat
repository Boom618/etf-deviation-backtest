@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem 用法：build_windows.bat [python 可执行文件路径]
rem   不传参数则用 PATH 里的 python
set "PY=%~1"
if "%PY%"=="" set "PY=python"

title 打包 ETF 回测工具 - Windows 绿色版

echo.
echo ==============================================
echo   ETF 偏离率回测  Windows 绿色版打包
echo ==============================================
echo.

"%PY%" -c "import sys; print('使用 Python', sys.version.split()[0]); print(sys.executable)" || goto :nopy

echo.
echo [1/3] 安装打包依赖（pyinstaller / pywebview）...
"%PY%" -m pip install --disable-pip-version-check -q pyinstaller pywebview || goto :fail

echo [2/3] 清理旧产物...
if exist build rmdir /s /q build
if exist "dist\ETF回测工具.exe" del /q "dist\ETF回测工具.exe"

echo [3/3] 开始打包，约 1-3 分钟...
"%PY%" -m PyInstaller --noconfirm --clean --onefile --windowed ^
  --name "ETF回测工具" ^
  --icon "desktop\icon.ico" ^
  --add-data "web;web" ^
  --exclude-module tkinter ^
  --exclude-module PyQt5 ^
  --exclude-module PyQt6 ^
  --exclude-module PySide6 ^
  --exclude-module matplotlib ^
  --exclude-module numpy ^
  --exclude-module pandas ^
  desktop.py
if errorlevel 1 goto :fail

echo.
echo ==============================================
echo   打包完成
echo   产物：%CD%\dist\ETF回测工具.exe
echo   单文件、免安装，拷到任意 Windows 电脑双击即可
echo ==============================================
echo.
pause
exit /b 0

:nopy
echo.
echo [错误] 找不到可用的 Python。请先安装 Python 3.10+，
echo        或把 python.exe 的完整路径作为参数传入。
echo.
pause
exit /b 1

:fail
echo.
echo [错误] 打包失败，请查看上方 PyInstaller 输出。
echo.
pause
exit /b 1
