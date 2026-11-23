# -*- coding: utf-8 -*-
"""桌面版入口：本机起 HTTP 服务，用系统自带 WebView 开原生窗口。

源码运行：python desktop.py
    （需要 pip install pywebview，没装则自动回退默认浏览器）

打包产物：build_windows.bat / build_macos.sh

环境变量（可选）：
    ETF_HOST       监听地址，默认 0.0.0.0（手机可扫码访问）
    ETF_PORT       期望端口，默认 8770，被占用时自动换空闲端口
    ETF_NO_WINDOW  设为 1 则强制用默认浏览器打开
"""

import json
import os
import socket
import sys
import threading
import time
import traceback
import urllib.request
import webbrowser

import runtime_paths

APP_TITLE = "ETF 偏离率回测"
PREFERRED_PORT = 8770


def _redirect_stdio():
    """windowed 打包后没有控制台，print / traceback 的输出会丢失。

    统一写到数据目录下的日志，既能避免 None 写入报错，也方便用户回传排错。
    """
    if not runtime_paths.is_frozen() and sys.stdout is not None and sys.stderr is not None:
        return
    try:
        path = os.path.join(runtime_paths.data_dir(), "desktop.log")
        fp = open(path, "a", encoding="utf-8", buffering=1)
    except OSError:
        return
    if sys.stdout is None or runtime_paths.is_frozen():
        sys.stdout = fp
    if sys.stderr is None or runtime_paths.is_frozen():
        sys.stderr = fp


def _detect_running(port):
    """端口上已经有本程序的实例时，返回它的地址。

    用 /api/info 的响应结构判断，避免把别的程序误认成自己。
    """
    url = "http://127.0.0.1:%d/api/info" % port
    try:
        with urllib.request.urlopen(url, timeout=1.2) as r:
            data = json.loads(r.read().decode("utf-8"))
        if isinstance(data, dict) and data.get("ok") and "local_url" in data:
            return data.get("local_url") or ("http://127.0.0.1:%d/" % port)
    except Exception:
        pass
    return None


def _activate_existing():
    """把已在运行的窗口提到前台。Windows 之外返回 False。"""
    if sys.platform != "win32":
        return False
    try:
        import ctypes
        user32 = ctypes.windll.user32
        hwnd = user32.FindWindowW(None, APP_TITLE)
        if not hwnd:
            return False
        user32.ShowWindow(hwnd, 9)          # SW_RESTORE：最小化也能还原
        user32.SetForegroundWindow(hwnd)
        return True
    except Exception:
        return False


def _start_server(host, wanted_port):
    """起服务。端口被占用就交给系统分配，避免"双击没反应"。"""
    import server

    last_err = None
    for candidate in (wanted_port, 0):
        try:
            srv = server.create_server(host, candidate)
        except OSError as e:
            last_err = e
            continue
        port = srv.server_address[1]
        # api_info / api_qr 读的就是这两个变量，必须写回真实值
        os.environ["PORT"] = str(port)
        os.environ["HOST"] = host
        threading.Thread(target=srv.serve_forever, name="http-server",
                         daemon=True).start()
        return srv, port
    raise RuntimeError("无法启动本机服务：%s" % last_err)


def _wait_ready(url, timeout=20.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1.5) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.15)
    return False


def _run_window(url):
    """返回 True 表示窗口正常跑完（用户关闭）；False 表示环境不支持。"""
    try:
        import webview
    except Exception:
        traceback.print_exc()
        return False

    try:
        webview.create_window(APP_TITLE, url, width=1280, height=880,
                              min_size=(960, 620), text_select=True)
        webview.start()
        return True
    except Exception:
        traceback.print_exc()
        return False


def _hold():
    """浏览器模式没有窗口生命周期，需要把进程挂住提供服务。"""
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass


def main():
    _redirect_stdio()

    host = os.environ.get("ETF_HOST", "0.0.0.0")
    try:
        wanted = int(os.environ.get("ETF_PORT", str(PREFERRED_PORT)))
    except ValueError:
        wanted = PREFERRED_PORT

    # 已经在跑就直接把窗口调到前台，不再起第二个实例
    # （两个实例共用 WebView2 的用户数据目录会互相卡死）
    existing = _detect_running(wanted)
    if existing:
        print("[desktop] already running: %s" % existing)
        if not _activate_existing():
            webbrowser.open(existing)
        return

    srv, port = _start_server(host, wanted)
    url = "http://127.0.0.1:%d/" % port
    _wait_ready(url)

    print("[desktop] serving %s (host=%s, port=%d)" % (url, host, port))

    try:
        if os.environ.get("ETF_NO_WINDOW") == "1":
            webbrowser.open(url)
            _hold()
        elif _run_window(url):
            pass                    # 窗口关闭，直接退出
        else:
            # WebView2 未安装 / 无图形环境时退回浏览器，功能不受影响
            print("[desktop] native window unavailable, falling back to browser")
            webbrowser.open(url)
            _hold()
    finally:
        try:
            srv.shutdown()
        except Exception:
            pass


if __name__ == "__main__":
    main()
