# GitHub 源码发布准备

核对日期：2026-11-18。本说明覆盖 Windows 源码快照和目录型 EXE 发布包；不包含本次实际上传、推送或创建 GitHub Release。

## 当前发布条件

独立版从源码启动本机后端，不加载在线更新、旧覆盖层、旧窗口宿主或旧 Node 运行时。账户/设置/日志与旧版隔离，Qt 拒绝复用不匹配的后端。Node 后端包是私有实现，不发布到 npm。测试使用合成账户与临时目录，不代表真实 Google 账户、实际 Antigravity 网络或 cloudflared 公网端到端已验证。

当前内核补丁已改为仓库内独立实现，不加载或打包外部补丁工具；历史参考、支持的二进制观察和实际依赖边界见 [第三方声明](backend/THIRD-PARTY-NOTICES.md)。公开分发前仍需核对实际 Antigravity 文件、运行时和其他依赖的许可条件。

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

运行条件为 Windows、Python 3.10+、Node.js 22+（含 npm）；首次安装需要联网。依赖版本由 backend/package-lock.json 和 desktop-qt/requirements.txt 锁定。验证请在不含个人账户或凭据的临时目录执行。首次启动选择系统 Node，不回退旧式便携运行时。发布验证只连接公共包仓库安装测试依赖，不启动真实账户、客户端或公网远程。

~~~powershell
npm --prefix backend ci
npm --prefix backend run verify
python -m venv .venv-qt
.\.venv-qt\Scripts\python.exe -m pip install -r desktop-qt/requirements.txt
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap-tests.ps1
Get-ChildItem desktop-qt/test_*.py | Sort-Object Name | ForEach-Object {
    & .\.venv-qt\Scripts\python.exe -B $_.FullName -v
    if ($LASTEXITCODE -ne 0) { throw "Desktop test failed" }
}
.\.venv-qt\Scripts\python.exe -B desktop-qt/smoke_test.py --output "$env:TEMP/go-antigravity-qa"
~~~

CMD 入口 Start-Go-Antigravity.cmd 会检查／准备源码环境；--demo 使用合成数据。目录型 EXE 包使用包内 Node、Python/PyQt 和生产依赖，运行时不执行 npm/pip。若分发依赖或打包二进制，需附带 PyQt6、Qt、Node 和其他实际组件的许可证及必要材料；根 MIT 声明不会替代第三方条件。

## 构建 Windows 发布包

在干净的 Windows 工作目录准备锁定依赖后执行：

~~~powershell
npm --prefix backend ci
python -m venv .venv-qt
.\.venv-qt\Scripts\python.exe -m pip install -r desktop-qt/requirements.txt
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-windows.ps1 -Clean
Get-Content dist/Go-Antigravity-windows-x64/runtime/manifest.json
~~~

脚本会生成 `dist/Go-Antigravity-windows-x64/` 和同名 ZIP。包内入口是 `Go-Antigravity.exe`，包内运行时目录是 `runtime/node/` 与 `runtime/python/`；账户、设置、日志和自定义系统提示词默认位于 `%LOCALAPPDATA%\Go-Antigravity`。GitHub Actions 的标签发布流程见 `.github/workflows/release-windows.yml`。

## 无需 TUN 的已验证范围

工具后台的授权码兑换、Token 刷新、用户信息、四路配额和代理预检可使用 127.0.0.1 的 HTTP CONNECT／mixed 端口。隔离夹具把上游全部映射到自有回环 HTTPS 服务，验证了 8 次 CONNECT；缺 curl 的请求会明确失败，继承的 NO_PROXY 不能绕过显式端口。SOCKS-only 端口不支持。

新启动 Antigravity 会接收代理参数和可继承的环境变量；附着到已运行客户端不会补注入。原生子进程、扩展、更新器是否采用该代理取决于客户端自身；系统默认授权浏览器使用自己的网络设置，cloudflared 公网连接不走该显式代理路径。预检结果不能证明真实账户地区资格、所有 AG 流量或公网隧道可用。

## 切换账户的当前行为

切换前先保存工作并手动退出 Antigravity。无法读取原登录凭据、无法严格确认运行状态，或客户端仍在运行时都会停止切换；不会按进程名强制关闭程序。确认已退出后才写入新凭据，下次手动启动时生效。此行为取代历史版本的自动关闭／重启。

## 本地数据修复边界

本轮针对新建备份和失败路径修复，不会替用户清理已有历史备份。旧版产生的明文备份仍属于敏感凭据资料，不能放入公开快照。损坏 JSON 或不可用密钥无法安全重构为可恢复密文，保留原始灾备的边界以账户存储测试及审查记录为准。
