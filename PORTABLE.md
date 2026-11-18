# Go-Antigravity 运行与数据说明

## 运行环境

源码分发需 Python 3.10+、Node.js 22+（含 npm）。运行 `Start-Go-Antigravity.cmd`，脚本按锁定清单准备 Python 和后端依赖；首次安装需要联网。从 `PATH` 使用已安装的 `node.exe`，不会选用旧式便携运行时 `easyag-node.exe`。

GitHub 发布包由 `scripts/package-windows.ps1` 生成，目录包含 `Go-Antigravity.exe`、应用源文件、生产 `node_modules`、`runtime/node/node.exe` 和 `runtime/python/`。发布包不需要用户安装 Python、Node.js 或执行 npm/pip；`runtime/manifest.json` 记录构建提交和运行时版本。这个包仍然是目录型发布，不是单文件 EXE。不要把开发目录中的 `.venv-qt`、`backend/node_modules` 或用户数据直接复制到发布包。

只构建入口时，`desktop-qt/build-launcher.ps1` 仍可生成一个仅调用同目录启动脚本的 EXE。它需要完整源码树和开发机运行时，不能代替发布包。

## 服务与退出

桌面仅复用由 `node.exe` 启动、指向本检出目录的后端脚本，且在本地状态接口核对发布协议及数据目录一致后才连接。发现同目录的不兼容服务会提示关闭旧后端后重试，不自动终止进程，也不另起进程争用数据。没有同目录后端时自行启动 `backend/server.js`。

关闭窗口时，自己启动的后端会按协议退出，托管手机服务和隧道随之停止；复用的服务不会被终止。有未保存设置时提示确认。当前原生界面不提供托盘保活。

## 数据与备份

源码模式默认只使用项目根目录的 `.go-antigravity-data/`。发布包模式默认使用 `%LOCALAPPDATA%\Go-Antigravity`，避免向可能只读的安装目录写入。两种模式都可用 `GO_ANTIGRAVITY_DATA_DIR` 指向专用目录；相对值从项目根目录解析。不要让不同检出目录同时使用同一个数据目录，也不要指向旧版账户库。独立版使用 Windows 凭据管理器中的 `go-antigravity:accounts-key`。不会读取或迁移旧 `EASYAG_DATA_DIR`、旧应用目录或 `easyag:accounts-key`；首次使用时按需重新设置，不需要删除原数据。

账户自动备份只在解析修复、格式迁移等需要覆盖原文件前创建，保留最近 5 份。备份失败会中止恢复写入，不覆盖原文；普通启动与配额刷新不会每次额外创建备份。备份可能含敏感数据，应按真实账户文件保护。

内核原始 `.bak` 是恢复依据，体积可能较大，不应当作垃圾删除。自定义提示词只替换三个核心指令槽（4088B，其中 128B 为自描述头，用户文本上限 3960 UTF-8 字节），身份、工具声明、辅助模板和 `applyEdits` 旁路仍以原始备份为准；恢复默认或显式 `clearCustomPrompt` 会清除本机已保存文本。上下文配置恢复记录保留原配置文本与本工具写入状态，以恢复原字段并保留其他内容；其中可能含本机配置，应按敏感文件保护。正常重复设置不会按时间无限新增记录。日志使用当前文件及轮转文件 `.previous`。维护脚本 `backend/scripts/scrub-secrets.cjs` 默认只扫描本版数据目录，添加 `--write` 才改写。

自定义提示词全文保存在本机设置文件的 `customSystemPrompt`（附 `customPromptUpdatedAt`），仅用于自定义档应用与启动前按 `customHash` 校对漂移；该文件可能包含敏感内容，应按账户/凭据备份同等保护，不要公开分享或随源码上传。状态、配置保存回包及 `/api/kernel/status` 只返回 `kernel.customPrompt` 元数据（`available` / `bytes` / `hash` / `updatedAt` / `capacity`），不回显全文；没有读取全文的 GET 接口，Qt 只保留本地草稿。API 请求体上限 64 KiB，编辑器不会静默截断超额文本。

新原子写入临时文件与 Qt 启动目录带所有者信息，只回收可确定属于本项目、已超过安全期限且所有者退出的残留。新近文件、活跃进程文件、其他项目文件及无法确定所有者的旧格式临时文件保留，避免误删。异常断电后不保证立即零残留。旧文件需在停服、确认归属并备份后人工处理。

`__pycache__/`、测试输出和旧 `_attic/` 是开发产物；`.venv-qt/` 和 `backend/node_modules/` 是开发环境依赖。Git 已排除相应本机产物，上传前仍应检查 `git status` 和实际提交内容。发布包只上传 `dist/Go-Antigravity-windows-x64.zip`，不要直接压缩整个开发目录。

当前桌面不提供账户导出按钮。后端脱敏导出不能恢复账户，完整令牌导出需要明确确认；不要将完整备份、日志或隧道凭据公开分享。

## 手机与验证

手机远程另需安装 `cloudflared`，配置方法见 [MOBILE-ACCESS.md](MOBILE-ACCESS.md)。

`Start-Go-Antigravity.cmd --demo` 仅展示合成数据，不访问真实后端。开发检查命令见 [FRONTEND.md](FRONTEND.md)。
