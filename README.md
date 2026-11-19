# Go-Antigravity

Go-Antigravity 是独立维护的 Windows 桌面工具。Python / PyQt6 提供原生界面，Node.js 后端随源码在本机启动，无需连接旧运行时或更新服务。引用和改编的材料仍按 [第三方声明](backend/THIRD-PARTY-NOTICES.md) 保留来源及许可信息。

## 以后从哪里继续

唯一的开发源目录是当前项目根目录：`C:\Users\97218\tools\Go-Antigravity-public`。以后修改功能、界面、内核补丁或发布流程，都在这里编辑并提交；不要在 `dist/`、`runtime/`、`.venv-qt/`、`backend/node_modules/` 或发布包解压目录里改代码。

先看 [DEVELOPMENT.md](DEVELOPMENT.md) 了解目录分工和日常命令。根目录的 `Go-Antigravity.exe` 只是由 `desktop-qt/build-launcher.ps1` 生成的启动入口，真正的功能代码在 `desktop-qt/` 和 `backend/`。

## 从源码启动

安装 **Python 3.10 或以上**，以及 **Node.js 22.13 或以上（含 npm）**，然后在项目根目录运行：

~~~bat
Start-Go-Antigravity.cmd
~~~

启动脚本会在项目内建立 `.venv-qt`，并按 `desktop-qt/requirements.txt` 安装固定版本依赖；后端依赖按 `backend/package-lock.json` 安装。首次准备环境需要联网，安装失败会停止并显示原因。已经准备好的环境会复用。Python 虚拟环境不能直接跨电脑搬运。

启动脚本使用 `PATH` 上安装的 Node.js，不查找或启动旧式便携运行时。源码不包含 EXE、虚拟环境或 `node_modules`。账户、设置和日志默认写入项目根目录的 `.go-antigravity-data/`；不会自动读取或迁移旧版账户、配置或加密密钥。

预览界面可运行 `Start-Go-Antigravity.cmd --demo`，只使用合成数据，不连接真实账户或服务。仍需安装 Python 与界面依赖。

## 界面与功能

横向桌面包含「概览」「账户」「远程」「日志」四个页面，提供深色与浅色主题，默认窗口 `1120×640`，最小 `940×580`。

- 概览：代理端口与连接诊断、中文界面、会话统计、两档系统提示词（官方原版 / 精简·防编造）和上下文窗口。
- 账户：授权添加、读取本地客户端账户、搜索排序、切换、模型与周窗口配额、导入账户 / 令牌、重新授权。
- 远程：随机公网隧道或固定域名、Tunnel Token 本机加密保存、二维码、临时 PIN 和服务控制。
- 日志：文本筛选、复制、清屏和敏感内容遮盖。

系统提示词只有「官方原版」「精简·防编造」两个常规选择，出厂默认是「精简·防编造」（`promptTier='3'`）：沿用既有 v2 精简载荷，强调先读取再断言、按实际工具契约操作、失败后核实状态、完成验证后再汇报，但不保证消除模型幻觉。`4`（原均衡档）及旧 `1` / `2` 仍可识别与恢复，不在界面自动勾选；仅改上下文或启动同步不会顺带迁移旧提示词。旧版「自定义上传」档已移除：界面不再提供入口，曾被打过该档的内核仍会被识别为「旧自定义」，可用「恢复官方内核」还原。

「精简·防编造」只重写 `guidelines.tmpl`、`function_call.tmpl`、`communication_style.tmpl` 三个核心指令模板（槽位共 4088B，v2 载荷约 2114B，其余以空注释填充），保留 `identity.tmpl`、工具声明、全部辅助模板和 `applyEdits` 旁路。首次修改内核时创建一次原始 `.bak` 并启用 NTFS 压缩（`compact.exe`，本机实测 194 MB → 约 109 MB，约 1.8:1），之后复用同一份备份；补丁失败时按变更区间把原始字节写回，不再复制整份镜像，只有区间写回本身失败时才额外留下一份显式的恢复快照（`.goagy-*.tmp`），可直接拷回。请按敏感文件保护备份目录。

上下文键保持 `stock` / `512k` / `900k`，界面显示「官方原版 / 512K / 900K / 1M」。当前所有受支持模型都实际支持 1M 上下文；本工具设置的本地客户端上限是 512000 或 983040 tokens。既有字节签名与上下文配置的事务/恢复机制不变。

客户端输入区只显示小圆环与百分比，悬停或点击展开关键统计：估算上下文、模型、本对话输入／输出 Token，以及有有效样本时的平均 TTFT 和 TPS。不可用的统计行自动隐藏，不展示系统／工具拆分、缓存与时长占位项。Token 为当前对话的宿主累计口径，不与当前上下文或全账户用量混同。

当前桌面账户工具栏不提供导出按钮。后端保留受本机会话保护的导出接口；脱敏资料不能恢复账户，包含完整令牌的备份不可公开分享。

内核修改需确认，首次修改会保留原始二进制备份；上下文配置按事务更新并记录原字段值，以便恢复。切换账户前请先保存工作并退出 Antigravity；运行状态无法确认或客户端仍在运行时会取消切换。切换成功后，下次启动客户端时生效。修改 Python 后重新启动桌面；修改后端后需重启实际使用的服务，仅重新打开桌面不会重启复用的服务。

关闭窗口会退出本次启动的后端及其托管手机服务；复用的外部服务保持运行。当前没有托盘保活。PIN 默认遮盖，离开「远程」页或窗口失焦会重新遮盖。手机使用与配置见 [MOBILE-ACCESS.md](MOBILE-ACCESS.md)。

## 不开 TUN 时的代理

概览页填写本地 HTTP 代理或支持 HTTP CONNECT 的 mixed 端口即可。工具自身的授权码兑换、Token 刷新、用户信息、配额和代理预检使用该端口，无需 TUN；单独 SOCKS 端口不支持。显式代理不会被继承的 `NO_PROXY` 绕过，配置了代理但缺少 `curl.exe` 时会报错并停止请求。

通过本工具新启动 Antigravity 时会传入代理启动参数和环境变量；已经运行的客户端不会被补注入，需使用原有代理配置或退出后重新启动。Antigravity 原生子进程是否遵守代理由其自身实现决定；系统默认授权浏览器遵守浏览器／系统设置，cloudflared 的公网连接也不在上述显式代理保证内。本地回环接口保持直连。预检成功不能证明真实账户的地区资格或所有客户端流量可用。

## Windows EXE 发布包

源码树中的 `Go-Antigravity.exe` 是带图标的原生入口。要生成可放到 GitHub Releases 的 Windows x64 包，在项目根目录执行：

~~~powershell
npm --prefix backend ci
python -m venv .venv-qt
.\.venv-qt\Scripts\python.exe -m pip install -r desktop-qt/requirements.txt
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-windows.ps1 -Clean
~~~

脚本会在 `dist/Go-Antigravity-windows-x64/` 生成 `Go-Antigravity.exe`、后端、桌面文件、锁定的 `node_modules`、Node.js 运行时和可搬运的 Python/PyQt 运行时，并同时生成同名 ZIP。发布包运行时不执行 npm/pip，也不需要用户另外安装 Python 或 Node.js；首次使用时仍需要用户本机已有的 Antigravity 安装，内核补丁会在本地应用到该安装。

这是一个“目录型 EXE 包”，不是把所有运行时压成单个二进制文件。运行时版本、构建提交和发布目录结构写入 `runtime/manifest.json`；Python、Qt、Node 及后端依赖的许可文件随包保留。包内账户、设置和日志默认写入 `%LOCALAPPDATA%\Go-Antigravity`，不会写进发布目录。

仅需构建带图标的入口时，仍可单独运行：

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File desktop-qt/build-launcher.ps1
~~~

## 开发与发布

界面结构和验证命令见 [FRONTEND.md](FRONTEND.md)，服务、数据、备份与清理边界见 [PORTABLE.md](PORTABLE.md)。后端可在 `backend/` 中执行 `npm ci` 和 `npm run verify`。

本项目没有在线自更新，旧 `runtime/current` 覆盖层不会替换当前源码。Google Antigravity 的官方联网依赖，以及启用手机公网远程时可选的 Cloudflare Tunnel，是独立于旧发布方的服务；仅预览界面可用 `--demo`。本源码树来自核准文件清单，使用独立 Git 历史，不继承原开发仓库的提交、标签和远程配置。源码发布步骤和 Windows 包发布步骤见 [RELEASE.md](RELEASE.md)；不要上传整个开发目录。

项目许可证见 [LICENSE](LICENSE)。第三方来源、依赖许可和公开分发前尚待核实的内核补丁授权，统一见 [第三方声明](backend/THIRD-PARTY-NOTICES.md)。
