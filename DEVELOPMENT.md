# Go-Antigravity 开发指引

## 唯一工作目录

以后只在克隆下来的本仓库根目录继续开发：

```text
Go-Antigravity-public\
```

这是当前独立 Git 历史、源码、测试和发布脚本的唯一源目录。GitHub 源码仓库也应当从这里提交和推送。

## 改功能时看哪里

| 目标 | 目录或文件 | 说明 |
| --- | --- | --- |
| PyQt 桌面界面 | `desktop-qt/ui.py`、`widgets.py`、`theme.py` | 页面布局、控件、主题和交互 |
| 桌面启动与本地服务 | `desktop-qt/main.py`、`runtime.py`、`backend_client.py` | 启动窗口、连接本地后端、生命周期管理 |
| 账户、设置、凭据 | `backend/core/` | 本地数据、账户、配额、加密存储和日志 |
| 后端 API | `backend/desktop/application.js`、`backend/desktop/api.js` | 桌面调用的本地接口和状态流 |
| 内核补丁 | `backend/features/kernel-patch.js`、`kernel-prompt-payloads.json` | 上下文、系统提示词、备份和恢复 |
| 代理与 Token | `backend/features/proxy.js`、`proxy-probe.js`、`backend/core/agoauth.js` | 代理预检、授权和刷新 |
| 手机远程 | `backend/mobile/`、`backend/features/mobile-access.js` | 手机网页、隧道和服务控制 |
| 启动脚本 | `Start-Go-Antigravity.ps1`、`Start-Go-Antigravity.cmd` | 源码模式和发布包模式的启动入口 |
| Windows 发布 | `scripts/package-windows.ps1`、`.github/workflows/` | 构建目录型 EXE 包和 GitHub Actions |
| Node 后端测试 | `backend/test/` | API、账户、内核、代理和远程功能 |
| Qt 测试 | `desktop-qt/test_*.py`、`desktop-qt/smoke_test.py` | 桌面控件、页面和合成数据验收 |

根目录的 `Go-Antigravity.exe` 不是真正的业务源码，它是带图标的本地启动器。需要改变启动行为时编辑 `desktop-qt/launcher.cs` 或 `desktop-qt/build-launcher.ps1`，再重新构建入口。

## 日常开发流程

在项目根目录执行：

```powershell
# 预览桌面界面，不连接真实账户或 Antigravity
Start-Go-Antigravity.cmd --demo

# 后端语法和测试
npm --prefix backend ci
npm --prefix backend run verify

# Qt 启动脚本和桌面测试
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap-tests.ps1
Get-ChildItem desktop-qt/test_*.py | Sort-Object Name | ForEach-Object {
    & .\.venv-qt\Scripts\python.exe -B $_.FullName -v
    if ($LASTEXITCODE -ne 0) { throw "Desktop test failed: $($_.Name)" }
}
& .\.venv-qt\Scripts\python.exe -B desktop-qt/smoke_test.py --output "$env:TEMP\go-antigravity-qa"
```

修改界面代码后重启桌面；修改后端代码后重启实际使用的后端服务。只重新打开窗口不会替换已经复用的旧后端进程。

## 构建发布包

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File desktop-qt/build-launcher.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-windows.ps1 -Clean
```

输出位置：

```text
dist/Go-Antigravity-windows-x64/
dist/Go-Antigravity-windows-x64.zip
```

发布包已经包含 Node、Python、PyQt 和生产依赖。GitHub 发布时上传 ZIP，不要上传整个开发目录，也不要只上传根目录的 EXE。

## 哪些目录不要改

| 路径 | 处理方式 |
| --- | --- |
| `dist/` | 构建输出，可随时重新生成；当前发布包可以保留作交付物 |
| `.venv-qt/` | 本机 Python 依赖环境，不提交、不手改 |
| `backend/node_modules/` | 本机 Node 依赖环境，不提交、不手改 |
| `desktop-qt/__pycache__/` | Python 缓存，可删除 |
| `.go-antigravity-data/` | 源码模式账户、设置和日志，属于本机数据，不要删除或上传 |
| `%LOCALAPPDATA%\Go-Antigravity` | 发布包模式账户、设置和日志，属于本机数据，不要删除或上传 |
| `Go-Antigravity.exe` | 生成的启动入口，不直接改二进制 |

当前没有 `qt-worker-checks.py`。它不是本版本的开发入口；对应职责由 `scripts/bootstrap-tests.ps1`、`npm --prefix backend run verify` 和 `desktop-qt/smoke_test.py` 承担。

## 发布前检查

```powershell
git status --short
git diff --check
Get-Content dist/Go-Antigravity-windows-x64/runtime/manifest.json
```

确认提交中没有账户数据、日志、令牌、备份、`.venv-qt`、`node_modules`、`dist` 或本地运行缓存。真实账户和公网隧道验证需要单独进行，`--demo` 只验证界面和合成状态。
