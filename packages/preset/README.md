# @nexgent/preset

成员预设：决定委派对象、队友、工作流成员的人设、工具范围与模型参数，只填字段、不含代码。格式与校验冻结在契约 `packages/kernel/src/contracts/collaboration.ts`（`AgentPreset`、`PresetFile`、`PRESET_FILE_SCHEMA`、`assertPresetFile`），规范见 `docs/spec/data-formats.md` §预设、`docs/spec/permissions.md` §子会话继承。

运行时依赖：Node 内置模块、`@nexgent/kernel`。DSH 的 `preset/agent-preset`、`preset/persona` 只参考了设计，没有复制代码。

## Public API

| Export | What it does |
| --- | --- |
| `BUILTIN_PRESETS`、`DEFAULT_PRESET_NAME`、`isBuiltinPresetName` | 内置四份：`read-only-analyst`（只读分析）、`read-only-checker`（只读检查）、`general-executor`（通用执行者，默认）、`explorer`（快速低成本的只读搜索，重做 K4） |
| `PresetRegistry(projectRoot)` | `load()` 列出内置与项目预设，坏文件放进 `errors` 不抛；`resolve(name)` 按名取一份 |
| `parsePresetFile(text, baseName)` | 解析并校验一份预设文件 |
| `describePresets(entries)` | 每份一行 `- name: description`，给工具描述用 |

## 行为

- **内置四份。** 两份只读预设把成员收窄到 `read-only`，人设要求只报告发现 / 逐项判定，不改文件；`general-executor` 不设 `sandboxMode` 与 `tools`，沿用父会话的模式与工具，人设要求只改任务指定的文件（别的成员可能同时在同一项目里工作）并用 `present` 交回；`explorer`（重做 K4）是 `read-only`、effort `low`、thinking 关、`maxSteps` 24 的搜索成员，只报告找到的位置与事实。人设里的 `{{model}}` 由 kernel 替换。
- **项目预设。** 读 `<项目>/.nexgent/presets/*.json`，每次调用都重新读，改了文件下一次启动成员即生效。文件名须匹配 `^[a-z][a-z0-9-]{0,63}$` 加 `.json`，`name` 字段须等于文件基名，单个文件不超过 64 KiB；JSON 解析失败、未知字段、错误类型都报 `config/invalid`，信息里写明是哪个字段。
- **覆盖。** 项目预设与内置同名时取代内置（列表里占内置原来的位置）；其余项目预设按名字排序排在内置之后。
- **查找。** `resolve` 找不到时报 `tool/invalid-input` 并列出可用的名字；同名文件存在但无效时报 `config/invalid`，写明文件路径与原因。
- 预设只能收窄：沙箱宽于父会话由 kernel 在建子会话时以 `sandbox/denied` 拒绝，`tools` 由 kernel 用成员作用域的 `restrict()` 与父会话可见集合求交。本包不做这些检查，只负责读出与校验文件。

## Model Experience

预设本身不进入请求；kernel 用 `persona` 替换成员系统提示的人设段，`model`、`effort`、`thinking`、`maxSteps` 作用于成员的请求，`tools` 决定成员能看到的工具。

## Known Limitations and Deferred Work

- 没有用户级（`~/.nexgent/presets/`）预设目录；需要时再加，规范目前只定义项目级。
- 步骤 4 的能力版本把预设纳入 `CapabilityBundle` 时，注册表要能从能力版本读，届时再扩展。
