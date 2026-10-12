# @nexgent/capabilities

能力版本：一个项目的能力包按内容寻址存放、写成即不可变、加载前逐文件校验；采用历史是只追加的修订链（`adopt` / `rollback`），当前采用版本是链尾。

归属：步骤 4 W2「能力版本」（`docs/plan/step-4-work-partition.md`）。本包目前是第 1 轮（第一部分）：存储、校验、采用历史。草稿区、`capability_draft / try / propose`、加载器、各插件的来源入口、插件包审批在第 2 轮；门控（W3）与 kernel 注入（W1）不在本包。运行时依赖：Node 内置模块、`@nexgent/kernel`。`src/activation.ts` 移植自 PR #4 的 `runtime/packages/bundle/nexgent-app/src/architecture-activation.ts`（归档分支 `archive/python-host`），改动见文件头注。

清单与修订的字段是本包的第 1 轮实现；步骤 4 契约（W0）合入后以 `packages/kernel/src/contracts/` 与 `docs/spec/data-formats.md` §`CapabilityBundle` 清单为准，本包随之对齐。

## 目录

```text
.nexgent/capabilities/
├── <version>/                    一个能力包，<version> = 规范化清单的 SHA-256
│   ├── manifest.json
│   └── <type>/<name>/<file>      组件文件，与清单一一对应
├── activation/<n>.json           采用历史（修订 1, 2, …）
└── .staging-<uuid>/              写入中的临时目录（崩溃残留会被忽略）
```

`baseline` 是空能力包（等于步骤 3 的行为），不落盘，始终可加载。

## 清单 `manifest.json`

```json
{
  "format": 1,
  "components": [
    {
      "type": "skill",
      "name": "summarize-orders",
      "path": "skill/summarize-orders",
      "files": [{ "path": "SKILL.md", "sha256": "<64 hex>", "size": 120 }]
    }
  ]
}
```

- `type`：`function-module`、`plugin`、`skill`、`context-policy`、`preset`、`team-template`、`architecture`（计划 4.4 的四类组件：工具、技能、上下文策略、协作方式）。
- `name`：`[a-z0-9][a-z0-9_-]*`，最长 64，同类型内唯一；`path` 固定为 `<type>/<name>`。
- 文件路径相对组件目录，用 `/`，不允许空段、`.`、`..`、绝对路径、盘符、Windows 不能存的字符、以点或空格结尾的段；同一组件内不能有只差大小写的路径，也不能一个路径既是文件又是目录。
- 规范化：组件按 `type`、`name` 排序，文件按 `path` 排序，字段顺序固定；版本 = 规范化后 `JSON.stringify` 的 SHA-256。来源（哪个会话、哪个候选）不进清单，内容相同的两个候选得到同一版本。
- 上限：256 个组件、每组件 256 个文件、共 1024 个文件、共 64 MB。

## 写入与校验

- `writeBundle` 先在内存里建好清单（输入不合法则什么都不写），再在 `.staging-<uuid>/` 里写全部文件与清单并逐个 fsync，最后把整个目录一次改名为 `<version>/`。读者看不到写了一半的包。
- 版本已存在时不重写，只校验已有的副本；校验不过报 `CapabilityIntegrityError`，不覆盖。多个进程同时写同一内容，只有一个改名成功，其余校验对方的结果后返回同一版本。
- `loadBundle` 每次都重新校验：清单能解析且合格、清单哈希等于目录名、每个文件大小与 SHA-256 相符、目录里没有清单以外的条目（多出的文件、符号链接都算）。失败原因 `reason`：`missing`、`manifest`、`version-mismatch`、`file-missing`、`file-mismatch`、`unexpected-entry`。

## 采用历史 `activation/<n>.json`

```json
{ "format": 1, "revision": 2, "previous": "<sha256 of 1.json>", "from": "<version>", "version": "<version>",
  "type": "adopt", "evidence": { }, "committedAt": "2026-10-12T03:00:00.000Z" }
```

- `adopt`：只能采用已存储的包（不能是 `baseline`，不能是当前版本）；`CapabilityStore.adopt` 先校验包再发布。
- `rollback`：回到最近一次仍有效的采用之前的版本（采用压栈、回滚出栈）；`baseline` 在用时不能再回滚。回滚只追加修订，不删除任何版本。
- 每次读取都校验整条链：编号连续、`previous` 等于上一修订原始字节的 SHA-256、`from` 等于当时的版本、回滚目标正确。任何一处不符报 `CapabilityActivationError`，不退回到某个“看起来对”的状态。
- 发布：临时文件写入并 fsync，`link` 到 `<n>.json`（名字已存在则失败），再 fsync 目录；发布前比较调用方观察到的链尾与当前链尾（compare-and-publish）。两个进程同时发布同一修订，恰好一个成功，另一个得到 `null`。

## Public API

| Export | What it does |
| --- | --- |
| `CapabilityStore(capabilitiesDir, { now? })` | 一个项目的能力版本：`write`、`load`、`versions`、`activation`、`history`、`adopt(version, evidence, observed?)`、`rollback(evidence, observed?)`、`resolveAdopted()` |
| `resolveAdopted()` | 取链尾并校验；校验失败就写 `rollback`（`evidence.trigger: 'load-failure'`，带 `failedVersion`、`reason`、`path`），再试上一版本，直到 `baseline`；返回 `{ activation, bundle, rollbacks }` |
| `writeBundle`、`loadBundle`、`listBundleVersions`、`buildManifest`、`componentDirectory`、`BASELINE_BUNDLE` | 存储层 |
| `readActivation`、`readActivationChain`、`commitActivation`、`BASELINE_ACTIVATION` | 采用历史 |
| `normalizeManifest`、`serializeManifest`、`manifestVersion`、`checkRelativePath`、`isBundleVersion`、`isCapabilityVersion` | 清单 |
| `CapabilityIntegrityError`、`CapabilityActivationError`、`CapabilityManifestError` | 错误；契约加入 `capability/*` 错误码之前用这三个类区分 |

## Known Limitations and Deferred Work

- 采用历史链本身损坏时 `resolveAdopted` 抛错，不自动修复；第 2 轮加载器决定怎样提示用户、是否退回 `baseline` 运行。
- 能力包目录不设只读属性，完整性只靠加载时校验。
- Windows 上的硬链接发布与目录改名竞争还没有实跑（测试平台无关，等手动 Windows 工作流）；改名失败时以“目标是否已存在”判断是否是并发写入，不依赖具体错误码。
- 候选、试验回执、决定记录（`candidates/`、`trials/`、`decisions/`）与试验额度属于 W3 与第 2 轮。
