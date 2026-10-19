# 安装与运行 Nexgent 桌面应用

> 桌面应用在 Linux 和 Windows 上从源码运行，已通过步骤 2–5 的桌面层验收（见文末“验证记录”）。Windows 安装包尚未验证；macOS 只做过一次从源码运行的人工试用，不算验收。安装包未签名，没有自动更新，没有应用图标；签名与自动更新还没有做。

## 从源码运行

需要 Node.js 22.12 或更新版本、pnpm 10（`corepack enable` 后用仓库 `packageManager` 字段指定的版本）。Windows 上还需要 PowerShell 7（见下文“Windows 需要 PowerShell 7”）。

```sh
git clone https://github.com/csxq0605/Nexgent.git
cd Nexgent
git checkout nexgent-app
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @nexgent/desktop build   # 构建界面（dist/renderer）；少了这一步，窗口里只有“界面尚未构建”的占位页
pnpm --filter @nexgent/desktop start
# 或者经 CLI，直接打开一个项目（目录必须已存在）：
node apps/cli/bin/nexgent.mjs app --project /path/to/project
```

- 第一次启动 Electron 时会下载 Electron 运行时（约 100 MB）。
- 数据目录默认是 `~/.nexgent`（Windows 为 `%USERPROFILE%\.nexgent`），可用环境变量 `NEXGENT_HOME` 改到别处。日志在其中的 `logs/desktop-YYYY-MM-DD.log`，`NEXGENT_LOG_LEVEL=debug` 可看到更多。
- 模型密钥从环境变量 `NEXGENT_API_KEY`（其次 `ANTHROPIC_API_KEY`）读取，例如 `export NEXGENT_API_KEY=<key>`；也可以在设置页填写（写入 `~/.nexgent/credentials.json`，权限 0600）。不要把密钥写进项目目录或仓库。
- Linux 以 root 运行时需要加 `--no-sandbox`（Chromium 不允许 root 开沙箱）：`pnpm --filter @nexgent/desktop exec electron . --no-sandbox`。普通用户不需要。
- 同一个 `NEXGENT_HOME` 只允许一个实例；再次启动会把已打开的窗口切到前台。主进程被强杀后可以直接再启动，不需要手动清理锁文件。
- 根目录的 `pnpm build` 只编译 TypeScript，不构建界面；改过 `apps/desktop/src/renderer` 后要重新执行 `pnpm --filter @nexgent/desktop build`。

### Windows 需要 PowerShell 7

在 Windows 上，任务里的每条命令都经 PowerShell 7（`pwsh`）执行：命令工具就是 `pwsh`，用来在结束时连同子进程一起清理的 Job Object 启动器也是 `pwsh` 脚本。系统自带的 Windows PowerShell 5.1（`powershell.exe`）不能代替：启动器用到 5.1 没有的 .NET 接口，模型写的命令也按 PowerShell 7 的语法（如 `&&`、`||`）。所以没有回退到 5.1。

- 安装：`winget install --id Microsoft.PowerShell`，或从 PowerShell 的 GitHub 发布页下载 MSI。装好后要能在新开的终端里直接运行 `pwsh`（安装程序默认会加进 `PATH`）。
- 检查：`pwsh -NoProfile -Command '$PSVersionTable.PSVersion'` 应显示 7.x。
- 没装时：桌面应用启动后在窗口顶部提示“没有找到 PowerShell 7（pwsh）”；任务里的命令失败时，错误信息也会写明缺的是 PowerShell 7。装好后重启 Nexgent。

## 打包（不签名）

先在仓库根执行 `pnpm build`，再执行 `pnpm --filter @nexgent/desktop build` 构建界面（没构建界面时，打出来的包只显示占位页），然后：

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

- Linux（云端会话，2026-10-11）：`package:linux` 产出 AppImage；解包目录与 AppImage（`APPIMAGE_EXTRACT_AND_RUN=1`）都能启动，`app.info` 的 IPC 往返成功，打包后的应用忽略开发用环境变量。
- Linux，从源码运行（2026-10-11，提交 `f7077a4`）：`accept-step2` 桌面层 D01–D10 全部通过，见 [`step-2-20261011.md`](validation/step-2-20261011.md)。验收没有覆盖安装包本身。
- Windows，从源码运行（2026-10-11，GitHub `windows-latest`，手动触发的 `windows-accept.yml`）：`accept-step2` 桌面层 D01–D10 与 desktop 包测试（含 UI e2e）全部通过，见 [`step-2-20261011.md`](validation/step-2-20261011.md)。
- macOS，从源码运行（2026-10-16，arm64，Node 26，Electron 44）：按本文安装、构建、启动没有遇到阻碍；desktop 包测试（含 UI e2e）全部通过，`accept-step3` 无界面层 23/23 通过。这是一次人工试用，不是验收；没有打 macOS 安装包。macOS 没有虚拟屏幕，desktop 包的 e2e 测试会在屏幕上打开真实窗口并模拟输入。
- 步骤 3（2026-10-11）：`accept-step3` 桌面层 14/14 在 Linux 通过；Windows 手动运行 [38163013365](https://github.com/csxq0605/Nexgent/actions/runs/38163013365)（提交 `ce6c14c8`）通过，desktop 包测试 162 项通过。见 [`step-3-20261011.md`](validation/step-3-20261011.md)。
- 步骤 4（2026-10-12）：`accept-step4` 桌面层 18/18 在 Linux 通过；Windows 手动运行 [38287245347](https://github.com/csxq0605/Nexgent/actions/runs/38287245347)（提交 `2043e919`）通过，desktop 包测试通过。见 [`step-4-20261012.md`](validation/step-4-20261012.md)。
- 步骤 5（2026-10-13）：`accept-step5` 桌面层 23/23 在 Linux 通过；Windows 手动运行 [38412397510](https://github.com/csxq0605/Nexgent/actions/runs/38412397510)（提交 `6a769c38`）通过，desktop 包测试通过。见 [`step-5-20261013.md`](validation/step-5-20261013.md)。
- 步骤 6：尚未验收，仓库里还没有验收记录。`accept-step6` 的脚本化检查（含桌面层 D01–D27）在 Linux 与 Windows 手动运行中通过过，这些只是开发中的检查，不算验收。
- 上面的 Windows 运行都在 GitHub `windows-latest` 上，那里预装了 PowerShell 7；没有在只带 Windows PowerShell 5.1 的机器上跑过。
- Windows 安装包：未验证，`package:win` 没有打过。
