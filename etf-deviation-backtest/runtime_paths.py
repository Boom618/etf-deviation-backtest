# -*- coding: utf-8 -*-
"""运行期路径解析：区分「源码运行」与「打包运行」两种形态。

源码运行：资源与缓存都在项目目录，行为和以前完全一致。
打包运行：web/ 等只读资源被 PyInstaller 解压到临时目录，缓存必须改写到
          用户数据目录，否则程序退出即丢失。

可用环境变量覆盖：
  ETF_DATA_DIR  可写数据目录（缓存、设置）
  ETF_WEB_DIR   静态资源目录
"""

import os
import sys

APP_DIR_NAME = "ETFDviation"


def is_frozen():
    return bool(getattr(sys, "frozen", False))


def project_dir():
    """源代码所在目录（打包后是 exe 所在目录，仅作兜底）。"""
    if is_frozen():
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def resource_dir():
    """只读资源根目录（web/ 位于其下）。"""
    if is_frozen():
        # onefile 模式下资源被解压到 _MEIPASS
        return getattr(sys, "_MEIPASS", project_dir())
    return os.path.dirname(os.path.abspath(__file__))


def web_dir():
    """静态资源目录（含 index.html）。"""
    env = os.environ.get("ETF_WEB_DIR")
    if env:
        return env
    return os.path.join(resource_dir(), "web")


def data_dir():
    """可写数据目录。打包后放系统标准位置，避免写进临时解压目录。"""
    env = os.environ.get("ETF_DATA_DIR")
    if env:
        path = env
    elif not is_frozen():
        path = os.path.dirname(os.path.abspath(__file__))
    elif sys.platform == "darwin":
        base = os.path.expanduser("~/Library/Application Support")
        path = os.path.join(base, APP_DIR_NAME)
    elif sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
        path = os.path.join(base, APP_DIR_NAME)
    else:
        base = os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")
        path = os.path.join(base, APP_DIR_NAME)

    try:
        os.makedirs(path, exist_ok=True)
    except OSError:
        pass
    return path
