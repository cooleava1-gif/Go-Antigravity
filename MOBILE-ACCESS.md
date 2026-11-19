# 手机远程与公网隧道

Go-Antigravity 桌面提供「概览」「账户」「远程」「日志」四个页面。手机服务在「远程」页配置与控制；主窗口顶部提供 Antigravity 启动入口。

手机端页面由仓库内的 `backend/mobile` 组件提供，代码与路由里沿用 **Pocket** 这个组件名（页面标题 `Antigravity Pocket`、登录路径 `/pocket-login`、`PocketError` 等），对外界面统一显示为“手机远程”。

## 默认：随机公网域名

在“手机远程”选择“随机公网域名”，保存后点击“启动”。待状态变成“运行中”，手机扫描二维码或打开页面显示的 HTTPS 地址，输入当前 8 位 PIN。二维码只包含网址。随机地址和 PIN 在重新启动服务后重新生成；停止后旧地址与二维码立即清除。

随机模式使用 Cloudflare Quick Tunnel，不需要 Cloudflare 账户或固定域名。它用于临时远程访问，没有可用性保证，单隧道并发请求数有限，且不支持 SSE；手机界面的实时更新会在 SSE 不可用时回退为轮询。不要把随机网址当作永久书签。

依赖：完整的 backend/mobile 目录、Node.js 22.13+（可使用目录内兼容运行时或系统 Node.js），以及单独安装的 cloudflared。连接器查找顺序见下方配置；缺少连接器时界面会提示，不会静默下载或修改系统。

## 可选：固定域名

推荐使用 Token 表单，无需本机 YAML。Cloudflare 官方说明：[创建远程管理隧道](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/)、[运行参数与 Token](https://developers.cloudflare.com/tunnel/reference/run-parameters/)。

1. 在 Cloudflare 创建远程管理的 Tunnel，为自己的域名配置公开路由，服务指向 `http://127.0.0.1:3082`。
2. 复制该隧道的 Tunnel Token（不是 Cloudflare 账户 API Token，也不是整条安装命令）。在“远程”页选择“固定域名”，粘贴 Token，并填写不含路径、查询、端口或凭据的 HTTPS 域名。
3. 点击“保存远程设置”或“启动远程服务”。后者会先保存，再启动；公网验证通过后才显示网址和二维码。

Token 加密保存在本机用户数据目录的 `mobile-vault.json`，沿用本机凭据库加密能力，不能当作跨电脑备份。已存 Token 不回填明文；留空沿用，输入新值替换，“清除已存”后保存才删除。保存失败保留输入供重试。Token 仅传给受管命名隧道子进程的环境变量，不进入命令行、普通设置、状态、账户导出、日志或二维码。请勿分享凭据文件；遗失本机主密钥时需要重新填写。

高级兼容路径：未保存 Token 时，仍可设置 `GO_ANTIGRAVITY_MOBILE_CF_CONFIG` 指向项目目录外的绝对 `.yml` / `.yaml` 配置文件。其入口同样应转发至本机 3082 端口。已保存 Token 优先；若加密凭据不可用会显示错误，不会静默绕过它使用 YAML。上述模式都需要用户自行准备 Cloudflare 账户、域名与隧道，不随项目分发。

服务运行、启动、停止、恢复或检测到外部服务时，连接模式、域名与 Token 设置锁定。请先停止托管服务再修改；“启动 AG 时自动开启手机远程”开关仍可单独保存。

## 生命周期与认证

“停止”只清理本次 Go-Antigravity 创建的手机服务与隧道进程树，不结束 Antigravity。默认关闭“启动 AG 时自动开启手机远程”；开启后随 Go-Antigravity 的启动/附加生命周期启动，退出时停止该自动实例。手动实例持续运行到手动停止或退出 Go-Antigravity。这不是 Windows 开机自启。

当前原生界面没有托盘保活。关闭主窗口会退出本次启动的后端并清理其托管手机服务；如果桌面复用了原有外部后端，该服务继续运行。手机页面刷新不会停止服务。电脑需联网、不休眠，Antigravity 桌面端需保持可用。

PIN 仅保存在当前进程与受保护的本地页面内存中，不写入设置、日志、网址或二维码；每次启动生成新 PIN。访问受保护接口必须先登录。Go-Antigravity 本地接口继续使用会话令牌和跨站写入保护。

首次启动最多约 125 秒，优先使用 HTTP/2，连接停滞时在同一预算内尝试备用协议。公网入口通过验证后才显示二维码；DNS 传播等待不会反复重启已经连接的隧道。运行中每 5 秒检查健康状态，连接器异常时最多自动重建两次，连续健康 10 分钟后重置恢复预算；停止会取消探测与恢复。自动重建保留本地服务和当前 PIN，随机公网地址可能改变，请使用恢复后的最新二维码。公网验证通过仍不保证所有手机网络都能访问。

检测到端口已被独立服务占用时显示“外部服务运行中”；Go-Antigravity 不接管、不停止外部服务，也不知道其 PIN。正常清理只针对记录的子进程 PID，不按进程名或端口批量终止。系统断电、强制结束或父进程崩溃仍可能遗留外部进程，需在原启动位置处理。

## 可移植配置

默认运行时位于 backend/mobile，通过当前 Go-Antigravity Node 运行，不依赖 DSH 或某台电脑的绝对路径。通常无需设置下列环境变量：

- GO_ANTIGRAVITY_CLOUDFLARED：cloudflared 可执行文件路径；未设置时尝试标准安装位置及 PATH。
- GO_ANTIGRAVITY_MOBILE_CF_CONFIG：高级兼容用的外部本机隧道配置路径；已存 Token 优先，Token 表单和随机模式都无需设置。
- GO_ANTIGRAVITY_MOBILE_PROJECT：可选手机运行时目录，需同时包含 tunnel.mjs 与 server.mjs。
- GO_ANTIGRAVITY_MOBILE_NODE：可选兼容 Node 可执行文件；未来非 Node 宿主必须显式设置。

普通设置保存在 Go-Antigravity 用户数据目录的 settings.json：mobileAutoStart、mobileMode、mobileFixedUrl。该文件不包含 PIN、动态公网地址或隧道凭据；Token 使用单独的加密记录。配置环境变量后请完全退出并重新打开 Go-Antigravity。

## 源码分发与维护

桌面源码运行需 Python 3.10+ 与 Node.js 22.13+（含 npm），使用根目录 Start-Go-Antigravity.cmd 准备依赖并启动。仅运行后端可在 backend 中执行 npm ci、npm start；测试执行 npm run verify。目录型 Windows 发布包由 scripts/package-windows.ps1 生成，内含 Go-Antigravity.exe、Node、Python/PyQt 和生产依赖，运行时不执行 npm/pip。只构建 Go-Antigravity.exe 时，它仍只是调用启动脚本的入口，需要完整源码与开发机运行时。cloudflared 需另行安装或按其许可证单独提供。

发布前检查版本库内容，排除 .env、用户设置、账号库、日志、Cloudflare YAML/凭据 JSON、证书、备份与运行时文件。保留 backend/mobile/vendor 与二维码编码器的许可证。不要把本机安装目录打包后直接上传。

此独立版本已禁用代码和词典在线更新，也不加载旧 runtime/current 覆盖层。手动更新或回退前请停止手机服务并退出桌面，保留用户数据、账户加密主密钥和隧道凭据，更新后重新验证依赖与手机接口。

Cloudflare Quick Tunnel 限制参考：https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/
