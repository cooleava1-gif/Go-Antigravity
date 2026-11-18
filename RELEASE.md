# GitHub 源码发布准备

核对日期：2026-11-18。本说明针对 Windows 源码发布，不包含实际上传、推送或创建 GitHub Release。

## 当前发布条件

本轮已精简统计浮窗、修复显式代理绕过、手机原生代理来源校验和账户写盘失败事务；最终验收结果由本轮审查记录给出。测试均使用合成账户与临时目录，不代表真实 Google 账户、实际 Antigravity 网络或 cloudflared 公网端到端已验证。

公开分发前仍需完成内核补丁来源授权核对，具体证据和涉及范围统一见 [第三方声明](backend/THIRD-PARTY-NOTICES.md)。优化或改写部分实现不等于已取得原有材料的分发许可。

本目录从核准文件清单复制源码，不携带原开发仓库的 .git、个人运行数据或本机验收证据。原开发仓库及其历史保持原样；本目录单独初始化历史，不添加原仓库远程、分支或标签。

## 验证独立历史与导出源码

仅在本目录完成回归、文件清单和敏感信息复核后创建根提交，提交身份使用项目通用身份。核对仅有一个根提交、工作树干净且没有远程与标签：

~~~powershell
git status --short
git rev-list --count --all
git log --format="%h %an <%ae>" --all
git remote -v
git tag --list
~~~

来源授权问题解决后，可从本目录的核准提交导出源码：

~~~powershell
git archive --format=zip --output=../Go-Antigravity-source.zip HEAD
~~~

归档只含该提交的受跟踪文件，不含未提交修改、未跟踪文件或 .git。不要复制原开发仓库的 .git、fetch 原历史或推送原分支／标签。建立本地独立历史并不代表已上传或获准公开分发。

公开快照只应含审查通过的源码、测试、文档、必要静态资源与许可证。不得包含账户／settings、Token／主密钥、隧道 YAML／证书、日志、运行目录、旧备份、EXE、node_modules、.venv-qt、.git、.dsh-ops 或本机验收证据。只凭 .gitignore 不能证明未泄露：受跟踪旧文件和历史仍需单独核对。

## 干净环境验证

运行条件为 Windows、Python 3.10+、Node.js 22+（含 npm）；首次安装需要联网。依赖版本由 backend/package-lock.json 和 desktop-qt/requirements.txt 锁定。验证请在不含个人账户或凭据的临时目录执行。

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

CMD 入口 Start-Go-Antigravity.cmd 会检查／准备环境；--demo 使用合成数据。可选 EXE 入口仍依赖完整源码目录与 Python／Node.js，不是独立安装包。若分发依赖或打包二进制，需另行核对并附带 PyQt6、Qt 和其他实际组件的许可证及必要材料；根 MIT 声明不会替代第三方条件。

## 无需 TUN 的已验证范围

工具后台的授权码兑换、Token 刷新、用户信息、四路配额和代理预检可使用 127.0.0.1 的 HTTP CONNECT／mixed 端口。隔离夹具把上游全部映射到自有回环 HTTPS 服务，验证了 8 次 CONNECT；缺 curl 的请求会明确失败，继承的 NO_PROXY 不能绕过显式端口。SOCKS-only 端口不支持。

新启动 Antigravity 会接收代理参数和可继承的环境变量；附着到已运行客户端不会补注入。原生子进程、扩展、更新器是否采用该代理取决于客户端自身；系统默认授权浏览器使用自己的网络设置，cloudflared 公网连接不走该显式代理路径。预检结果不能证明真实账户地区资格、所有 AG 流量或公网隧道可用。

## 切换账户的当前行为

切换前先保存工作并手动退出 Antigravity。无法读取原登录凭据、无法严格确认运行状态，或客户端仍在运行时都会停止切换；不会按进程名强制关闭程序。确认已退出后才写入新凭据，下次手动启动时生效。此行为取代历史版本的自动关闭／重启。

## 本地数据修复边界

本轮针对新建备份和失败路径修复，不会替用户清理已有历史备份。旧版产生的明文备份仍属于敏感凭据资料，不能放入公开快照。损坏 JSON 或不可用密钥无法安全重构为可恢复密文，保留原始灾备的边界以账户存储测试及审查记录为准。
