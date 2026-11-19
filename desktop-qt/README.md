# Go-Antigravity 原生桌面

使用 PyQt6 Widgets，采用横向宽屏 Liquid Glass（液态玻璃）桌面界面，复用 Node.js 本地 API，包含四大专页工作区：工作台与增强、账户与配额、手机远程、运行日志。

从项目根目录双击 `Go-Antigravity.exe`，或运行 `Start-Go-Antigravity.cmd`。
源码模式需要 Python 3.10+ 和 Node.js 22.13+（含 npm）；脚本在 `.venv-qt` 安装固定 Python 依赖，并按后端锁文件安装 Node.js 依赖。仅使用 `PATH` 上的系统 Node.js，不启动旧版 Node 运行时。首次安装依赖需要联网。
GitHub Windows 包由 `scripts/package-windows.ps1` 生成，内含带图标的 `Go-Antigravity.exe`、Node、Python/PyQt 和后端生产依赖，运行时不执行 npm/pip。只用 `build-launcher.ps1` 构建的 EXE 仍只是开发目录启动入口，不能代替发布包。

预览模式：`Start-Go-Antigravity.cmd --demo`，仅使用合成数据。

开发与验证说明见 [FRONTEND.md](../FRONTEND.md)。

关闭窗口将退出自己启动的服务；复用服务保持运行。有未保存设置时提示确认。
手机浏览器由本项目的本机服务提供，使用独立版数据目录。旧 HTML 桌面前端已移除。
