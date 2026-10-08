# @nexgent/session

会话 JSONL v1 的追加写、checkpoint 与按会话 ID 恢复；以及请求账本。以 Cordis 服务 `ctx.session`（`SessionStore`）与 `ctx.ledger`（`Ledger`）提供。

归属：计划步骤 1；分工与完成定义见 `docs/plan/step-1-work-partition.md`。规范：`docs/spec/data-formats.md` §`.nexgent/` 目录布局、§会话 JSONL v1、§账本记录。契约：`packages/kernel/src/contracts/{session,ledger,approvals}.ts`。

## 文件

```text
<project>/.nexgent/sessions/<sessionId>/session.jsonl   会话记录（一行一条，\n 结尾）
<project>/.nexgent/sessions/<sessionId>/.lock           单写者锁 {pid, ts, host}
<project>/.nexgent/ledgers/<yyyy-mm>/requests.jsonl     账本（月份取 ts 的 UTC 年月）
packages/session/schema/session.v1.schema.json          会话记录 JSON Schema（由 sessionRecordSchema 序列化，测试保证一致）
```

## 公共 API

| 导出 | 作用 |
| --- | --- |
| `JsonlSessionStore` | `SessionStore` 实现：`create / append / readAll / latestCheckpoint / resume / lock / release`，另有 `resumeDetailed`（返回 `folded`、`checkpointSeq`、`truncation`、`interruptedTurn`）、`checkpoint`（强制写一条）、`close`、`sessionDir / sessionFile / lockFile`。构造参数 `{ layout \| sessionsDir, checkpointEvery = 50, checkpointOnRelease = true, fsync = 'always' \| 'boundaries' }`。 |
| `JsonlLedger` | `Ledger` 实现：`append`（校验 → 单次写整行 → fsync → 关闭；失败抛 `ledger/write-failed` 并 `writeFailures++`；未知字段或形状错误抛 `ledger/invalid-record`，不计入失败）、`read(range)`（跨月按目录顺序，`from/to/types/sessionId` 过滤；容忍被截断的末行，未知类型与坏行跳过并计入 `skippedRecords`）。 |
| `projectSession`、`initialState`、`foldRecord`、`replay`、`SessionProjector` | 投影：同一个 fold 用于 resume、checkpoint 生成与写入者内存状态。`approval.grant` 进入 `metadata.grants`，`approval.request/decision`、`error` 不影响 `messages`；`sandboxMode` 来自 `session.start`。 |
| `shouldCheckpoint(record, lastCheckpointSeq, every = 50)` | checkpoint 策略：刚写的是 `turn.end` 且自上一个 checkpoint（或文件头）起 ≥ N 条记录。 |
| `scanSessionLog`、`encodeLine`、`checkSequence` | 行编解码与逐行有效性判定（`\n` 结尾、UTF-8、JSON 对象、schema、`seq` 连续、`sessionId` 一致、首行 `session.start`、`checkpoint.coversSeq = seq − 1`）。 |
| `sessionRecordSchema`、`sessionRecordValidators`、`validateSessionRecord`、`validateSessionState`、`assertSessionRecord`、`isSessionRecord` | 会话记录 JSON Schema（draft 2020-12 子集）与按类型的校验器。写入严格（未知字段拒绝），读取宽松（忽略同版本新写入方多写的可选字段）。 |
| `ledgerRecordSchema`、`ledgerRecordValidators`、`validateLedgerRecord` | 账本记录 schema（开放格式；写入时以 `forbidAdditionalProperties` 关闭，保证写不进内容字段）。 |
| `evaluateSchema`、`jsonEqual` | 上述 schema 使用的小型 JSON Schema 求值器。 |
| `acquireLockFile`、`releaseLockFile`、`isProcessAlive`、`parseLockFile` | 锁文件原语。 |
| `SessionPlugin` | Cordis 插件（profile 行 `@nexgent/session`）：`inject: ['workspace']`，在 `ctx.workspace.layout` 下（或 config 的 `root / sessionsDir / ledgersDir` 下）`ctx.provide('session')`、`ctx.provide('ledger')`；fiber 卸载时释放全部锁。Config 为手写 Standard Schema 校验器（本包不依赖 schemastery）。 |
| `createSessionServices(config)` | 不经 Cordis 的工厂，返回 `{ store, ledger }`。 |

## 实现要点

- **追加**：一条记录 = `JSON.stringify(record) + "\n"`，按已知文件末尾位置一次写入；默认每条 `fsync`，`fsync: 'boundaries'` 时只同步 `turn.end`、`checkpoint`、`error`。写失败时把文件截回上一条记录边界。`seq / ts / sessionId` 由存储赋值，调用方传入的同名字段被丢弃。同一会话的写入经 promise 链串行。
- **checkpoint**：写 `turn.end` 后按策略紧接着写；`release` / `close` 时若自上一个 checkpoint 起有新记录（只有 `session.start` 的会话除外）再写一条。调用方自己追加的 `checkpoint` 必须 `coversSeq = seq − 1` 且 `state` 与投影相等。
- **恢复**：`readAll` 停在第一条无效行并返回 `truncation`；只有 `session.start` 读不出时抛 `session/corrupt`。持锁者在下一次写入前把文件截到 `truncation.byteOffset`，先写 `error { code: 'session/corrupt', fatal: false }` 再写调用方的记录。`resume` 从最后一个 checkpoint 起只折叠其后的记录；若有未关闭的轮次，**持锁的调用方**（本存储持有该会话的锁）追加 `turn.end { kind: 'interrupted' }`，只读调用方在状态里保留 `openTurn`。持锁者应在启动时调用 `resume`，不要在本进程正在进行的轮次中调用。
- **锁**：`open(.lock, 'wx')` 独占创建；已存在时同 host 且 pid 不存活视为陈旧，经 `.lock.takeover` 守卫比对内容后删除再重取；其他 host 的锁从不接管；内容无法解析的锁文件在 10 s 后视为遗弃。`release` 只删除仍是自己内容的锁。

## 测试

`pnpm exec vitest run --project @nexgent/session`：schema 与往返（每种记录、规范示例 fixture、schema 文件一致）、投影、checkpoint 策略与性能上限（1 万条记录 + checkpoint，断言只折叠其后的 18 条）、最后四行逐字节截断与每个行边界截断、中间行损坏、截断修复写 `error` 记录、未关闭轮次、进程内与跨进程（`node --import tsx` 子进程、普通 `node -e` 子进程）锁竞争与陈旧锁接管、账本跨月、过滤、截断末行、写失败路径、Cordis 插件装载与卸载。

## DSH 参考

设计参考（未逐行改写）：`session/session-persistence-jsonl`（`src/storage.ts` 每句柄串行写链与撕裂尾截断、`src/lease.ts` 全生命周期写租约）、`session/session-checkpoint-policy`（语义边界上的持久化点）、`session/session-projection`（纯同步 fold）、`session/session-format`（记录类型划分）。

## 尚未做

- 账本 schema 文件 `packages/llm/schema/ledger.v1.schema.json` 归 `@nexgent/llm`；本包导出 `ledgerRecordSchema` 供其序列化。
- 不做 checkpoint 压缩与旧 checkpoint 清理（规范允许）；`readAll` 一次读入整个文件。
- 锁不防同一 host 上 pid 复用导致的误判活；跨机器共享盘上的陈旧锁需要人工删除。
