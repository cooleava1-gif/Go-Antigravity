# Go-Antigravity 运行与数据说明

## 运行环境

源码分发需 Python 3.10+、Node.js 22.13+（含 npm）。运行 `Start-Go-Antigravity.cmd`，脚本按锁定清单准备 Python 和后端依赖；首次安装需要联网。从 `PATH` 使用已安装的 `node.exe`，不会选用旧式便携运行时。

GitHub 发布包由 `scripts/package-windows.ps1` 生成目录与 ZIP，再由 `scripts/build-portable-exe.ps1` 追加成单个自解压 `dist/Go-Antigravity-windows-x64.exe`：目录包含 `Go-Antigravity.exe`、应用源文件、生产 `node_modules`、`runtime/node/node.exe` 和 `runtime/python/`。发布包不需要用户安装 Python、Node.js 或执行 npm/pip。EXE 只是把同一份目录解压到自身旁边再启动，安装结果仍是目录型布局，不是把所有运行时压成一个二进制。不要把开发目录中的 `.venv-qt`、`backend/node_modules` 或用户数据直接复制到发布包。

`runtime/manifest.json` 记录构建提交、运行时版本和交付源码指纹，其中的 `update` 块记录更新通道与发布资产名（`cooleava1-gif/Go-Antigravity`、`stable`、`Go-Antigravity-windows-x64.exe`），便于人工核对更新来源。`git.commit` 是完整提交号；`git.dirty` 为真表示打包时已交付源码相对该提交有未提交改动，`git.dirtyFiles` 按项目相对路径列出这些文件；未交付的审查产物、测试、依赖或本机数据变化不计入，因此 `dirty` 为假不代表整个 Git 工作树干净。`source.fingerprint` 是对全部交付源码（`backend/` 与 `desktop-qt/` 的应用源、静态资源和配置，不含 `node_modules`、`runtime/` 与构建出的启动器；打包根部的 `THIRD-PARTY-NOTICES.md` 与 `backend/THIRD-PARTY-NOTICES.md` 按各自路径分别计入，源树中前者内容取自后者）计算的 SHA-256，`source.fileCount`、`source.files` 和 `source.bytes` 描述同一份清单。构建会在复制完成后重算源码指纹并与暂存目录比对，不一致即失败，因此该指纹可以说明拿到的包与所记录的构建是否同源。记录 `dirty` 只说明这个包来自未提交的工作树，不代表能按某个纯提交重现；需要可重现构建时应先提交并清理工作树再打包。

在源码检出里复制或解包后，可运行 `scripts/verify-package-source.ps1 -PackagePath <目录或ZIP>` 重算源码指纹并与 `runtime/manifest.json` 比对，任何文件增删或内容改动都会让校验不一致；只拿到发布包时，可按 `source.files` 清单逐项核对。

只构建入口时，`desktop-qt/build-launcher.ps1` 仍可生成一个仅调用同目录启动脚本的 EXE。它需要完整源码树和开发机运行时，不能代替发布包。

## 服务与退出

桌面仅复用由 `node.exe` 启动、指向本检出目录的后端脚本，且在本地状态接口核对发布协议及数据目录一致后才连接。发现同目录的不兼容服务会提示关闭旧后端后重试，不自动终止进程，也不另起进程争用数据。没有同目录后端时自行启动 `backend/server.js`。

点击窗口关闭按钮默认隐藏到系统托盘，自己启动的后端、托管手机服务和隧道继续运行。双击托盘图标或右键选择“显示主窗口”可恢复；右键选择“退出”才会按协议关闭本次启动的服务，复用的服务不会被终止。真正退出时有未保存设置仍提示确认，取消后继续运行。系统托盘不可用时回退为正常退出；“重启更新”仍走显式退出流程。

## 数据与备份

源码模式默认只使用项目根目录的 `.go-antigravity-data/`。发布包模式默认使用 `%LOCALAPPDATA%\Go-Antigravity`，避免向可能只读的安装目录写入。两种模式都可用 `GO_ANTIGRAVITY_DATA_DIR` 指向专用目录；相对值从项目根目录解析。不要让不同检出目录同时使用同一个数据目录，也不要指向旧版账户库。发布包的在线更新沿用同一个数据目录：更新重启后仍使用 `GO_ANTIGRAVITY_DATA_DIR` 或 `--data-dir` 指定的目录，账户、设置和日志不会被删除或迁移；安装目录本身不能同时作为数据目录，否则安装会被拒绝。独立版使用 Windows 凭据管理器中的 `go-antigravity:accounts-key`。不会读取或迁移旧版账户、旧应用目录或旧凭据；首次使用时按需重新设置，不需要删除原数据。

账户自动备份只在解析修复、格式迁移等需要覆盖原文件前创建，保留最近 5 份。备份失败会中止恢复写入，不覆盖原文；普通启动与配额刷新不会每次额外创建备份。备份可能含敏感数据，应按真实账户文件保护。

内核原始 `.bak` 是恢复依据，体积较大（本机实测约 194 MB），不应当作垃圾删除；它在首次打补丁时创建一次并启用 NTFS 压缩（本机实测 194 MB → 约 109 MB，约 1.8:1），之后复用。补丁失败时按变更区间写回原始字节，不再复制整份临时镜像；只有区间写回本身失败时才留下一条 `.go-antigravity-*.tmp` 恢复快照，可手工拷回。上下文配置恢复记录保留原配置文本与本工具写入状态，以恢复原字段并保留其他内容；其中可能含本机配置，应按敏感文件保护。正常重复设置不会按时间无限新增记录。日志使用当前文件及轮转文件 `.previous`。维护脚本 `backend/scripts/scrub-secrets.cjs` 默认只扫描本版数据目录，添加 `--write` 才改写。

旧版「自定义上传」档连同 `customSystemPrompt` / `customPromptUpdatedAt` 设置项已移除：旧设置文件里的这两个键会被忽略，并在下次保存时从文件中丢弃；任何接口都不再接收或回显提示词全文，`/api/kernel/status` 只下发档位/模式词表、期望轴与内核状态。设置文件仍可能含其他本机信息，应按账户/凭据备份同等保护，不要公开分享或随源码上传。

新原子写入临时文件与 Qt 启动目录带所有者信息，只回收可确定属于本项目、已超过安全期限且所有者退出的残留。新近文件、活跃进程文件、其他项目文件及无法确定所有者的旧格式临时文件保留，避免误删。异常断电后不保证立即零残留。旧文件需在停服、确认归属并备份后人工处理。

`__pycache__/`、测试输出和旧 `_attic/` 是开发产物；`.venv-qt/` 和 `backend/node_modules/` 是开发环境依赖。Git 已排除相应本机产物，上传前仍应检查 `git status` 和实际提交内容。发布包只上传 `dist/Go-Antigravity-windows-x64.exe`（自解压，内含同一份 ZIP，完整性由 GitHub 接口给出的 SHA-256 摘要核对），不要直接压缩整个开发目录，也不要额外上传 ZIP 或 `.zip.sha256`。

当前桌面不提供账户导出按钮。后端脱敏导出不能恢复账户，完整令牌导出需要明确确认；不要将完整备份、日志或隧道凭据公开分享。

## 手机与验证

手机远程另需安装 `cloudflared`，配置方法见 [MOBILE-ACCESS.md](MOBILE-ACCESS.md)。

`Start-Go-Antigravity.cmd --demo` 仅展示合成数据，不访问真实后端。开发检查命令见 [FRONTEND.md](FRONTEND.md)。
