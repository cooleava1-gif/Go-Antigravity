# GitHub 源码发布准备

核对日期为 2026-11-19。本说明覆盖 Windows 源码快照和目录型 EXE 发布包。

## 当前发布条件

独立版从源码启动本机后端，不加载在线更新、旧覆盖层、旧窗口宿主或旧 Node 运行时。账户/设置/日志与旧版隔离，Qt 拒绝复用不匹配的后端。Node 后端包是私有实现，不发布到 npm。测试使用合成账户与临时目录，不代表真实 Google 账户、实际 Antigravity 网络或 cloudflared 公网端到端已验证。

当前内核补丁已改为仓库内独立实现，不加载或打包外部补丁工具；依赖许可边界与公开分发前的核查项见 [第三方声明](backend/THIRD-PARTY-NOTICES.md)。公开分发前仍需核对实际 Antigravity 文件、运行时和其他依赖的许可条件。

现有独立历史的根提交包含早期版本的内核补丁。若要公开分发，应从当前复核通过的源码另建发布目录和新的 Git 历史；只关闭功能或隐藏界面入口，不能清除旧提交中的代码。

本目录从核准文件清单复制源码，不携带原开发仓库的 .git、个人运行数据或本机验收证据。原开发仓库及其历史保持原样；本目录单独初始化历史，不添加原仓库远程、分支或标签。

## 验证独立历史与导出源码

仅在本目录完成回归、文件清单和敏感信息复核后创建根提交，提交身份使用项目通用身份。首次建立独立历史时核对初始根提交。之后允许有本项目自己的后续提交；发布前核对工作树干净、远程仅指向自己的仓库（或未设置），以及没有旧上游标签：

~~~powershell
git status --short
git rev-list --max-parents=0 main
git log --format="%h %an <%ae>" --all
git remote -v
git tag --list
~~~

来源授权问题解决后，可从本目录的核准提交导出源码：

~~~powershell
git archive --format=zip --output=../Go-Antigravity-source.zip HEAD
~~~

归档只含该提交的受跟踪文件，不含未提交修改、未跟踪文件或 .git。不要复制原开发仓库的 .git、fetch 原历史或推送原分支／标签。建立本地独立历史并不代表已上传或获准公开分发。

公开源码快照只应含审查通过的源码、测试、文档、必要静态资源与许可证。不得包含账户／settings、Token／主密钥、隧道 YAML／证书、日志、运行目录、旧备份、EXE、node_modules、.venv-qt、.go-antigravity-data、.git、.dsh-ops 或本机验收证据。只凭 .gitignore 不能证明未泄露：受跟踪旧文件和历史仍需单独核对。目录型 EXE 包单独由打包脚本生成，不从整个开发目录复制。

## 干净环境验证

源码验证需要 Windows、Python 3.10+ 和带 npm 的 Node.js。后端和手机会话列表直接加载 `node:sqlite`，因此 Node 22 的最低版本为 22.13.0，Node 23 的最低版本为 23.4.0。CI 使用 22.13.0 和 24.x 执行 SQLite 检查和后端测试，Qt 在一个 Windows 作业中验证。首次安装从公共包仓库读取 backend/package-lock.json 和 desktop-qt/requirements.txt 锁定的依赖。请在不含个人账户或凭据的临时目录执行验证。

~~~powershell
npm --prefix backend ci
npm --prefix backend run verify
python -m venv .venv-qt
.\.venv-qt\Scripts\python.exe -m pip install -r desktop-qt/requirements.txt
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap-tests.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows-process-tests.ps1
pwsh -NoProfile -File scripts/package-rules-tests.ps1
Get-ChildItem desktop-qt/test_*.py | Sort-Object Name | ForEach-Object {
    & .\.venv-qt\Scripts\python.exe -B $_.FullName -v
    if ($LASTEXITCODE -ne 0) { throw "Desktop test failed" }
}
.\.venv-qt\Scripts\python.exe -B desktop-qt/smoke_test.py --output "$env:TEMP/go-antigravity-qa"
~~~

CMD 入口 Start-Go-Antigravity.cmd 会检查／准备源码环境；--demo 使用合成数据。目录型 EXE 包使用包内 Node、Python/PyQt 和生产依赖，运行时不执行 npm/pip。若分发依赖或打包二进制，需附带 PyQt6、Qt、Node 和其他实际组件的许可证及必要材料；根 MIT 声明不会替代第三方条件。

## 构建 Windows 发布包

使用 PowerShell 7（`pwsh`）构建并验收发布包。Qt 自带资源的部分路径较长，PowerShell 7 与发布 workflow 使用相同的文件和归档工具。

~~~powershell
npm --prefix backend ci
python -m venv .venv-qt
.\.venv-qt\Scripts\python.exe -m pip install -r desktop-qt/requirements.txt
pwsh -NoProfile -File scripts/package-windows.ps1 -Clean
Get-Content dist/Go-Antigravity-windows-x64/runtime/manifest.json
~~~

脚本会生成 `dist/Go-Antigravity-windows-x64/` 和同名 ZIP。包内入口是 `Go-Antigravity.exe`，包内运行时目录是 `runtime/node/` 与 `runtime/python/`；账户、设置和日志默认位于 `%LOCALAPPDATA%\Go-Antigravity`。

发布到 GitHub 的是由下面这条命令生成的自解压 EXE，它把同一份 ZIP 追加在原生启动程序之后，用户只需下载一个文件；ZIP 和 `.zip.sha256` 保留为构建产物与本地验收材料，不上传 Release：

~~~powershell
pwsh -NoProfile -File scripts/build-portable-exe.ps1 -PackageZip dist/Go-Antigravity-windows-x64.zip -OutputDirectory dist
~~~

脚本会校验 EXE 总长度、`MZ` 头、末尾追加区与 ZIP 的 SHA-256 一致，并把 `AssemblyVersion` / `FileVersion` 写成包内版本号。GitHub Actions 的标签发布流程见 `.github/workflows/release-windows.yml`。

构建后对生成的 ZIP 运行以下命令。脚本解压到临时目录，扫描敏感文件并核对 manifest，然后由包内启动脚本选择 Node 和 Python。在隔离的 `LOCALAPPDATA` 下检查后端模块、SQLite 和数据目录，最后用包内 `pythonw.exe` 打开合成数据演示，等待 Qt 发出窗口就绪信号并正常退出。

~~~powershell
$package = Resolve-Path dist/Go-Antigravity-windows-x64.zip
pwsh -NoProfile -File scripts/package-smoke-test.ps1 -PackagePath $package
if ($LASTEXITCODE -ne 0) { throw 'Package smoke test failed' }

$stage = Resolve-Path dist/Go-Antigravity-windows-x64
. ./scripts/package-rules.ps1
$forbidden = @(Get-PackageForbiddenItems $stage)
if ($forbidden) { $forbidden | Select-Object -ExpandProperty FullName; throw 'Sensitive or temporary files entered the package.' }
Get-Content (Join-Path $stage 'runtime/manifest.json')
~~~

GitHub 标签发布先调用 `.github/workflows/verify.yml` 的可复用验证流程。Node 矩阵和桌面 smoke test 全部通过后才构建包；包 smoke test 通过后打成单文件 EXE，CI 再把 EXE 解到临时目录重算源码指纹并核对版本，最后只上传这个 EXE 并创建 Release。

## 无需 TUN 的已验证范围

工具后台的授权码兑换、Token 刷新、用户信息、四路配额和代理预检可使用 127.0.0.1 的 HTTP CONNECT／mixed 端口。隔离夹具把上游全部映射到自有回环 HTTPS 服务，验证了 8 次 CONNECT；缺 curl 的请求会明确失败，继承的 NO_PROXY 不能绕过显式端口。SOCKS-only 端口不支持。

新启动 Antigravity 会接收代理参数和可继承的环境变量；附着到已运行客户端不会补注入。原生子进程、扩展、更新器是否采用该代理取决于客户端自身；系统默认授权浏览器使用自己的网络设置，cloudflared 公网连接不走该显式代理路径。预检结果不能证明真实账户地区资格、所有 AG 流量或公网隧道可用。

## 切换账户的当前行为

切换前先保存工作并手动退出 Antigravity。无法读取原登录凭据、无法严格确认运行状态，或客户端仍在运行时都会停止切换；不会按进程名强制关闭程序。确认已退出后才写入新凭据，下次手动启动时生效。此行为取代历史版本的自动关闭／重启。

## 本地数据修复边界

本轮针对新建备份和失败路径修复，不会替用户清理已有历史备份。旧版产生的明文备份仍属于敏感凭据资料，不能放入公开快照。损坏 JSON 或不可用密钥无法安全重构为可恢复密文，保留原始灾备的边界以账户存储测试及审查记录为准。
