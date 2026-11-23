#!/usr/bin/env bash
# ETF 偏离率回测 — macOS 应用打包
#
# 必须在一台 macOS 机器上运行（PyInstaller 不能跨平台交叉编译）：
#   chmod +x build_macos.sh && ./build_macos.sh
#
# 产物：
#   dist/ETF回测工具.app    可直接拖进「应用程序」
#   dist/ETF回测工具.dmg    分发给别人用

set -euo pipefail
cd "$(dirname "$0")"

PY="${PYTHON:-python3}"

echo
echo "=============================================="
echo "  ETF 偏离率回测  macOS 打包"
echo "=============================================="
echo

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[错误] 这个脚本只能在 macOS 上运行。"
  echo "       Windows 上无法生成 .app，请改用 GitHub Actions 或在一台 Mac 上执行。"
  exit 1
fi

"$PY" -c "import sys; print('使用 Python', sys.version.split()[0])"

echo
echo "[1/4] 安装打包依赖..."
"$PY" -m pip install --disable-pip-version-check -q --upgrade pyinstaller pywebview

echo "[2/4] 生成 .icns 图标..."
rm -rf desktop/icon.iconset desktop/icon.icns
mkdir -p desktop/icon.iconset
for s in 16 32 64 128 256 512; do
  sips -z "$s" "$s" web/icon-512.png --out "desktop/icon.iconset/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  sips -z "$d" "$d" web/icon-512.png --out "desktop/icon.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns desktop/icon.iconset -o desktop/icon.icns
rm -rf desktop/icon.iconset

echo "[3/4] 打包 .app（约 1-3 分钟）..."
rm -rf build dist
"$PY" -m PyInstaller --noconfirm --clean --windowed \
  --name "ETF回测工具" \
  --icon "desktop/icon.icns" \
  --add-data "web:web" \
  --osx-bundle-identifier "com.boom618.etfdesktop" \
  --exclude-module tkinter \
  --exclude-module PyQt5 --exclude-module PyQt6 --exclude-module PySide6 \
  --exclude-module matplotlib --exclude-module numpy --exclude-module pandas \
  desktop.py

echo "[4/4] 生成 dmg..."
rm -f "dist/ETF回测工具.dmg"
hdiutil create -quiet -volname "ETF回测工具" \
  -srcfolder "dist/ETF回测工具.app" \
  -ov -format UDZO "dist/ETF回测工具.dmg"

echo
echo "=============================================="
echo "  完成"
echo "  App: $PWD/dist/ETF回测工具.app"
echo "  DMG: $PWD/dist/ETF回测工具.dmg"
echo
echo "  首次打开若提示「已损坏/无法验证开发者」，执行："
echo "    xattr -cr \"$PWD/dist/ETF回测工具.app\""
echo "=============================================="
