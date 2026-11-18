# Go-Antigravity 原生桌面

使用 PyQt6 Widgets，采用横向宽屏 Liquid Glass（液态玻璃）桌面界面，复用 Node.js 本地 API，包含四大专页工作区：工作台与增强、账户与配额、手机远程、运行日志。

从项目根目录双击 `Go-Antigravity.exe`，或运行 `Start-Go-Antigravity.cmd`。
普通启动需要 Python 3.10+ 和 Node.js 22+（含 npm）；脚本在 `.venv-qt` 安装固定 Python 依赖，并按后端锁文件安装 Node.js 依赖。优先使用可选 `easyag-node.exe`，否则使用系统 Node.js。首次安装依赖需要联网。
源码仓库不含 EXE；CMD 入口可直接使用。可选 EXE 由本目录 `build-launcher.ps1` 构建，只是带图标的启动入口，需保留完整项目目录。

预览模式：`Start-Go-Antigravity.cmd --demo`，仅使用合成数据。

开发与验证说明见 [FRONTEND.md](../FRONTEND.md)。

关闭窗口将退出自己启动的服务；复用服务保持运行。有未保存设置时提示确认。
手机浏览器界面与数据目录沿用原实现。旧 HTML 桌面前端已移除。
