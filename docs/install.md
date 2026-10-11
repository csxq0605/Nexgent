# 安装与运行 Nexgent 桌面应用

> 步骤 2 的桌面应用尚在开发：主进程（已接 SDK）与打包已就绪，界面（W6）接入前，窗口里是占位页。安装包未签名，没有自动更新；签名与自动更新放在步骤 2 之后。

## 从源码运行

需要 Node.js 22.12 或更新版本、pnpm 10（`corepack enable` 后用仓库 `packageManager` 字段指定的版本）。

```sh
git clone https://github.com/csxq0605/Nexgent.git
cd Nexgent
git checkout nexgent-app
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @nexgent/desktop start
# 或者经 CLI，直接打开一个项目（目录必须已存在）：
node apps/cli/bin/nexgent.mjs app --project /path/to/project
```

- 第一次启动 Electron 时会下载 Electron 运行时（约 100 MB）。
- 数据目录默认是 `~/.nexgent`（Windows 为 `%USERPROFILE%\.nexgent`），可用环境变量 `NEXGENT_HOME` 改到别处。日志在其中的 `logs/desktop-YYYY-MM-DD.log`，`NEXGENT_LOG_LEVEL=debug` 可看到更多。
- 模型密钥从环境变量 `NEXGENT_API_KEY`（其次 `ANTHROPIC_API_KEY`）读取，或在设置页填写（写入 `~/.nexgent/credentials.json`，权限 0600）。
- Linux 以 root 运行时需要加 `--no-sandbox`（Chromium 不允许 root 开沙箱）：`pnpm --filter @nexgent/desktop exec electron . --no-sandbox`。普通用户不需要。
- 同一个 `NEXGENT_HOME` 只允许一个实例；再次启动会把已打开的窗口切到前台。主进程被强杀后可以直接再启动，不需要手动清理锁文件。

## 打包（不签名）

先在仓库根执行 `pnpm build`，然后：

```sh
# Linux：产出 apps/desktop/release/Nexgent-<版本>-linux-x86_64.AppImage
pnpm --filter @nexgent/desktop package:linux

# Windows（在 Windows 上执行）：产出 apps/desktop/release/Nexgent-<版本>-win-x64.exe（NSIS 安装程序）
pnpm --filter @nexgent/desktop package:win
```

打包脚本 `apps/desktop/scripts/package.mjs` 先用 `pnpm deploy` 把应用和它的生产依赖（含工作区内的包）复制到 `apps/desktop/build/app`，再交给 electron-builder。首次打包会下载 AppImage / NSIS 工具。只想检查暂存内容时用 `node apps/desktop/scripts/package.mjs stage`。

## 安装未签名的包

### Linux（AppImage）

```sh
chmod +x Nexgent-0.0.0-linux-x86_64.AppImage
./Nexgent-0.0.0-linux-x86_64.AppImage
```

- 需要 FUSE 2（Ubuntu 22.04 及以后：`sudo apt install libfuse2`）。没有 FUSE 时可以 `./Nexgent-…AppImage --appimage-extract-and-run`，或设环境变量 `APPIMAGE_EXTRACT_AND_RUN=1`。
- 部分发行版禁止非特权用户命名空间，Electron 会提示沙箱错误；这时请按发行版说明开启 `kernel.unprivileged_userns_clone`，不建议用 `--no-sandbox` 长期运行。

### Windows（NSIS 安装程序）

1. 双击 `Nexgent-0.0.0-win-x64.exe`。
2. 因为没有签名，SmartScreen 会提示“Windows 已保护你的电脑”：点“更多信息”，再点“仍要运行”。
3. 选择安装目录（默认按用户安装，不需要管理员权限），完成后从开始菜单或桌面快捷方式启动。
4. 卸载：在“设置 → 应用”里卸载 Nexgent。数据目录 `%USERPROFILE%\.nexgent` 不会被删除。

## 验证记录

- Linux（云端会话，2026-10-11）：`package:linux` 产出 AppImage；解包目录与 AppImage（`APPIMAGE_EXTRACT_AND_RUN=1`）都能启动，窗口加载占位页，`app.info` 的 IPC 往返成功，打包后的应用忽略开发用环境变量。
- Windows：未验证（当前没有 Windows 自动检查）。
