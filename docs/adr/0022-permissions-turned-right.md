# ADR 0022：权限翻正——命令走系统沙箱，项目外路径改为询问，命令策略按 shell 语法解析

- **状态**：已接受
- **日期**：2026-10-16
- **依据**：系统设计审查（资料库 `docs/handoff/system-design-audit.md`）P9、P10、P19、P24–P26、P33 与附录 C1–C4、C6–C10；重做计划 `docs/plan/rework-partition.md` K3；用户 2026-10-16“你自己看着按推荐和想法来，要综合”，授权按审查建议修。
- **替代**：
  - `docs/spec/permissions.md`“沙箱模式”表里 `read-only` 不执行命令、`workspace-write` 命令网络“不限制”的两格；
  - “路径策略”中根外读写一律拒绝；
  - “命令策略”中“按空白与管道分段做前缀匹配”和“一次性进程，输出各保留末尾 64 KiB、完整输出不落盘”；
  - “工具审批·粒度”中命令授权按前缀匹配、“步骤 1 不做会话中途切换”；
  - “已知边界”第 1 条（`bash` / `pwsh` 能读写用户能读写的任何路径）在有系统沙箱的平台上不再成立。

## 背景

现在的路径策略只管文件工具，真正干活的 `bash` 没有边界。`read_file .env` 会弹审批，`bash cat .env` 却静默通过；`bash rm -rf .nexgent/sessions` 能直接执行；`commands.network` 没有代码读取。与此同时，文件工具又收得很窄：项目外路径一律拒绝，模型被拒后理所当然改用 bash。命令策略按符号切分，包一层 `sh -c` 或带上 `git -C` 就能绕过，提交信息里出现“sudo”却会误报；“总是允许”只记第一个词，点一次就放行所有 `rm`。只读模式连 `git status` 都不能跑。安全靠卡死文件工具，结果安全和好用两头都没得到。

成熟做法（审查附录 C 逐条对照过）：Codex 的 `workspace-write` 在 Linux 用 Landlock/bubblewrap、macOS 用 seatbelt，限制子进程只写工作区、网络单独开关；Claude Code 用 bash 语法树拆复合命令逐个匹配规则，项目外路径弹询问并可本会话放行，有计划模式，bash 可以选择走 OS 沙箱（开源库 `@anthropic-ai/sandbox-runtime`）。

## 决策

1. **命令在系统沙箱里跑。**
   - **平台：** macOS 用 seatbelt（`sandbox-exec`），Linux 用 bubblewrap。实现采用 `@anthropic-ai/sandbox-runtime`（Apache-2.0，即 Claude Code 使用的库），版本钉死，不自己写平台沙箱。
   - **写：** 只能写项目目录、会话临时目录和本会话放行的目录。
   - **写保护：** 项目的 `.nexgent/`、`.git/hooks/`、`.git/config` 不可写。
   - **读保护：** `<NEXGENT_HOME>`（凭证、用户数据目录、其他项目的对话）与常见凭证目录（`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.config/gcloud`、`~/.kube`、`~/.docker`、`~/.netrc` 等，清单在代码与规范里）不可读写。
   - **网络：** 按项目配置 `commands.network`，默认开；关时命令没有网络。
   - **只读模式和计划模式**（第 4 条）用同一个沙箱，但只有会话临时目录可写。
   - **`full-access`** 不进沙箱。
   - **违规告知：** 命令触犯沙箱时，工具结果附上被拦的操作，让模型知道原因。
   - **沙箱外重跑：** 模型可以请求“不进沙箱重跑这条命令”（调用参数），这要审批。授权按完整命令记，见第 3 条。
   - **没有系统沙箱的平台**（Windows；Linux 缺 bubblewrap 或 socat，或不允许用户命名空间）：命令照旧在命令策略下运行。会话头记下“没有系统沙箱”和原因，CLI 与桌面各说一次，不声称有沙箱。
   - **配置：** 项目配置 `commands.systemSandbox: 'auto' | 'required' | 'off'`，默认 `auto`。`required` 时没有沙箱就不执行命令；`off` 由用户自己关，界面显示已关。改这个字段要审批，模型不能替自己关。
2. **项目外的路径改为询问。**
   - 文件工具读写项目外的路径时，弹审批（风险中），选项是“仅本次”或“本会话允许这个目录”，读和写分开放行。
   - 本会话放行的目录同时加进命令沙箱的可写目录（只对写放行生效）。
   - 以下位置仍直接拒绝，不询问：`<NEXGENT_HOME>`、第 1 条的凭证目录；写入时还包括系统目录（`/etc`、`/usr`、`/System`、`C:\Windows` 等）。
   - 长期放行仍写项目配置的 `extraReadRoots`，并新增 `extraWriteRoots`。两者都是用户操作，改它们要审批。
3. **命令策略按 shell 语法解析，一套实现。**
   - **解析：** 引号、转义、`;` `&&` `||` `|` `&`、`$( )`、反引号、子 shell、重定向都识别。`sh|bash|zsh -c '…'`、`env`、`nohup`、`time`、`nice`、`xargs`、`command`、`exec` 这类包装逐层展开，取每个简单命令。`git`、`npm`、`pnpm`、`yarn` 先去掉全局选项（`-C <dir>`、`--prefix`、`-w`、`--filter <x>` 等）再取子命令。
   - **匹配：** 规则逐个作用于简单命令，引号里的文字不参与匹配。`$HOME`、`~`、`$TMPDIR` 先展开，再判断“删除项目外内容”。
   - **一套实现：** 授权匹配只有 kernel 里的一套，按词边界、整词比较，workspace 不再自带。
   - **授权记录：** “本会话 / 本项目总是允许”记的是触发审批的那个简单命令的完整词序列（例如 `git push origin main`），不再只记第一个词。
   - **只能“仅本次”的类别：** 提权、删除项目外内容、下载并执行、改系统状态，以及第 1 条的沙箱外重跑。
   - **PowerShell：** 用同一个词法器处理引号和分隔符，规则表照旧按 cmdlet 名。
4. **只读模式能跑只读命令，增加计划模式，会话中途可切换。**
   - **只读命令：** `read-only` 下，一条命令里每个简单命令都在只读命令表里（`ls`、`cat`、`head`、`tail`、`wc`、`rg`、`grep`、不带 `-delete`/`-exec` 的 `find`、`git status|diff|log|show|branch` 的只读形式等，清单在代码与规范里），而且没有写文件的重定向时，命令照常执行（有系统沙箱时在只读沙箱里）。其余命令照旧拒绝，并提示需要切换模式。
   - **计划模式：** 开始会话时可以选（CLI `--plan`，SDK 选项）。行为等同只读模式，另外多一个工具 `exit_plan`：模型把计划交给用户，这个工具每次都要审批；用户批准后，会话切到原定的执行模式。
   - **中途切换：** 宿主可以在会话中途切换模式，会话里写一条 `session.mode` 记录，从下一次工具调用起生效，`resume` 后沿用。模型自己不能切，只能通过 `exit_plan` 的审批。
5. **搜索按 ripgrep 的语义，敏感文件不再静默隐藏。**
   - **`search_text` / `list_files`：**
     - 读 `.gitignore`（与任务快照用同一个解析）；
     - 支持上下文行，输出模式分“内容 / 文件名 / 计数”，可按 `offset` 分页；
     - 大文件流式搜索，不再静默跳过；
     - 读文件并发。
     - 实现仍是 JS，不依赖本机有没有 `rg`，各平台结果一致。
   - **敏感文件：**
     - 模式收窄：`.env.example`、`.env.sample`、`.env.template`、`.env.dist` 不算敏感；去掉 `*.key`；加上 `id_ed25519*`、`id_ecdsa*`、`*.p12`、`*.pfx`。
     - 列表和搜索遇到需要审批的文件时，在结果末尾写明跳过了哪些，不再让它们消失。
6. **shell 可以后台运行，超时杀整个进程树，输出保留头尾。**
   - **后台运行：** `bash` / `pwsh` 加 `run_in_background`，立即返回一个编号。`shell_output` 读新增输出，`shell_kill` 结束它。会话关闭时全部回收，不留进程。
   - **超时与取消：** 照旧杀整个进程树（`ProcessRunner` 的规则不变）。
   - **输出：** 结果最多保留约 30 000 字符，保留开头和结尾、中间写明省略了多少。完整输出写到会话临时目录，路径附在结果里。
7. **Windows 没有 PowerShell 7 时回退到 Windows PowerShell 5.1，并提示一次**（建议装 pwsh 7）。Job Object 启动器兼容 5.1。Windows 不声称有系统沙箱。

## 后果

- 新增运行时依赖 `@anthropic-ai/sandbox-runtime`（钉版本，登记在 `THIRD_PARTY_NOTICES.md`）。Linux 上要有 `bubblewrap` 和 `socat`，否则按第 1 条“没有系统沙箱”处理；macOS 不需要额外安装。
- 契约变化：
  - 项目配置的 `commands.systemSandbox` 与 `extraWriteRoots`；
  - 会话记录 `session.mode`，会话头记沙箱状态；
  - `bash` / `pwsh` 的 `run_in_background` 与沙箱外重跑参数；
  - 新工具 `shell_output`、`shell_kill`、`exit_plan`；
  - `search_text` / `list_files` 的新参数。
  - 契约改动与规范同步由本次修改一并完成，并通知「步骤三契约」。
- 依赖“只读模式不执行命令”“命令授权按前缀”“输出只留尾部”“根外一律拒绝”的测试要改期望，由「测试与 CI」核对清单。
- 系统沙箱不是绝对边界：它挡住项目外的写和凭证目录的读，但挡不住命令读取项目内的敏感文件。项目内的敏感文件靠第 5 条的文件工具审批，命令读它们仍然不问。这一点写进规范的“已知边界”。
