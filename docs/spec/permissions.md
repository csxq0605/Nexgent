# 权限与审批模型

> 字段名以 `packages/kernel/src/contracts/` 为准。现行设计见 [产品与设计定位](../PROJECT_POSITIONING.md)；更早的决定原文在归档仓库 `csxq0605/Nexgent-archive`。

## 目的与范围

定义 Nexgent 在用户机器上能读什么、写什么、跑什么、花多少钱，以及每一项由谁、在何时批准。约束对象是模型通过 `ctx.tools` 发起的调用（文件读写搜索编辑、`bash` / `pwsh`、`run_code`、插件）；宿主自身对 `.nexgent/` 的写入不受本文约束。本文只描述策略，不描述实现；`@nexgent/workspace` 是策略的执行者，`@nexgent/kernel` 的审批代理（broker）是审批的执行者。

## 沙箱模式

三种模式，一次会话只有一个生效值：

| 模式 | 文件读 | 文件写 / 编辑 | `bash` / `pwsh` | 命令内网络 |
| --- | --- | --- | --- | --- |
| `read-only` | 读根内允许；根外询问 | 全部拒绝（不提示） | 只读命令执行（有系统沙箱时在只读沙箱里，只有会话临时目录可写）；其余拒绝，不提示，并提示需要切换模式 | 按 `commands.network` |
| `workspace-write`（默认） | 读根内允许；根外询问 | 写根内允许；`.nexgent/` 内部目录与拒绝模式按下节；根外询问 | 在系统沙箱里执行，只能写项目、会话临时目录与本会话放行的目录；cwd 在项目或已放行的目录内；命令形态黑名单需审批 | 按 `commands.network`（默认开，用宿主网络）；下载并执行类形态需审批 |
| `full-access` | 任意 | 任意，不检查 | 任意 cwd，不进系统沙箱 | 允许，不检查 |

**计划模式**。开始会话时可以选（CLI `nexgent run --plan`，SDK `sessions.create` 的 `plan: true`）。行为等同 `read-only`，另外多一个工具 `exit_plan`（输入 `{ plan }`，`approval: 'always'`，审批详情就是计划全文）：用户批准后，会话切到原定的执行模式（会话头的 `sandboxMode`）并写一条 `session.mode` 记录（`reason: 'plan-approved'`），`exit_plan` 随即从工具列表消失。模型不能自己切模式，只能经 `exit_plan` 的审批。

- 模式只约束**工具层**，`read-only` 的"拒绝"是工具返回结构化错误 `SANDBOX_DENIED { mode, path | command }`，模型可据此换方案或请求用户切换模式；不会弹审批。
- 模式设置与优先级（高者胜）：
  1. CLI 参数 `--sandbox <read-only|workspace-write|full-access>`（`run` / `resume` / `app` 均接受）；
  2. 项目配置 `.nexgent/config.json` 的 `sandboxMode` 字段；
  3. 默认 `workspace-write`。
- 生效值在会话创建时写入会话头（`sandboxMode` 字段，见 `data-formats.md`），`resume` 时沿用会话头与其后最近一条 `session.mode` 的值，除非再次传 `--sandbox`。
- **中途切换**：宿主经 SDK `sessions.setMode({ sandboxMode?, plan? })` 在会话中途切换模式或计划模式，会话写一条 `session.mode` 记录（`reason: 'host'`），从下一次工具调用起生效，`resume` 后沿用。
- 非法值在装载时报错退出，不回落到默认值。
- `full-access` 启动时在 CLI 与桌面应用各打印一行警告，并在系统提示里告知模型。

## 路径策略与写入限制

**根目录。**

| 类别 | 内容 | 来源 |
| --- | --- | --- |
| 读根 | 项目目录（`--project`，realpath 后）；加 `.nexgent/config.json` 的 `extraReadRoots: string[]`（绝对路径） | 项目配置；CLI 不加 |
| 写根 | 项目目录；加 `extraWriteRoots: string[]`（绝对路径）；再减去下面的宿主专属目录与拒绝模式 | 项目配置，改它要审批 |
| 本会话放行的目录 | 用户在“项目外路径”审批里选“本会话允许这个目录”的目录，读与写分开放行（授权 `fs.read` / `fs.write`，模式 `<目录>/**`） | `approval.grant` 记录 |
| 临时目录 | `os.tmpdir()` 下的 `nexgent-<sessionId>/`，会话结束删除 | 宿主创建，可读写 |

**`.nexgent/` 内部。**

| 子目录 | 工具读 | 工具写 | 说明 |
| --- | --- | --- | --- |
| `sessions/`、`ledgers/`、`capabilities/`、`snapshots/`、`improvements/`、`improvers/`、`handbook/`、`evaluations/`、`learning/` | 拒绝 | 拒绝 | 只有宿主写；模型不能改自己的历史、账本、能力版本和任务快照。`improvements/`、`improvers/` 是已删除功能留在旧项目里的数据，仍保持拒绝；`handbook/`、`evaluations/`、`learning/` 是尚未迁移的项目的项目级手册、自评与学习队列。草稿组件经 `capability_draft` 由宿主代写 |
| `materials/` | 允许 | 拒绝 | 用户提供的资料，由宿主（`@nexgent/tasking`）复制写入；模型只读，原文件与副本都不被模型修改 |
| `outputs/` | 允许 | 拒绝 | 成果快照，只由宿主（`@nexgent/tasking`）在 `present` 时写；模型不能改任何版本的快照。模型把成果写在项目里，再用 `present` 交付 |
| `skills/` | 允许 | 拒绝 | 项目技能，由用户维护；`load_skill` 经宿主读取 |
| `config.json` | 允许 | 拒绝 | 配置改动必须经用户或审批流 |

**项目外的路径**。文件工具（`read_file`、`write_file`、`str_replace`、`list_files`、`search_text`，以及 `read_document`、表格工具、`run_code` 的宿主函数）读写读根 / 写根之外的路径时不再直接拒绝，而是弹审批：风险中，选项“仅本次”或“本会话允许这个目录”（`options: ['once', 'session']`），模式为该文件所在目录（或该目录本身）加 `/**`。读和写分开放行：读的授权名是 `fs.read`，写的是 `fs.write`（`ToolApprovalAsk.grantTool`），所以一次“本会话允许”对所有文件工具都生效，读的放行不放行写。本会话放行写的目录同时加进命令沙箱的可写目录。以下位置仍直接拒绝，不询问：
- `<NEXGENT_HOME>` 整个目录（用户数据目录里本项目的 `materials/`、`outputs/` 只读例外，见下）；
- 凭证目录（`PROTECTED_HOME_ENTRIES`，相对用户主目录）：`.ssh`、`.aws`、`.gnupg`、`.config/gcloud`、`.kube`、`.docker`、`.netrc`、`.npmrc`、`.pypirc`、`.git-credentials`、`.config/gh`、`.azure`、`.password-store`；
- 写入时还有系统目录（`systemWriteDenied`：`/etc`、`/usr`、`/bin`、`/sbin`、`/System`、`/Library`、`C:\Windows`、`C:\Program Files` 等）；
- 经符号链接从项目内逃到外面的路径（`symlink-escape`）照旧拒绝。
长期放行写项目配置的 `extraReadRoots` / `extraWriteRoots`，两者都是用户操作，改它们要审批（`GUARDED_PROJECT_CONFIG_FIELDS`）。

**Nexgent 主目录**（`<NEXGENT_HOME>`，默认 `~/.nexgent`）放凭证、用户级配置 `config.json`。它在每个项目之外，不在任何读根或写根里，文件工具与 `run_code` 读写都拒绝（路径规范化后的包含检查即可挡住），只有宿主写；用户把某个项目放在主目录之内或把主目录列进 `extraReadRoots` 时，这些路径仍按宿主专属目录处理，读写都拒绝。

**用户数据目录**：`<NEXGENT_HOME>/projects/<projectId>/`（会话、账本、快照、资料副本、成果快照、能力记录、授权 `grants.json`、自评）与 `<NEXGENT_HOME>/handbook/` 同属主目录，规则同上：文件工具与 `run_code` 读写都拒绝，只有宿主写。资料副本与成果快照对模型只读：数据目录的 `materials/` 与 `outputs/` 加为文件工具的只读根（写入照样拒绝），模型按资料给出的绝对路径读取，和迁移前读 `.nexgent/materials/` 一样；目前没有专门读资料的宿主工具，大文件与二进制资料只能这样读。数据目录里的其他内容读写都拒绝。迁移没完成的项目，上表的项目内规则照旧适用。“在本项目始终允许”的授权迁移后在 `grants.json`，项目里的 `config.json` 不再有 `approvals`，所以克隆来的项目不带别人的授权。

**编辑工具**（契约 `edit-tools.ts`，输入 schema `WRITE_FILE_INPUT_SCHEMA`、`STR_REPLACE_INPUT_SCHEMA`）。路径检查与上面相同，改动照旧进入本轮的文件变更与成果：

- `write_file` 可以写新文件；已有文件只有在本会话读过它（`read_file` 读过，或本会话写过），或调用给出 `overwrite: true` 时才覆盖（`mayWriteFile`），否则报错并提示先读。还要求文件自本会话上次读或写之后没有变过（按修改时间与大小比较，会话内记录）：别的成员或命令改过它时报 `tool/failed`（`details.reason: "changed"`），提示重新读取后合并，或给 `overwrite: true` 照样覆盖。`str_replace` 每次按当时的文件内容匹配，不受影响。
- `str_replace` 接受单个 `old_str` / `new_str`（加 `replace_all` 替换全部出现），或 `edits` 列表（至多 50 个，`MAX_TEXT_EDITS`），两种形式不能同时给。多个编辑按顺序作用在前一个的结果上，全部成功才写文件（`applyTextEdits`）；`old_str` 为空、找不到、或没有 `replace_all` 时出现多次，报出失败的那一个编辑的序号。
- `read_file` 的输出每行带行号（右对齐 6 列加制表符，同 `cat -n`；`numberLines`）；行号不是文件内容，`str_replace` 匹配制表符之后的文字。

**拒绝与审批模式**（在写根内也生效）：

| 模式 | 读 | 写 |
| --- | --- | --- |
| `.git/**` | 允许 | 拒绝（`git` 命令不在此列，由命令策略管） |
| `node_modules/**`、`.pnpm-store/**` | 允许 | 拒绝；要改依赖走包管理命令并审批 |
| `.env`、`.env.*`、`*.pem`、`id_rsa*`、`id_ed25519*`、`id_ecdsa*`、`*.p12`、`*.pfx`、`.npmrc`、`.netrc` | 审批 | 审批 |
| 其他以 `.` 开头的文件 / 目录 | 允许 | 允许 |

**规范化**（每次调用、在检查前执行，一次）：

1. 相对路径以项目目录为基解析；`path.resolve` 消去 `.`、`..`。
2. 取已存在的最长祖先做 `realpath`，把不存在的尾段按字面拼回；对结果做包含检查（根本身或根加分隔符的前缀）。文件工具在写入前**再做一次**同样的解析，用第二次的结果打开文件，缩小 resolve 到写入之间的符号链接竞争窗口。
3. 目标自身是符号链接时，按链接指向的真实位置判定；写入会跟随链接，因此指向根外的链接被拒绝。
4. Windows：比较前统一为小写并把 `/` 换成 `\`；去掉 `\\?\` 前缀后再比较；盘符必须与根一致；UNC 路径（`\\server\share\...`）只有在项目目录本身是 UNC 时才允许，且 share 必须相同；设备名（`CON`、`NUL`、`COM1` 等）作为文件名拒绝；8.3 短名靠 realpath 展开。
5. 路径长度：解析后超过 4096 个字符拒绝；Windows 超过 260 字符的路径交给 Node 的长路径支持处理，不做额外限制。
6. 所有检查用解析后的绝对路径记录在错误与账本里，不记录模型给的原始拼法以外的内容。

**搜索**。`list_files` 与 `search_text` 读 `.gitignore`（与任务快照同一个解析器；`includeIgnored: true` 时不读），`search_text` 支持输出模式（内容 / 文件名 / 计数）、上下文行（`before` / `after` / `context`）、多行匹配、`limit` / `offset` 分页，大文件流式搜索，不再静默跳过。遇到需要审批的敏感文件，结果末尾写明跳过了哪些（`[sensitive: not read without approval]`），不再让它们消失。实现是 JS，不依赖本机 `rg`。搜索项目外的目录按上面的“项目外的路径”询问一次，放行后在该目录下搜。

**Windows：先路径策略，后 ACL**。路径策略只在文件工具中生效，对 `pwsh` 启动的进程没有约束力。后补的 ACL 隔离（参考 DSH `sandbox-windows-acl` 的受限令牌方案）会增加：子进程及其后代的写入与删除被限制在项目目录与会话临时目录；受限令牌在 `read-only` 下无任何写授权；失败时不以非受限方式启动。ACL 不能补上的：硬链接别名、读取不受限、被其他 AppContainer 工具加过 ACL 的目录不可读。

## 命令策略

工具：Linux / macOS 为 `bash`（`bash -c <command>`，不是登录 shell），Windows 为 `pwsh`（`pwsh -NoProfile -NonInteractive -Command <command>`；没有 PowerShell 7 时回退到 Windows PowerShell 5.1 `powershell.exe`，并提示一次建议安装 pwsh 7）。两者都是一次性进程，不保留 shell 状态。

| 规则 | `read-only` / 计划模式 | `workspace-write` | `full-access` |
| --- | --- | --- | --- |
| 是否执行 | 只读命令执行，其余拒绝 | 是 | 是 |
| 系统沙箱 | 有：只读，只有会话临时目录可写 | 有：见下节 | 不进 |
| cwd | 项目目录内 | 项目目录或已放行的写目录内（按路径策略解析），默认项目目录 | 任意 |
| 超时 | 每次调用 `timeoutMs`，默认 120 000，上限 600 000；超出上限按上限；后台运行时不给就没有 | 同左 | 同左 |
| 形态黑名单 | — | 命中则审批 | 只有“始终审批”表 |
| 网络 | 按 `commands.network` | 按 `commands.network` | 不限制 |

**只读命令**。一条命令里每个简单命令都在只读命令表里，而且没有写文件的重定向（`> file`、`>> file`；`2>&1` 与 `> /dev/null` 不算）时，算只读命令。表（POSIX）：`ls`、`cat`、`head`、`tail`、`wc`、`rg`、`grep`、`pwd`、`echo`、`printf`、`which`、`du`、`df`、`file`、`stat`、`tree`、`sort`、`uniq`、`cut`、`tr`、`jq`、`diff`、`basename`、`dirname`、`realpath`、`env`、`date`、`uname`、`ps` 等；`find` 不带 `-delete` / `-exec` / `-ok` / `-fprint*`；`sed` 只限不带 `-i`、`w` 命令与脚本文件的打印类脚本；`awk` 不带 `system`、`getline`、重定向与管道写出；`sort` 不带 `-o`；`git` 只限 `status`、`diff`、`log`、`show`、`branch`（不带改动选项）、`rev-parse`、`ls-files`、`blame` 等读的子命令；常见程序的 `--version`。PowerShell 有对应的 cmdlet 表（`Get-ChildItem`、`Get-Content`、`Select-String` 等）。清单在 `packages/workspace/src/command-policy.ts`。

**系统沙箱**。`workspace-write`、`read-only` 与计划模式下，`bash` 在系统沙箱里运行：macOS 用 seatbelt（`sandbox-exec`），Linux 用 bubblewrap（需要 `bwrap` 与 `socat`）；实现是 `@anthropic-ai/sandbox-runtime`（Apache-2.0，钉版本 0.0.80）。
- 只能写：项目目录、会话临时目录、`extraWriteRoots`、本会话放行写的目录；`read-only` / 计划模式只能写会话临时目录。
- 写保护：项目的 `.nexgent/`、`.git/hooks/`、`.git/config`。
- 读写都不行：`<NEXGENT_HOME>`（本项目的资料 `materials/` 与成果 `outputs/` 可读，不可写）与上面的凭证目录。
- 网络：`commands.network` 为 `true`（默认）时命令用宿主网络，不经代理；为 `false` 时命令在新的网络命名空间里，没有网络。
- 命令触犯沙箱失败时，工具结果附上被拦的操作与一句说明（`<sandbox_violations>`），让模型知道原因。
- 不进沙箱重跑：调用参数 `sandbox: false`，每次都要审批（风险高，只给“仅本次”）。
- Linux 上库为网络桥常驻的 `socat` 经 `setpriv --pdeathsig KILL` 启动，宿主进程被强杀时随之结束（没有 `setpriv` 时用库的默认方式）。
- 没有系统沙箱的平台（Windows；Linux 缺 bubblewrap 或 socat，或不允许用户命名空间）：命令照旧只在命令策略下运行。会话头 `commandSandbox` 记下 `{ kind: 'none', reason }`，CLI 打一行说明、桌面在输入框旁显示“命令未进系统沙箱”，不声称有沙箱。
- 项目配置 `commands.systemSandbox: 'auto' | 'required' | 'off'`，默认 `auto`。`required` 时没有沙箱就不执行命令；`off` 由用户自己关，会话头记 `{ kind: 'off' }`，界面显示“系统沙箱已关闭”。改这个字段要审批（`commands` 在 `GUARDED_PROJECT_CONFIG_FIELDS` 里）。

**后台运行**。`bash` / `pwsh` 的 `run_in_background: true` 立即返回一个编号；`shell_output({ id })` 读新增输出与是否还在运行 / 退出码，`shell_kill({ id })` 结束它和它启动的一切。会话关闭时全部回收，宿主退出时也回收，不留进程。

**进程树终止。** 超时或用户取消时：POSIX 子进程以独立进程组启动（`detached: true`），先对进程组发 `SIGTERM`，等 `graceMs`（默认 5 000）后发 `SIGKILL`；Windows 优先用 Job Object（`KILL_ON_JOB_CLOSE`，参考 DSH `win32-process` 的方式），不可用时退回 `taskkill /T /F /PID`。终止后必须等到进程组 / Job 为空再返回工具结果，结果带 `terminated: 'timeout' | 'cancel'`。

**环境清洗。** 子进程环境从宿主环境复制后删除：`NEXGENT_*`、名字以 `_API_KEY`、`_TOKEN`、`_SECRET`、`_PASSWORD` 结尾的变量、`AWS_*`、`AZURE_*`、`GOOGLE_APPLICATION_CREDENTIALS`；再叠加 `TMP` / `TEMP` / `TMPDIR` 指向会话临时目录。工具调用显式传入的 `env` 在清洗之后合并，因此模型不能靠传 `env` 拿回密钥（密钥值不在模型可见范围内）。`PATH` 保留。

**输出上限**。交给模型的结果最多约 30 000 字符（`MODEL_OUTPUT_CHARS`），超出时保留开头和结尾，中间写明省略了多少；完整输出写到会话临时目录，路径附在结果里。结果在进入会话与账本前经过密钥脱敏（见"密钥存放"）。

**解析**。命令按 shell 语法解析：引号、转义、`;` `&&` `||` `|` `&`、`$( )`、反引号、子 shell、重定向都识别；`sh|bash|zsh -c '…'`、`env`、`nohup`、`time`、`nice`、`timeout`、`xargs`、`command`、`exec` 这类包装逐层展开，取出每个简单命令；`git`、`npm`、`pnpm`、`yarn` 先去掉全局选项（`-C <dir>`、`--prefix`、`-w`、`--filter <x>` 等）再取子命令。规则逐个作用于简单命令，引号里的文字不参与匹配（提交信息里写“sudo”不会误报）。`$HOME`、`~`、`$TMPDIR` 先展开，再判断“删除项目外内容”。脚本自己赋值的变量（`d="$TMPDIR/x"; rm -rf "$d"`）在赋值之后也展开，条件是：顶层的 `NAME=值`、值完全可知且不含空白、`~` 与通配符、全脚本只写一次、脚本里没有别的改变量的写法（`read`、`for NAME`、`eval`、`source`、`${NAME:=}` 等）；这时按赋值后的值和空串（赋值没执行时）各判一次，两次都通过才不问。PowerShell 用同一个词法器处理引号与分隔符，规则表照旧按 cmdlet 名。

**形态黑名单**（`workspace-write` 下命中即触发审批，审批通过后才执行）：

| 类别 | 形态举例 |
| --- | --- |
| 安装包 | `npm\|pnpm\|yarn\|pip\|pip3\|uv\|cargo\|go install`、`apt\|apt-get\|brew\|choco\|winget\|scoop install` |
| 推送 / 发布 | `git push`、`git remote add`、`npm publish`、`gh pr merge` |
| 删除根外内容 | `rm -r*`、`Remove-Item -Recurse` 且参数解析为项目、会话临时目录与已放行写目录之外的路径，或 `/`、`~`、盘符根 |
| 删除项目 | 删除项目目录本身，或项目的 `.nexgent/`、`.git/`（任何模式都问） |
| 丢弃改动 | `git clean`、`git reset --hard`、`git checkout --`、`git restore`、`git stash drop` 这类丢弃未提交改动或历史的形态 |
| 提权 | `sudo`、`su`、`doas`、`runas`、`Start-Process -Verb RunAs` |
| 下载并执行 | `curl\|wget\|Invoke-WebRequest ... \| sh\|bash\|pwsh\|iex`、`Invoke-Expression`、`eval "$(curl ...)"` |
| 改系统状态 | `systemctl`、`sc.exe`、`reg add`、`Set-ExecutionPolicy`、`chmod -R` / `chown -R` 作用于项目外 |

黑名单不是安全边界，只是把高风险形态交给用户决定；有系统沙箱时，文件与网络的边界由沙箱给出。绕过方式（如 base64 解码后执行）不在黑名单的拦截范围内，见"已知边界"。

提权、删除项目外内容、删除项目、下载并执行、改系统状态五类，以及“不进沙箱重跑”，审批只给“仅本次”；其他类别可以选本会话 / 本项目。

## 工具审批

每个工具注册时声明 `approval: 'never' | 'ask' | 'always'`（`always` 每次都问，对应“始终审批”表）；策略层可把单次调用提升为 `ask`（命中形态黑名单、敏感文件模式）或 `deny`（模式不允许）。三种模式下的行为：

| 模式 | `approval: 'never'` 工具 | `approval: 'ask'` 工具 / 被提升的调用 | 被模式禁止的调用 |
| --- | --- | --- | --- |
| `read-only` | 读类执行；写 / 执行类（`effects` 含 `write` 或 `execute`）直接拒绝，不提示。例外：声明 `selfSandboxed: true` 的工具（现在只有 `run_code`）照常执行，由工具对每次读写按会话模式自行检查 | 写 / 执行类直接拒绝，不提示；读类弹审批 | 拒绝，不提示 |
| `workspace-write` | 执行 | 弹审批 | 拒绝，不提示 |
| `full-access` | 执行 | 执行，不提示；例外是"始终审批"表 | — |

**并发**（`isConcurrentTool`、`scheduleToolCalls`）。一个模型步骤里的多个工具调用，按调用顺序切成批：连续的可并发调用是一批，同时运行（一批最多 `MAX_CONCURRENT_CALLS` = 8 个同时跑，其中 `delegate` 最多 `maxConcurrentMembers` = 4 个）；其他调用各自一批，依次运行。可并发要工具自己声明 `concurrent: true` 且 `approval: 'never'`（现有：`read_file`、`list_files`、`search_text`、`read_document`、`read_spreadsheet`、`web_fetch`、`delegate`、`read_thread`、`list_threads`、`handbook_mark`）；只声明 `read` 效果但有状态的工具（`present`、待办、工作流等）不声明就串行。本次需要预先审批（`approval` 为 `always`，或模式要求询问）的调用永不并发。并发调用在执行中提出的审批问题（如读项目外路径）排队一个一个问，前一个问题给的本会话授权会直接答复后面同类问题。结果按调用顺序交回模型，`tool.result` 与账本 `tool.call` 按调用顺序写；执行中写的审批记录与工具记录（如 `subagent.start`）按发生顺序写，各自带 `toolCallId`。

`read-only` 下“始终审批”表里的写 / 执行类调用同样直接拒绝。`selfSandboxed` 是 `ToolDefinition` 的契约字段（`contracts/tools.ts`），只有确实对每次读写调用做沙箱与路径检查的宿主包才能声明；策略层按字段判断，不按工具名豁免。

"始终审批"表（任何模式都问）：`sudo` 类提权、删除项目目录本身、写入 `.nexgent/config.json` 的下列字段（契约 `GUARDED_PROJECT_CONFIG_FIELDS`）：`approvals`、`costCaps`、`sandboxMode`、`learning`、`maxStepsPerTurn`、`checkRetries`、`checkCommands`、`extraReadRoots`、`extraWriteRoots`、`commands`；模型不能放宽自己的权限、预算与学习设置。还有插件试用（下节）。这些字段用户在设置页（SDK `settings.update`）改是用户操作，不弹审批；上下文策略的封闭 schema 没有它们，能力组件改不到。

**粒度。** 用户每次应答选择作用范围：

- `once`：只放行本次调用；
- `session`：本会话内相同工具 + 相同匹配模式不再问，记录在会话中（`approval.grant` 记录），`resume` 后仍有效；
- `project`：写入 `.nexgent/config.json` 的 `approvals` 列表（迁移后写用户数据目录的 `grants.json`），之后所有会话生效。

```json
{
  "approvals": [
    { "tool": "bash", "pattern": "pnpm install", "grantedAt": "2026-10-07T08:00:00Z" },
    { "tool": "fs.write", "pattern": ".env.local", "grantedAt": "2026-10-07T08:05:00Z" }
  ]
}
```

`pattern` 对命令是触发审批的那个简单命令的完整词序列，匹配按整词比较：脚本里每个简单命令都要与某条授权的词序列相同才放行，`git push` 的授权不放行 `git push --force`；对路径是项目相对路径（项目外为绝对路径）的 glob，`<目录>/**` 也覆盖该目录本身。授权匹配只有 kernel 一套实现（`grantMatches`），workspace 不再自带。授权的工具名一般是工具名；项目外目录的授权用 `fs.read` / `fs.write`，对所有文件工具通用（`ToolApprovalAsk.grantTool`）。没有 `pattern` 的条目放行该工具的所有调用，CLI 与桌面应用都只在用户显式选择时才写无 `pattern` 的条目。

**记录。** 账本的 `tool.call` 记录带 `approval` 字段（契约 `ToolCallApproval`）：`{ required: boolean, decision: 'allow' | 'deny' | 'timeout' | 'cancel' | 'auto', scope?: 'once' | 'session' | 'project', requestId?: string }`；`auto` 表示命中已有授权。会话里写同一事实的 `approval.request` / `approval.decision` 两条记录，字段与 `ApprovalRequest` / `ApprovalDecision` 一致。审批 UI 的呈现不进入会话。

**超时。** 没有应答即拒绝（`decision: 'timeout'`）。CLI 在 TTY 下等 300 s（`approvalTimeoutMs`），非 TTY（CI、`nexgent run` 被重定向）直接拒绝且不阻塞；桌面应用等到用户应答或轮次被取消。拒绝后工具返回错误 `approval/denied`，模型可以换方案，但同一轮内对同一调用再次请求审批会被策略层直接拒绝，不再弹窗。

## 插件安装审批

插件组件（`plugin`）是在宿主进程内装载的代码，不在沙箱里。只有试用时问一次，任何沙箱模式下都问（`read-only` 下也问，因为装载本身不写项目）：`capability_try` 装载 `plugin` 草稿之前，以“始终审批”类请求询问（`risk: high`，选项只有 `once`），对话框显示 `plugin.json` 的 `description`、`permissions` 与将注册的工具名。拒绝则该调用返回 `approval/denied`，插件不装载。

规则：

- **每次都问**：没有 `session` / `project` 范围的插件授权，也不写进 `approvals` 列表；同一插件的新版本再问。
- 允许试用**不改变**会话的沙箱模式、路径策略、命令策略或任何已有授权；插件注册的工具照常走工具审批。
- 成员看不到 `capability_*` 工具，不能试用插件。
- 其他组件（技能、函数模块、上下文策略、预设、团队模板、架构图）不需审批。

## 能力包组件的执行边界

组件只能在下表的边界内起作用，组件不能借自己放宽权限（H13）：

| 组件 | 在哪执行 | 边界 |
| --- | --- | --- |
| `function-module` | 与 `run_code` 同类的隔离 Node 子进程，每次调用一个 | 工具声明 `effects: ['execute', ...函数声明的 effects]`、`approval: 'never'`、`selfSandboxed: true`；文件访问只经宿主函数，每次按调用方会话的沙箱模式与路径策略检查；环境变量为空；时长与输出上限同 PTC；`network` 效果只经宿主提供的 `web_fetch` 等价函数 |
| `plugin` | 宿主进程内 | 只经上节的试用审批装载，且不会被采用；注册的工具走正常工具审批；卸载时注销它注册的全部工具与钩子 |
| `skill` | 不执行代码 | 只作为技能文本进入模型上下文 |
| `context-policy` | 不执行代码 | 封闭 schema，只有 `instructions`、`personaSuffix`、`compaction`；没有权限、费用、沙箱字段 |
| `preset` | 不执行代码 | 只能收窄（§子会话继承） |
| `team-template`、`architecture` | 不执行代码 | 旧包里的文件格式，只作数据；成员仍受 §子会话继承约束 |

其他边界：

- `.nexgent/capabilities/`（含草稿区）与 `.nexgent/snapshots/` 对模型的文件工具、`bash` 写入、`run_code` 与函数模块的宿主函数都拒绝读写；草稿只经 `capability_draft` 写。

## 学习与学习预算

后台学习（自评、外部评审校准、反思、整理）由宿主在任务结束后打开，用户没有发消息，所以：

- **先告知，再花钱。** 用户第一次确认后台学习的说明（用户级 `learning.noticeAcknowledgedAt`，SDK `learning.acknowledge`）之前，任何项目的后台学习都不花钱；确认之后，项目的 `learning.enabled` 决定（`mayLearn`）。确定性检查不花模型费用，学习开着就做。
- **学习预算。** `learning.budget`（默认每项目 30 天 3 美元）按带 `learningPhase` 的账本记录的估算美元在滚动时间窗内计，含自评与校准；单个任务的自评另有 `learning.selfEvalMaxUsd`（默认 0.05 美元）。宿主在每次学习请求前检查，余额不够一个任务上限时不再打分（自评记 `budget-exhausted`）。学习费用不计入任何用户任务的 `perTask` / `perConversation`，但计入 `perProject`。
- **评分器不可靠时收紧。** 自评与外部评审的一致率不足（少于 10 次校准或低于 80%）时，评分器记为不可靠；手册条目照常试用（`data-formats.md` §自评）。
- **共享由项目决定。** `learning.useShared` 关掉后本项目不使用用户级手册条目；`learning.contribute` 关掉后本项目的条目不进用户级。
- **开关与预算只由用户改。** `learning` 在“始终审批”表里。用户级配置在主目录里，文件工具够不到。手册与自评都在主目录里，模型读写都拒绝；执行中的模型只能经 `handbook_mark` 给注入的条目投票。

## 费用上限

配置在 `.nexgent/config.json`：

```json
{
  "costCaps": {
    "perTask":    { "maxRequests": 200,  "maxTokens": 2000000 },
    "perProject": { "maxRequests": 5000, "maxTokens": 50000000, "windowDays": 30 }
  }
}
```

- `maxRequests` 计模型请求次数（含失败），`maxTokens` 计 `inputTokens + outputTokens`；用量 `unknown` 的请求只计次数。
- `perTask` 以一次 `run` / 一次 `resume` 为单位；`perProject` 以账本在 `windowDays` 内的记录累加。
- 任一上限达到时：下一次模型请求不再发出，当前轮次以 `turn.end { kind: 'cancelled', cause: 'cost-cap' }` 结束；会话先写一条 `error` 记录（`fatal: false`），账本写 `task.outcome`，二者的错误 `code` 都是 `budget/exhausted`，`ErrorInfo.details` 带 `{ scope: 'task' | 'project', metric: 'requests' | 'tokens', used, limit }`；不重试、不自动续跑。
- `perTask` 按整棵任务树计（根会话与它的全部成员共享同一 `taskId` 与同一份累计），成员花的请求与 token 算进根会话的额度；成员的下一次请求被挡下时，成员以 `budget` 结束，父会话下一次请求同样被挡下。`ErrorInfo.details.scope` 仍为 `task`。见下节。
- 字段缺省表示不限制。
- **美元为主，三个范围，80% 提醒。** `CostCap.maxUsd` 按价目表估算美元（含缓存读写；provider 没报用量时用宿主的估算，记 `usageEstimated` 并在提醒里标明含估算）。范围加 `perConversation`（一个对话的全部轮），与 `perTask`（整棵任务树）、`perProject`（时间窗）并列；几个字段同时给出时先达到的生效。任一上限的任一字段达到 80%（`COST_WARNING_RATIO`）时，账本写一条 `cost.warning`（每个上限实例一次），SDK 推送 `cost.warning` 事件，界面提示用户；达到 100% 时再写一条 `level: "reached"`，然后按上面的规则取消本轮。`ErrorInfo.details.scope` 相应为 `task` / `conversation` / `project`，`metric` 加 `usd`。只有 token / 次数字段的旧配置照常执行。

## 子会话继承

成员（委派对象、工作流节点；讨论串的成员同理）各是一个子会话，由根会话经工具建出。成员相对父会话只能收窄，不能放宽：

| 项 | 规则 |
| --- | --- |
| 深度 | 只有根会话（含讨论串）能启动成员；成员看不到 `delegate`、`workflow`、`organize`、`start_thread`、`message_thread`、`read_thread`、`list_threads`、`update_project_notes`、`capability_draft`、`capability_try`（契约 `MEMBER_DENIED_TOOLS`：协作工具加能力工具，成员不能再启动成员，也不能起草或试用能力组件），kernel 拒绝以子会话为父会话创建子会话 |
| 沙箱 | 成员的模式取父会话、预设、显式请求三者中最窄的；任何一项宽于父会话时创建失败，错误码 `sandbox/denied`，不悄悄降级（`childSandboxMode`）。顺序：`read-only` < `workspace-write` < `full-access` |
| 工具范围 | 预设的 `tools`（`allow` / `deny`）用成员作用域上的 `restrict()` 实现，与父会话可见的集合求交；`MEMBER_DENIED_TOOLS` 总是叠加在上面 |
| 路径与命令 | 与父会话相同的路径策略、命令策略和 `extraReadRoots`。可写的成员在自己的项目副本里工作（`data-formats.md` §子会话与成员“成员的工作副本”）：副本取代项目根成为它的读写根与命令的可写根，项目本身只读（讨论串里的成员从讨论串的副本复制、合回讨论串的副本）；`read-only` 成员和放不下副本的项目照旧共用项目根。成员改项目（合回，或共用项目根时可能改项目的工具调用）都先等根轮快照完成。所有会话都能读 `<系统临时目录>/nexgent-workdirs/`（成员副本与冲突副本） |
| 审批 | 与主对话同一套规则：主对话会问的，成员也问；成员的请求进同一个审批代理，`ApprovalRequest.sessionId` 为成员会话，`member` 带成员名、形态与根会话 id，宿主据此在根会话的界面里询问并写明是哪个成员；`session` 授权只对授予它的那个会话生效，`project` 授权对所有会话（含成员）生效；项目审批设置放宽时主对话与成员一起生效；成员不单独自动批准，也不单独自动拒绝；没有应答者或非 TTY 时与主对话一样按 `timeout` / `headless` 拒绝 |
| 费用 | `perTask` 按任务树计（上节）；`BudgetShare` 只能再压低某个成员的份额；`perProject` 照旧按账本 |
| 取消 | 父会话的轮次被取消或结束时，仍在运行的成员以 `parent` 原因取消，在 `toolAbortGraceMs` 内收尾；成员的子进程与主对话的一样按进程树终止，不得残留 |
| 并发 | 同一任务树同时运行的成员至多 4 个，总数至多 16 个（`COLLABORATION_LIMITS`） |
| 账本 | 成员的每条记录带同一 `taskId`、自己的 `memberId`（会话 id）与 `executionForm` |

成员在 `read-only` 父会话下调用 `present` 照常可用（快照由宿主写）。

**项目的总对话（协调者）只派活。** 总对话自己不干活。它的作用域上用 `limitEffects(COORDINATOR_TOOL_EFFECTS)`（`['read', 'network']`）只留效果全在这两类里的工具（读文件、搜索、网页、讨论串工具、`update_project_notes`、`present`），再遮掉 `organize`、`delegate`、`workflow`（`COORDINATOR_DENIED_TOOLS`）：每一块活都交给讨论串，讨论串自己派成员。`write_file`、`str_replace`、`bash`、`run_code` 等写或执行的工具既不出现在它的请求里，调用也报 `tool/not-found`。这个限制只作用于总对话自己：讨论串（各自是根会话，在自己的项目副本里工作）照常拿到写、执行和派成员的工具，它们的成员再按上表收窄。

## 网页获取（`web_fetch`）

由 `@nexgent/web` 提供，名字、`effects: ['network']` 与 `approval: 'never'` 冻结在契约 `STEP3_MIGRATED_TOOLS`，参数 schema 归实现包。

- 只做 HTTP / HTTPS GET；响应体有大小上限，HTML 转 Markdown 后分页返回；不带 Cookie，不带任何凭证，不读环境变量里的代理凭证。
- **SSRF 防护**：先解析主机名，再按解析出的**每个 IP** 判定；拒绝回环（`127.0.0.0/8`、`::1`）、私网（`10/8`、`172.16/12`、`192.168/16`、`fc00::/7`）、链路本地（`169.254/16`，含云元数据 `169.254.169.254`、`fe80::/10`）、未指定地址（`0.0.0.0`、`::`）与 IPv4 映射的上述地址；连接时使用已判定的 IP，防止 DNS 重绑定。每一跳重定向重新判定，跳数有上限。被拒时返回工具错误，说明是哪条规则，不发出请求。
- 三种沙箱模式下都可用（不写文件、不执行命令）；它是唯一一个由工具层主动联网的入口，`bash` 的网络规则不变。

## 代码执行进程（PTC）

`run_code`（`@nexgent/ptc`）与 `workflow` 的脚本在独立的 Node 子进程里执行：

- 每次调用一个新进程；环境变量为空（不继承宿主环境，因此读不到 `NEXGENT_API_KEY` 等任何变量）；cwd 为项目根。
- 文件访问只经宿主函数（IPC 绑定），每次读写按**调用方会话的沙箱模式与路径策略**检查，与文件工具同一套规则；`read-only` 下写类宿主函数被拒，`run_code` 本身仍可运行只读代码（它在契约里声明 `selfSandboxed: true`，审批策略因此不在调用前整体拒绝它，见 §工具审批）。进程不直接拿到文件系统以外的宿主能力。
- 输出与时长有上限（默认 60 s，最长 300 s）；超时或取消时终止整个进程树（Windows 纳入 Job Object），不得残留。
- 工作流脚本里的 `agent()` 经宿主函数建成员，成员受上节“子会话继承”约束；脚本本身不能绕过并发与总数上限。

## 密钥存放

| 优先级 | 来源 | 说明 |
| --- | --- | --- |
| 1 | 环境变量 `NEXGENT_API_KEY`（可选 `NEXGENT_API_BASE_URL`） | 一次性覆盖；只读，产品内不可改 |
| 1′ | 环境变量 `ANTHROPIC_API_KEY` | 前两者都没有时的回退 |
| 2 | `~/.nexgent/credentials.json`（`NEXGENT_HOME` 可改根目录） | `{ "version": 1, "credentials": { "NEXGENT_API_KEY": "...", "NEXGENT_API_BASE_URL"?: "..." } }`（`CredentialFile`，与 `data-formats.md` 一致）；POSIX 创建时 `0600`，发现权限宽于 `0600` 时拒绝读取并提示；Windows 依赖用户配置文件目录的默认 ACL，不额外设置 |

- 密钥**不**从项目目录读取：不读项目 `.env`，不写 `.nexgent/`。
- 密钥不进入会话记录、账本、日志与模型上下文；凭证服务只向 llm 包提供值，向其他组件只提供 `{ configured, source }`。
- **脱敏**：工具输出、子进程 stdout / stderr、错误消息在写入会话 / 账本与回传模型之前，替换当前已加载的密钥值与常见密钥形态（`sk-[A-Za-z0-9]{16,}`、`Bearer [A-Za-z0-9._-]{16,}`、`AKIA[0-9A-Z]{16}`）为 `[redacted]`。脱敏是尽力而为，不是密钥不泄露的保证。

## 本地 IPC 与访问令牌

桌面应用（`apps/desktop`，Electron）里，主进程持有 `@nexgent/sdk` 的实例（因此持有 kernel、会话锁、密钥读取能力）；渲染进程只是界面，经 preload 暴露的一个窄接口调用 SDK。本节定这条边界：渲染进程能做什么、调用怎样被验证、窗口怎样配置。接口的类型镜像是 `packages/sdk/src/api.ts`（`SdkMethods`、`SDK_METHOD_NAMES`、`SdkEvent`）。不做浏览器访问的 Web 服务，因此没有网络监听端口；IPC 是唯一的入口。

**窗口配置**（每个 `BrowserWindow` 都必须满足，W5 有测试检查实际的 `webPreferences`）：

| 项 | 值 | 目的 |
| --- | --- | --- |
| `contextIsolation` | `true` | preload 与页面脚本隔离，页面拿不到 preload 的变量（令牌就在其中） |
| `sandbox` | `true` | 渲染进程在 Chromium 沙箱里，没有 Node |
| `nodeIntegration` / `nodeIntegrationInWorker` / `nodeIntegrationInSubFrames` | `false` | 页面与 worker 没有 `require` |
| `webSecurity` | `true`；`allowRunningInsecureContent: false` | 不放宽同源与混合内容 |
| `webviewTag` | `false` | 不允许嵌入其他页面 |
| `spellcheck` | `false` | 不向外部词典服务发送输入 |
| `devTools` | 仅开发构建为 `true` | 打包后的应用不能打开开发者工具 |

**页面来源与导航。**

- 打包后的界面由自定义协议 `app://nexgent/` 从应用包内提供（`protocol.handle`，只映射包内 `renderer/` 目录，拒绝 `..` 与绝对路径）；开发模式只额外允许 `http://localhost:<vite 端口>`。界面不用 `file://` 加载。
- `will-navigate`、`will-redirect`、`will-frame-navigate` 一律 `preventDefault()`，除非目标与当前页面同源；`setWindowOpenHandler` 一律返回 `{ action: 'deny' }`。外部 `http(s)` 链接由主进程在用户点击后用 `shell.openExternal` 打开；`file://`、`javascript:`、`data:` 及其他协议的导航与打开一律拒绝并写日志。
- `session.setPermissionRequestHandler` 与 `setPermissionCheckHandler` 对所有权限（摄像头、麦克风、通知、地理位置等）返回拒绝。
- 页面带 CSP：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`（开发模式为 vite 的热更新放宽 `connect-src` 到本机端口）。

**访问令牌。**

1. 主进程每创建一个窗口生成一个令牌：`crypto.randomBytes(32)` 的 base64url 文本，只存在内存里，窗口关闭即作废；不写磁盘、日志、会话或账本。
2. 令牌经 `webPreferences.additionalArguments`（`--nexgent-ipc-token=<token>`）交给该窗口的 preload；preload 从 `process.argv` 读出后保存在闭包里，**不**放到 `window` 或 `contextBridge` 暴露的对象上。
3. preload 用 `contextBridge.exposeInMainWorld('nexgent', api)` 暴露且只暴露：
   - `invoke(method, input)`：内部调用 `ipcRenderer.invoke('nexgent:call', { token, method, input })`；
   - `onEvent(listener)`：订阅 `nexgent:event` 通道上的 `SdkEvent`，返回取消订阅函数；
   - `platform`：`process.platform` 的字符串；
   - `pickDirectory()`、`pickFiles()`：分别等于 `invoke('dialogs.pickDirectory', {})`、`invoke('dialogs.pickFiles', {})` 的简写，走同一条受检的调用。
   页面拿不到 `ipcRenderer` 本身，也拿不到令牌。
4. 主进程只在 `nexgent:call` 一个通道上 `ipcMain.handle`，每次调用按顺序检查：
   1. `event.senderFrame` 是该窗口的顶层框架，且其 URL 的来源是 `app://nexgent`（开发模式另加 vite 来源）；
   2. 令牌与该窗口的令牌相等（`crypto.timingSafeEqual`，长度不等直接拒绝）；
   3. `method` 在白名单 `SDK_METHOD_NAMES` 内；
   4. `input` 是普通 JSON 对象，并通过该方法的参数校验（必填字段、类型、路径参数是绝对路径）。
   任一检查失败：不调用 SDK，返回 `{ ok: false, error: { code: 'approval/denied', … } }`，并在日志里写一行（时间、窗口 ID、方法名、失败的检查项；**不**写令牌与参数内容）。通过则调用 `sdk.call(method, input)`，返回 `{ ok: true, result }` 或 `{ ok: false, error: toErrorInfo(error) }`。
5. 事件只从主进程推向渲染进程（`webContents.send('nexgent:event', event)`），渲染进程不能经事件通道调用任何东西。

**方法白名单**：`SDK_METHOD_NAMES` 的全部方法，即 `app.info`；`projects.recent / open / close / forget`；`sessions.list / create / open / close / export / rename`；`files.list`；`dialogs.pickDirectory / pickFiles`；`turns.send / cancel`；`approvals.respond`；`materials.add / list / remove`；`deliverables.list / get / diff / readText / reveal`；`feedback.submit / list`；`goals.get / set / update`；`settings.get / update / setApiKey`。没有通用的文件读写、命令执行或任意路径打开方法：

- 文件选择对话框由主进程打开（`dialog.showOpenDialog`）：渲染进程调用 `dialogs.pickDirectory`（打开项目）或 `dialogs.pickFiles`（添加资料）发起意图，得到用户选的绝对路径（取消时为 `null` / 空数组），再调用 `projects.open` / `materials.add`。渲染进程直接传路径给这两个方法也允许，但路径必须是绝对路径，且 `materials.add` 只复制，不改源文件。CLI 与没有对话框的宿主对 `dialogs.*` 返回 `internal`。
- `files.list` 只列项目根下的普通文件（项目相对路径、大小、修改时间），不跟随符号链接，跳过根下的 `.nexgent/` 和任意层的 `.git/`、`node_modules/`，最多 5000 项；不返回文件内容。
- `sessions.rename` 写一条 `session.title` 记录（`data-formats.md`），只改显示名。
- `deliverables.readText` 只读快照目录里属于该版本的文件，`deliverables.reveal` 只对快照目录内的路径调用 `shell.showItemInFolder`，二者都拒绝 `..` 与绝对路径参数。
- `sessions.export` 的 `outDir` 来自主进程的保存对话框。

**密钥。** `settings.setApiKey` 是唯一把密钥值从渲染进程送进主进程的方法；值只在这一次调用里经过 IPC，主进程写入 `~/.nexgent/credentials.json`（`0600`）后只返回 `{ configured, source }`。没有任何方法或事件把密钥值送回渲染进程；设置页的输入框写入后清空，只显示“已配置 / 来源”。IPC 日志不记录 `settings.setApiKey` 的参数。

**审批。** 主进程把 `ApprovalRequest` 作为 `approval.request` 事件推给渲染进程；渲染进程用 `approvals.respond` 回答，主进程补上 `decidedBy: 'user'` 后交给 `ctx.approvals`。窗口关闭或渲染进程崩溃时，未决的审批按 `decidedBy: 'cancel'` 关闭（“CLI 与桌面应用共用的审批交互”）。

**边界（如实列出）。** 令牌防的是“页面以外的东西”调用 SDK：被注入的子框架、意外导航到的外部页面、同一会话里的其他 `webContents`。它不防主进程或 preload 本身被篡改，也不防与用户同权限的本机进程直接读写 `.nexgent/` 或调试 Electron 进程；这些不在桌面应用的威胁模型内。

**测试**（W5、W8）：窗口的 `webPreferences` 与上表一致；无令牌、错令牌、白名单外方法、非顶层框架的调用各被拒并有日志行；`will-navigate` 到外部 URL 与 `file://` 被阻止；`settings.setApiKey` 后 `settings.get` 与所有事件里搜不到密钥值；桌面层 D10。

## 已知边界与绕过

如实列出不能防住的情况；这些不是待办，是当前策略面的定义：

1. **命令的文件边界只在有系统沙箱的平台上成立。**macOS 与有 bubblewrap 的 Linux 上，命令写不出项目、会话临时目录与放行目录，读不到 `<NEXGENT_HOME>` 与凭证目录；但系统沙箱挡不住命令读取**项目内**的敏感文件（`.env` 等），项目内敏感文件只有文件工具会问，命令读它们不问。Windows 与没有沙箱的 Linux 上，`bash` / `pwsh` 启动的进程以用户身份运行，能读写用户能读写的任何路径；cwd 限制与形态黑名单只提高门槛。`sandbox: false` 经审批后同样没有边界。
2. **形态黑名单可被绕过。** 编码、变量拼接、脚本文件间接执行都不在匹配范围内。黑名单的目的是让常见高风险操作经过用户，不是阻止有意绕过。
3. **`full-access` 没有任何边界。** 等同于用户亲自执行。
4. **插件包进程内执行。** 插件包与宿主同进程、同权限，沙箱与审批对其无效；插件只在会话试用时装载，装载前问一次。
5. **符号链接竞争。** 解析与打开之间仍有窗口；二次解析把窗口缩小但没有消除。对手是同一用户的并发进程时无法防御。
6. **Windows 路径策略弱于 ACL。** 大小写、8.3 短名、交接点（junction）、硬链接都靠 realpath 与身份比较，覆盖不完整；ACL 后补后仍有硬链接别名与读不受限的边界。
7. **读根不隔离读取。** `extraReadRoots` 之外的读取被文件工具拒绝，但命令可以读任何东西；密钥脱敏只覆盖已知形态。
8. **网络只有开关。** `commands.network: false` 在有系统沙箱的平台上切断命令的网络；开着时命令用宿主网络，不按域名过滤。没有系统沙箱时这个开关不起作用。
9. **审批依赖宿主在场。** 非 TTY 的 CLI 把所有审批视为拒绝，任务可能因此失败而不是等待。
10. **成员共用工作目录。** 没有项目副本的成员（`read-only` 成员、放不下副本的项目）和主对话共用项目目录，没有各自独立的工作目录；由主对话写明每个成员可以改哪些文件；`write_file` 拒绝覆盖本会话读过之后被别人改过的文件，`str_replace` 按当时内容匹配。两个成员各自 `str_replace` 同一文件的不同位置都会生效；对同一处的修改，后到者找不到原文而报错。命令（`bash` / `pwsh`）写文件不受这些检查。同名成果不会互相追加版本。
11. **PTC 进程不是安全沙箱。** 空环境变量与宿主函数的路径检查限制了常见的越界，但 Node 进程仍以用户身份运行，`run_code` 没有进系统沙箱（系统沙箱只覆盖 `bash`）。
12. **只读命令表是判断，不是隔离。**`read-only` 下放行的只读命令在有系统沙箱时还在只读沙箱里；没有沙箱时只靠命令表与解析，表外的写法（如 `git` 的别名配置、`find -fprint`）以外的绕过仍可能写文件。

## CLI 与桌面应用共用的审批交互

审批在 kernel 的审批代理（`ctx.approvals`，契约 `ApprovalBroker`，见 `packages/kernel/src/contracts/approvals.ts`）中统一处理；宿主（CLI 或桌面应用）注册**一个**应答者，没有应答者时所有审批按 `timeout` 拒绝。

```ts
interface ApprovalRequest {
  id: string                       // 本次请求 ID，写入账本与会话
  sessionId: string
  callId: string                   // 对应的 tool.call
  tool: string                     // 'bash' | 'pwsh' | 'fs.write' | ...
  summary: string                  // 一行：要做什么（命令全文或路径）
  detail?: string                  // 多行上下文：cwd、匹配到的规则、模型给的理由
  risk: 'low' | 'medium' | 'high'  // 低：敏感文件读；中：黑名单命令；高：始终审批表
  options: Array<'once' | 'session' | 'project'>  // 允许选择的作用范围；始终审批表只给 'once'；项目外路径给 ['once', 'session']
  pattern?: string                 // session / project 授权将保存的匹配模式
  expiresAt?: string               // ISO 时间；CLI 填，桌面应用可空
  member?: {                       // 成员（子会话）发起时才有；sessionId 此时是成员会话
    name: string
    executionForm: 'delegated' | 'workflow' | 'thread'
    parentSessionId: string        // 根会话：提示属于哪个对话
  }
}

interface ApprovalDecision {
  id: string
  decision: 'allow' | 'deny'
  scope: 'once' | 'session' | 'project'   // deny 时固定 'once'
  decidedBy: 'user' | 'timeout' | 'cancel' | 'headless'
  reason?: string                          // 用户备注，可空
}
```

- CLI：在 TTY 上渲染一段提示（summary、detail、risk 与 `[a]llow once / [s]ession / [p]roject / [d]eny`），非 TTY 直接返回 `decidedBy: 'headless'` 的拒绝。
- 桌面应用：主进程经 IPC 把 `ApprovalRequest` 推给渲染进程弹对话框，应答以 `ApprovalDecision` 回传；令牌与边界在"本地 IPC"章节。
- 两者记录完全相同：会话 `approval.request` / `approval.decision`，账本 `tool.call.approval`；呈现方式不入记录。
- 轮次取消时所有未决请求以 `decidedBy: 'cancel'` 关闭；一个请求只能被应答一次，迟到的应答丢弃。
- 成员的请求（带 `member`）：CLI 在提示首行写“成员 <name>（<形态>）请求：”，桌面应用在根会话的对话里弹同一个对话框并显示成员名；应答方式、作用范围与记录与主对话完全相同。父会话取消导致成员取消时，成员的未决请求同样以 `cancel` 关闭。

**工具在运行中发现的审批。** 沙箱契约（`packages/kernel/src/contracts/workspace.ts`）的 `SandboxDecision` 除 `{ allowed: true }` 与 `{ allowed: false, code, reason }` 外，还有第三种情形 `{ allowed: false, code: 'approval-required', reason, ask: ToolApprovalAsk }`：策略没有直接拒绝，调用在宿主批准 `ask` 后可以继续。工具不自己弹窗，而是把 `ask` 交给 `ToolContext.requestApproval(ask)`（契约 `packages/kernel/src/contracts/tools.ts`），它经 `ctx.approvals` 走上面同一套 `ApprovalRequest` / `ApprovalDecision` 流程，解析为 `true` 表示可以继续，没有应答者时为拒绝。`ToolContext.approved` 为 `true` 表示循环在调用工具前已经为该调用取得审批（`approval: 'ask' | 'always'` 的工具），工具不必再问。`ToolApprovalAsk`（`packages/kernel/src/contracts/approvals.ts`）的字段：

```ts
interface ToolApprovalAsk {
  summary: string                  // 一行：将要发生什么（命令全文或路径）
  detail?: string                  // 多行上下文：命中的规则、cwd
  risk?: 'low' | 'medium' | 'high' // 默认 'medium'
  pattern?: string                 // session / project 授权保存的匹配模式；缺省从 subject 推导
  subject?: { kind: 'command' | 'path' | 'other', value: string }  // 用于匹配已有授权；默认 { kind: 'other', value: summary }
  options?: Array<'once' | 'session' | 'project'>  // 可选作用范围；默认宿主支持的全部，risk 为 'high' 时只给 'once'
  grantTool?: string               // 授权存放与匹配用的名字；缺省为工具名。项目外路径用 'fs.read' / 'fs.write'
}
```

`ToolContext.grants()` 返回本会话与本项目生效的授权，命令沙箱据此把放行写的目录加进可写目录。`ToolDefinition.readOnlyCall(input)` 声明某次调用只读（`bash` 用 `isReadOnlyCommand`），审批策略据此在 `read-only` 下放行；`ToolDefinition.approvalText(input)` 决定调用前审批的摘要与详情（`exit_plan` 用它展示计划全文）。

`extraReadRoots`（读根的扩展）是项目配置 `.nexgent/config.json` 的字段（`ProjectConfig.extraReadRoots: string[]`，默认 `[]`），见 `data-formats.md` §项目配置文件。

## 测试

每条策略在 Linux 与 Windows 上各跑一次（CI 手动触发，见 `AGENTS.md` §5）；用例用 `@nexgent/test-support` 的脚本化 provider 驱动真实工具实现，不打桩路径函数。表中"两平台"指同一测试文件在两平台都通过，平台专属用例以 `it.runIf(process.platform === ...)` 标注。

| 策略 | 用例 | 预期 |
| --- | --- | --- |
| 沙箱模式 | `read-only` 下写文件、执行写命令 | `SANDBOX_DENIED`，无审批请求产生 |
| 沙箱模式 | `read-only` 下 `ls`、`git status`、`git -C . log`、`rg "rm -rf" src`；`touch x`、`ls > out.txt`、`sh -c "rm x"` | 前者执行，后者拒绝 |
| 计划模式 | 计划模式下写文件；`exit_plan` 批准后写文件；关闭后重开未批准的计划会话 | 拒绝；`session.mode`（`plan-approved`）后写入成功；重开后仍是计划模式 |
| 中途切换 | `sessions.setMode` 切到 `read-only` 后写文件 | `session.mode`（`host`）；写入被拒 |
| 系统沙箱 | `bash` 写项目外、写 `.nexgent/`、读 `~/.ssh`、`rm -rf <NEXGENT_HOME>`、`sh -c` 包一层写项目外；`network: false` 下联网 | 全部失败并附 `<sandbox_violations>`；凭证与数据目录不变；读本项目资料可以 |
| 系统沙箱 | 宿主进程被 `SIGKILL` | 网络桥 `socat` 随之结束 |
| 沙箱模式 | `--sandbox` 覆盖 `config.json`；非法值 | 会话头记录 CLI 值；非法值启动失败 |
| 路径 | 写 `../outside.txt`、绝对路径根外；读项目外目录后用 `list_files` / `search_text` / `str_replace` | 询问（风险中，`once` / `session`，模式 `<目录>/**`，`fs.read` / `fs.write` 分开）；本会话放行读后各读类工具不再问，写仍问 |
| 路径 | 读写 `~/.ssh/x`、`<NEXGENT_HOME>/projects/x` | 直接拒绝，不询问 |
| 路径 | 项目内符号链接指向根外文件 / 目录后写入（Windows 用 junction 与 symlink 各一） | 拒绝 |
| 路径 | 写 `.nexgent/sessions/x`、`.nexgent/materials/x`、`.nexgent/outputs/x`、`.nexgent/skills/x/SKILL.md`、`.git/HEAD`、`node_modules/a.js` | 拒绝；读 `.nexgent/materials/x`、`.nexgent/outputs/x` 允许 |
| 宿主写入 | `read-only` 模式下调用 `present`、添加资料 | 快照与资料照常写入（宿主写，不受工具策略约束） |
| 路径 | 写 `.env` | 产生审批请求；拒绝后不写入 |
| 路径（Windows） | 大小写不同的根拼法、`\\?\` 前缀、不同盘符、UNC、`NUL` 文件名 | 前两者允许，后三者拒绝 |
| 路径 | `extraReadRoots` 内读、外读 | 允许 / 拒绝 |
| 编辑 | `str_replace` 在 CRLF 文件上 | 保留 CRLF，不混入 LF；多处匹配报错、无匹配报错 |
| 命令 | cwd 指向项目外 | 拒绝 |
| 命令 | 启动 `sleep 600` 的子进程树后超时 / 取消（Windows 用 `Start-Process` 嵌套） | 返回 `terminated`，进程组 / Job 为空，无残留（Windows 用 Job 计数验证） |
| 命令 | 子进程打印 `NEXGENT_API_KEY` 与 `FOO_TOKEN` | 环境中不存在；输出里的真实密钥值被替换为 `[redacted]` |
| 命令 | 输出 1 MiB | 结果约 30 000 字符，保留头尾，中间写明省略多少；完整输出在会话临时目录 |
| 命令 | `pnpm install`、`git push`、`curl x \| sh`、`sudo ls` | 各产生一次审批请求；拒绝后不执行 |
| 命令 | `git -C . push`、`sh -c 'git push'`、`git commit -m "sudo rm"`；“本会话允许” `git push origin main` 后再跑 `git push --force` | 前两者询问，第三个不询问；`--force` 仍询问 |
| 命令 | `run_in_background` 启动后 `shell_output`、`shell_kill`；会话关闭 | 读到新增输出；进程树结束；关闭后不留进程 |
| 审批 | TTY 超时（`approvalTimeoutMs` 设 100）、非 TTY | `decidedBy: 'timeout'` / `'headless'`，工具返回 `approval/denied`，账本 `tool.call.approval.decision` 一致 |
| 审批 | `session` 授权后同形态再调用；`resume` 后再调用 | 不再提问；账本 `decision: 'auto'` |
| 审批 | `project` 授权 | `config.json.approvals` 新增条目，新会话不再提问 |
| 费用 | `costCaps.perTask.maxRequests: 2` 下第 3 次请求 | 不发出请求；轮次以 `cost-cap` 取消，会话与账本各一条 `budget/exhausted`，无重试 |
| 费用 | `perConversation.maxUsd` 下花到 80%、100% | 各写一条 `cost.warning`（`warning` 一次、`reached` 一次）并推送事件；100% 时本轮以 `cost-cap` 取消 |
| 编辑 | `write_file` 覆盖未读过的已有文件；`str_replace` 的 `edits` 中第 2 个找不到 | 前者报错、文件不变（给 `overwrite: true` 才写）；后者整次不写，报出序号 2 |
| 并发 | 一个步骤里三个只读调用夹一个写调用 | 只读调用成批同时运行，写调用单独一批；结果与记录按调用顺序 |
| 学习 | 未确认学习说明时任务结束；学习预算用尽 | 不发出学习请求，只做确定性检查；自评记 `learning-off` 或 `budget-exhausted` |
| 学习 | 文件工具与 `run_code` 读写 `<NEXGENT_HOME>/projects/**`、`handbook/**`；`full-access` 下写 `config.json` 的 `learning` | 读写都拒绝；写 `learning` 产生“始终审批”请求 |
| 密钥 | 凭证文件权限 `0644`（POSIX） | 拒绝读取并给出修复提示 |
| 密钥 | 会话、账本全文 | 不含密钥值 |
| 子会话 | `read-only` 父会话下以 `workspace-write` 请求成员；预设 `deny: ['bash']` | 创建失败 `sandbox/denied`；成员工具列表里没有 `bash` |
| 子会话 | 成员工具列表 | 不含 `delegate`、`workflow`、`organize` 与讨论串工具 |
| 子会话 | 成员写 `.env` | 审批请求带 `member`（成员名、根会话 id）；拒绝后文件不变 |
| 子会话 | `perTask.maxRequests` 下成员用掉额度后父会话再请求 | 父会话请求不发出，记录 `budget/exhausted` |
| 子会话 | 父会话取消 | 成员轮次以 `parent` 结束，无残留子孙进程 |
| 网页 | `web_fetch` 访问 `127.0.0.1`、`169.254.169.254`、`[::1]`、解析到私网的域名、重定向到私网 | 全部拒绝，不发出请求 |
| PTC | `run_code` 读环境变量、读根外文件、`read-only` 下写文件、超时 | 环境为空；读写被拒；超时后进程树为空 |
| 能力 | 文件工具读写 `.nexgent/capabilities/x`、`.nexgent/capabilities/drafts/<id>/x`、`.nexgent/snapshots/x` | 全部拒绝 |
| 能力 | `full-access` 下写 `config.json` 的 `capabilities` 字段 | 产生“始终审批”请求 |
| 能力 | `capability_try` 试用插件（含 `read-only`）；拒绝 | 产生 `risk: high`、只有 `once` 的审批；拒绝后插件未装载 |
| 能力 | 函数模块读环境变量、读根外文件、`read-only` 下写 | 环境为空；读写被拒 |
| 能力 | `context-policy` 带 `approvals` / `costCaps` / `sandboxMode` / `capabilities` | 清单校验失败，组件不装载 |
| 能力 | 成员工具列表 | 不含 `capability_draft`、`capability_try` |
