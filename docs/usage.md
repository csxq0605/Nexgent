# 使用说明

## 安装

### 准备

- Node.js 22.12 或更新，pnpm 10.28.0（`corepack enable` 后会自动用仓库 `packageManager` 字段里的版本）。
- Windows 还需要 PowerShell 7（见下文“Windows 需要 PowerShell 7”）。
- 一个 Anthropic API 密钥。

### 从源码运行

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

### 模型密钥

密钥只从两个地方读：

1. 环境变量 `NEXGENT_API_KEY`，没有时用 `ANTHROPIC_API_KEY`，例如 `export NEXGENT_API_KEY=<key>`；
2. 桌面应用 设置 → 高级 → 模型 API 密钥，写入 `~/.nexgent/credentials.json`（权限 0600），保存后不再显示。

不要把密钥写进项目文件夹或仓库。

### Windows 需要 PowerShell 7

Windows 上任务里的每条命令都经 PowerShell 执行。找不到 PowerShell 7（`pwsh`）时会退回系统自带的 Windows PowerShell 5.1，并提示一次；5.1 不支持 `&&`、`||` 这类写法，命令更容易失败，所以建议装 PowerShell 7。

- 安装：`winget install --id Microsoft.PowerShell`，或从 PowerShell 的 GitHub 发布页下载 MSI。装好后新开的终端里要能直接运行 `pwsh`。
- 检查：`pwsh -NoProfile -Command '$PSVersionTable.PSVersion'` 应显示 7.x。
- 装好后重启 Nexgent。

### 打包（未签名）

先 `pnpm build`，再 `pnpm --filter @nexgent/desktop build`，然后：

```sh
pnpm --filter @nexgent/desktop package:linux   # apps/desktop/release/Nexgent-<版本>-linux-x86_64.AppImage
pnpm --filter @nexgent/desktop package:win     # 在 Windows 上执行，产出 NSIS 安装程序 Nexgent-<版本>-win-x64.exe
```

打包脚本 `apps/desktop/scripts/package.mjs` 先用 `pnpm deploy` 把应用和生产依赖暂存到 `apps/desktop/build/app`，再交给 electron-builder。只想看暂存内容时用 `node apps/desktop/scripts/package.mjs stage`。

- **Linux AppImage**：`chmod +x` 后直接运行。需要 FUSE 2（Ubuntu 22.04 起 `sudo apt install libfuse2`）；没有 FUSE 时加 `--appimage-extract-and-run`。
- **Windows 安装程序**：因为没签名，SmartScreen 会拦，点“更多信息”再点“仍要运行”。默认按用户安装，不需要管理员权限。卸载时数据目录不会删除。

安装包没有签名、没有自动更新、没有应用图标。Windows 安装包和 macOS 安装包还没有验证过。

## 桌面应用怎么用

### 打开项目

开始页可以选一个文件夹，或输入绝对路径新建。项目就是你的一个文件夹，Nexgent 在里面读写文件、运行命令。最近打开过的项目列在开始页和左栏顶部。

### 对话

窗口分两栏：左栏是项目切换、“新对话”和按今天、本周、更早分组的对话；底部是“能力”和“设置”。右边是当前对话。

- 在输入框里用平常的话说想要什么结果。要用文件的话，先点“附件”加进来，输入 `@` 可以引用已有的资料。
- 它在干活时，输入框照样能用：发出去的话下一步就生效，也会转给正在干活的成员。想让它停下就点“停止”，已经写出来的内容会保留。
- 干活的过程折叠成一行（思考、读文件、运行命令……），点开能看每一步。组队时会出现一张“小组进度”卡，列出每个成员的角色和状态；换过分工时会写明原因。点成员旁的“看它的过程”可以只读查看它的对话。
- 想先看计划再动手，用“以计划模式开始”：它先只看不改，给出计划，你批准后才改文件。
- 每段对话可以设一个目标（一句话），完成或放弃都可以标记。

### 资料与成果

- **资料**：加进来的文件会复制到项目数据里，原文件不会被修改。
- **成果**：它完成工作后用成果卡片交给你。可以打开、预览、在文件管理器里显示，也可以“对比上一版”。
- **提修改**：在成果卡片上点“不满意？告诉 Nexgent”，可以打分并写修改意见，它会出新版本。
- 右上角的“资料与成果”抽屉里有这段对话和整个项目的资料、成果、项目文件。

### 批准

写项目外的文件、写敏感文件、运行沙箱外的命令等操作会弹出“需要你的批准”，可以允许一次、在本对话内允许、在本项目内允许，或拒绝。成员请求批准时会写明是哪个成员。

### 撤回

在某条你发的消息上点“撤回之后的文件改动”，可以把这条消息之后 Nexgent 改过的文件恢复成发消息之前的样子。对话记录保留，可以接着聊，别的文件不受影响。太早的轮次没有留下文件快照时不能撤回。

### 能力页

能力页说明 Nexgent 在这个项目里用着什么：

- 开头一两句话：用着几条经验和项目规则；同类任务用哪种分工更顺利、花费多多少（次数还不够时显示“还在比较”）。
- **等你看一眼**：从你的话里看不出是不是“以后都这样”时，会问你要不要当成项目规则。只在有事时出现。
- **项目规则**：你定下的规则和适用范围。
- **已学会**：正在用的经验，每条写明帮上忙几次、带偏几次，可以停用或恢复。
- **改进记录**（折叠）：学习开关与费用。

### 设置

改动立即保存。

| 分组 | 内容 |
| --- | --- |
| 通用 | 外观（跟随系统、浅色、深色）；语言（Nexgent 写给你的经验和说明用哪种语言） |
| 模型 | 模型、先思考再回答、思考深度 |
| 权限 | 文件权限：只读、可写工作区、完全访问 |
| 完成检查 | 没通过时自动再改几次（默认 2 次）；检查命令（例如 `npm test`），每轮改过文件后依次运行 |
| 费用 | 每个任务、每段对话、整个项目的上限（美元，空着就是不限），也可以按 tokens 或请求次数限制 |
| 自动改进 | 每次任务后自己学习的开关；学习预算（默认每个项目 30 天 3 美元） |
| 高级 | 模型 API 密钥、数据位置、以前的改进方式（已关闭的旧机制的预算设置） |

## 命令行

```text
nexgent run --project <dir> --task "<text>" [--sandbox <mode>] [--model <id>] [--json]
nexgent resume <sessionId> --project <dir> [--task "<text>"] [--sandbox <mode>] [--json]
nexgent export <sessionId> --project <dir> [--out <dir>] [--json]
nexgent app [--project <dir>]
```

在仓库里用 `node apps/cli/bin/nexgent.mjs` 代替 `nexgent`。

- `run`：在项目里开一段新对话，做一个任务。标准输出只有回答，过程写在标准错误。
- `resume`：接着一段对话说；不给 `--task` 时就是“从停下的地方继续”。上次被强杀的轮次会先标成中断。
- `export`：把一段对话的记录、账本、资料与成果清单导出到一个目录，密钥会被替换成 `[REDACTED]`。
- `app`：打开桌面应用。
- `--sandbox`：`read-only`、`workspace-write`（默认）、`full-access`。
- `--json`：每个事件一行 JSON，最后一行是结果。

退出码：0 完成；1 没完成（模型或工具出错、费用上限、中断）；2 用法错误；3 环境问题（项目不存在、没有密钥、配置错误、会话被占用）；4 内部错误；130 用户取消；143 被终止。完整参数、事件格式与环境变量见 [apps/cli/README.md](../apps/cli/README.md)。

`nexgent improve` 与 `nexgent improvers` 属于已关闭的旧改进机制（见 [设计理念](design.md#已关闭的机制)），平时用不到。

## 数据放在哪

- **用户数据目录**：默认 `~/.nexgent`（Windows 为 `%USERPROFILE%\.nexgent`），可以用环境变量 `NEXGENT_HOME` 换到别处。
  - `projects/<id>/`：每个项目的对话记录、资料副本、成果、账本和学到的经验，不放在项目文件夹里；
  - `organizations/runs.jsonl`：所有项目共用的分工记录；
  - `credentials.json`：在设置页保存的密钥；
  - `logs/desktop-YYYY-MM-DD.log`：桌面应用日志，保留 14 天，`NEXGENT_LOG_LEVEL=debug` 可看到更多。
- **项目文件夹**里只有 `.nexgent/config.json` 等少量配置。

格式细节见 [数据格式](spec/data-formats.md)。

## 常见问题

- **窗口里只有“界面尚未构建”**：执行 `pnpm --filter @nexgent/desktop build`。
- **提示没有密钥**：设置环境变量后重启，或在设置页填写。
- **命令一直要批准**：在批准框里选“本项目内允许”，会保存成匹配规则，下次同类命令不再问。
- **macOS 上测试会弹出窗口**：desktop 包的界面端到端测试会打开真实窗口（macOS 没有虚拟屏幕），在 Linux 上跑这类测试即可。
