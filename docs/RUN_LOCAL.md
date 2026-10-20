# 本地运行

面向从源码运行、打包和安装桌面应用。日常怎么用见 [操作手册](OPERATION_MANUAL.md)，密钥、环境变量与数据目录见 [配置](CONFIGURATION.md)。

---

## 1. 准备

- Node.js 22.12 或更新，pnpm 10.28.0（`corepack enable` 后会自动用仓库 `packageManager` 字段里的版本）。
- Windows 还需要 PowerShell 7（见下文“Windows 需要 PowerShell 7”）。
- 一个 Anthropic API 密钥。

---

## 2. 从源码运行

```sh
git clone https://github.com/csxq0605/nexgent.git
cd nexgent
pnpm install --frozen-lockfile
pnpm build                               # 编译 TypeScript
pnpm --filter @nexgent/desktop build     # 构建界面（dist/renderer）；少了这一步窗口里只有占位页
pnpm --filter @nexgent/desktop start
```

也可以经命令行直接打开一个已有的文件夹：`node apps/cli/bin/nexgent.mjs app --project /path/to/project`。

- 第一次启动会下载 Electron 运行时（约 100 MB）。
- 根目录的 `pnpm build` 不构建界面；改过 `apps/desktop/src/renderer` 后要重新执行 `pnpm --filter @nexgent/desktop build`。
- Linux 以 root 运行时要加 `--no-sandbox`（Chromium 不允许 root 开沙箱）：`pnpm --filter @nexgent/desktop exec electron . --no-sandbox`。普通用户不需要。
- 同一个数据目录只允许开一个 Nexgent；再次启动会把已打开的窗口切到前台。应用被强杀后可以直接再启动，不需要清理锁文件。

模型密钥见 [配置 · 模型密钥](CONFIGURATION.md#1-模型密钥)。

---

## 3. Windows 需要 PowerShell 7

Windows 上任务里的每条命令都经 PowerShell 执行。找不到 PowerShell 7（`pwsh`）时会退回系统自带的 Windows PowerShell 5.1，并提示一次；5.1 不支持 `&&`、`||` 这类写法，命令更容易失败，所以建议装 PowerShell 7。

- 安装：`winget install --id Microsoft.PowerShell`，或从 PowerShell 的 GitHub 发布页下载 MSI。装好后新开的终端里要能直接运行 `pwsh`。
- 检查：`pwsh -NoProfile -Command '$PSVersionTable.PSVersion'` 应显示 7.x。
- 装好后重启 Nexgent。

---

## 4. 打包（未签名）

先 `pnpm build`，再 `pnpm --filter @nexgent/desktop build`，然后：

```sh
pnpm --filter @nexgent/desktop package:linux   # apps/desktop/release/Nexgent-<版本>-linux-x86_64.AppImage
pnpm --filter @nexgent/desktop package:win     # 在 Windows 上执行，产出 NSIS 安装程序 Nexgent-<版本>-win-x64.exe
```

打包脚本 `apps/desktop/scripts/package.mjs` 先用 `pnpm deploy` 把应用和生产依赖暂存到 `apps/desktop/build/app`，再交给 electron-builder。只想看暂存内容时用 `node apps/desktop/scripts/package.mjs stage`。

- **Linux AppImage**：`chmod +x` 后直接运行。需要 FUSE 2（Ubuntu 22.04 起 `sudo apt install libfuse2`）；没有 FUSE 时加 `--appimage-extract-and-run`。
- **Windows 安装程序**：因为没签名，SmartScreen 会拦，点“更多信息”再点“仍要运行”。默认按用户安装，不需要管理员权限。卸载时数据目录不会删除。

安装包没有签名、没有自动更新、没有应用图标。Windows 安装包和 macOS 安装包还没有验证过。

---

## 5. 测试

```sh
pnpm test                          # 全部测试，脚本化模型，不需要密钥
pnpm --filter <包名> test          # 只测一个包
```

desktop 包的界面端到端测试会打开真实的 Electron 窗口。Linux 上没有 `DISPLAY` 时会自己起 Xvfb；macOS 没有虚拟屏幕，会在屏幕上弹出窗口。
