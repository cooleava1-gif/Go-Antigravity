# Go-Antigravity 界面开发

## 当前结构

桌面界面使用 Python / PyQt6 原生 Widgets，位于 `desktop-qt/`，不再加载 HTML 桌面前端。
Node.js API 和 `backend/mobile/` 手机浏览器界面继续保留。

- `theme.py`：Liquid Glass 深色黑曜玻璃 / 浅色冰晶玻璃调色板、Windows DWM 标题栏同步与 QSS 样式。
- `widgets.py`：自定义 `QPainter` 液态玻璃组件（`GlassCanvas` 环境光斑、`GlassCard` 高光折射卡片、`ToggleSwitch`、`SegmentedControl`、`AccountCardWidget`、`QuotaBarWidget`、`ModelDistributionBar`）与单色矢量 SVG 图标集。
- `ui.py`：横向宽屏（默认 `1120×640`，最小 `940×580`）顶部三分组悬浮导航栏 + 四大专页工作区（`概览`、`账户`、`远程`、`日志`）。
- `account_tools.py`：账户工具栏直接提供「刷新全部配额」「读取本地客户端账户」「导入账户 / 令牌」，详情区保留「重新授权」入口。
- `backend_client.py` / `runtime.py`：Qt 异步本地请求客户端与后端进程发现/托管。

修改 Python 源码后重新启动桌面程序。修改后端后，需要重启实际使用的后端服务；仅重新打开桌面不会重启复用的服务。

## 运行与验证

在项目根目录运行：

~~~powershell
.venv-qt/Scripts/python.exe -B desktop-qt/main.py --demo
.venv-qt/Scripts/python.exe -B desktop-qt/test_runtime.py -v
.venv-qt/Scripts/python.exe -B desktop-qt/test_backend_client.py -v
.venv-qt/Scripts/python.exe -B desktop-qt/test_widgets.py -v
.venv-qt/Scripts/python.exe -B desktop-qt/test_ui.py -v
.venv-qt/Scripts/python.exe -B desktop-qt/test_account_tools_ui.py -v
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap-tests.ps1
.venv-qt/Scripts/python.exe -B desktop-qt/smoke_test.py --output "$env:TEMP/go-antigravity-qa"
powershell -NoProfile -ExecutionPolicy Bypass -File desktop-qt/build-launcher.ps1
~~~

在 `backend/` 目录运行：

~~~sh
npm ci
npm run verify
~~~

`desktop-qt/smoke_test.py` 仅使用合成 `FakeClient`、临时 `QSettings`（`QTemporaryDir`）与测试快照，不写真实配置、令牌库或内核；覆盖四大专页动画切换、网络/增强未保存保护与端口预设联动锁定、内核档位与恢复默认、单主 CTA 账户卡片与配额排序、OAuth 域名校验、手机远程模式切换与 PIN 遮盖、全部日志和脱敏、深浅双主题及 `1120×640` / `940×580` 横向零溢出检查。

`test_backend_client.py`、`test_widgets.py`、`test_ui.py` 和 `test_account_tools_ui.py` 覆盖迟到状态与并行保存响应、错误回显脱敏、长文本与用量布局、日志筛选、账户按钮与状态保护，以及七天模型分布口径；均使用合成数据和隔离设置，不连接真实服务。

## 交互与安全规范

- 顶部导航栏固定三分组控制条：左侧品牌与当前账户/代理就绪摘要、居中「概览 / 账户 / 远程 / 日志」液态胶囊导航、右侧主题切换、「检测连接」与「启动 Antigravity」。
- 手机远程：仅在 `running` / `degraded` / `external` 且有公网地址时显示 HTTPS 地址与二维码；恢复阶段清除旧地址与二维码，保留当前 PIN，恢复完成后展示最新地址。`stopped` 或无公网地址时不显示本地 `127.0.0.1` 二维码；固定域名和密码态 Tunnel Token 表单仅在 `fixed` 模式下展示；Token 留空沿用、清除显式提交、保存成功清空输入，失败保留草稿，运行与外部服务状态禁用编辑；请求等待 `135s`，覆盖后端 `125s` 启动预算，并在启动和恢复阶段允许「停止服务」取消；PIN 默认遮盖，离开「远程」页或窗口失焦自动重新遮盖。
- OAuth 授权回调地址、账户令牌、Tunnel Token、PIN 不得进入状态提示或可复制日志；客户端错误处理也遮盖本次提交的原值。
- 系统提示词选择为 `stock`（默认，官方原版）和 `3`（最大化精简）。旧载荷用于识别与恢复。精简版重写三个核心指令模板，正文合计 344 字节。身份、工具声明和辅助模板按官方备份保留。
- 「应用内核」提交用户点选过的字段 `promptTier` 或 `contextMode`。「恢复默认」提交 `{"promptTier":"stock","contextMode":"256k"}`。内核接口只接受这两个设置字段。
- 旧版精简或均衡提示词保留到用户明确应用提示词档位。启动前可对干净的新内核重新应用已确认的新版精简设置。
- 上下文控件仅用无字小圆环和旁边百分比，浮层沿用宿主主题，支持悬停、点击、Escape 和窄屏滚动。仅保留估算上下文、模型、本对话输入／输出 Token、有效样本 TTFT 与按流式时长加权 TPS；缺失统计行和空分组自动隐藏，零值保留。系统／工具拆分、缓存和时长不再占位，采样覆盖与口径放入悬停提示。
- 上下文档位为 `256k`（默认）和 `512k`，本机客户端上限分别为 256,000 和 512,000 Token。旧 900K／1M 偏好迁到 512K。上下文圆环以已核对的实际内核上限为准，缺少限额签名时采用宿主读数。这是本机上限，不代表上游接受512K请求、增加额度或解锁模型。
- 说明小字统一 12px、允许换行；固定域名表单在最小窗口可纵向滚动，不产生横向溢出。
