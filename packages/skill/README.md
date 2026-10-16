# @nexgent/skill

技能发现与按需加载，以及内置的 Office 读取技能。实现 kernel 契约 `packages/kernel/src/contracts/skill.ts` 的
`SkillRegistry`；`load_skill`、`read_document` 两个工具的名字、参数 schema、effects 与 approval 冻结在
`packages/kernel/src/contracts/step2-tools.ts`；规范文本见 `docs/spec/agent-hooks.md` §技能、§步骤 2 工具。

归属：步骤 2 W3（`docs/plan/step-2-work-partition.md`）；用户目录与 `readXlsxCells` 为步骤 3 W5。运行时依赖：Node 内置模块、`@nexgent/kernel`、
`yaml`（front matter）、`fflate`（解压 OOXML）、`unpdf`（打包好的 PDF.js）。都是纯 JS，没有原生模块，不需要 Python。

## Public API

| Export | Contract | What it does |
| --- | --- | --- |
| `SkillPlugin` / `apply` / `name` | Cordis plugin | 行名 `@nexgent/skill`；`inject: ['workspace', 'sandbox']`，`ctx.provide('skills')`；有 `ctx.tools` 时注册 `load_skill`、`read_document`，有 `ctx.context` 时注册 `skills` 提供者，任一方卸载即注销。配置：`builtinDir?`、`userDir?`（默认 `$NEXGENT_HOME` 或 `~/.nexgent` 下的 `skills`，按 `process.env` 取；有自己 home 的宿主应显式传入） |
| `FileSkillRegistry({ projectRoot, builtinDir?, userDir? })` | `SkillRegistry` | 扫描内置目录、用户目录（给了 `userDir` 时）与 `<project>/.nexgent/skills/*/SKILL.md`；每次调用重新扫描（轮中新增的技能下一轮可见） |
| `parseSkillFile` / `splitFrontMatter` | — | 解析 `SKILL.md` |
| `skillsProvider(registry)` / `renderSkillList` | `ContextProvider` | `id: 'skills'`，有技能时把 `# Skills` 列表作为注入消息给出（不在系统提示里；仅当与该会话上次注入的列表不同时才注入） |
| `SkillToolGate`（`ctx.skillTools`） | 技能门控工具 | 插件 `offer(tool)` 一个门控工具；会话 `load_skill` 了在 `tools:` 里点名它的技能后，它才进入该会话的工具集；恢复会话时按 `load_skill` 结果补回 |
| `loadSkillTool(registry)` / `readDocumentTool(sandbox)` | `Tool` | 两个工具 |
| `extractDocument(format, bytes, options)` 及 `extractDocx` / `extractXlsx` / `readXlsx` / `extractPdf` | — | 文档转文本；失败抛 `DocumentError` |
| `readXlsxCells(bytes, { maxCells? })` | — | `.xlsx` 的类型化单元格（数字 / 文本 / 布尔 / 错误、日期标记）与公式（普通、共享、数组、数据表），`@nexgent/tool-spreadsheet` 用它读工作簿；超过 `maxCells` 抛 `DocumentError` |
| 纯函数 | — | `documentFormat` `parseCellRef` `columnName` `csvField` `isDateFormat` `serialToIso` `parsePageRange` `scanXml` `decodeXmlText` `renderDocumentXml` `renderSheets` |

`ctx.skills` 目前没有在 kernel 的 Cordis 服务声明里（`ctx.context`、`ctx.tasking` 有）；本包不自己扩充 Cordis
类型，调用方暂用 `ctx.get('skills') as SkillRegistry`。

## 技能文件

- 位置：内置 `packages/skill/skills/<dir>/SKILL.md`（随包发布），用户 `~/.nexgent/skills/<dir>/SKILL.md`（步骤 3；`NEXGENT_HOME` 可改根目录，契约 `USER_SKILLS_DIR`），项目 `.nexgent/skills/<dir>/SKILL.md`。以 `.` 开头的目录、不是目录的条目、没有 `SKILL.md` 的目录都忽略。
- 格式：文件以 `---` 行开头的 YAML front matter，再一个 `---` 行，之后是正文（允许 BOM 与 CRLF）。字段：
  `name`（`^[a-z0-9][a-z0-9-]{0,63}$`，与目录名无须相同）、`description`（必填）、`when_to_use`（可选）、`tools`（可选，字符串数组）；
  其他字段忽略。多行的 `description` / `when_to_use` 折成一行。
- 出错（缺 front matter、YAML 错、名字不合法、缺描述、字段类型错、文件超过 256 KiB、同一来源内重名）的文件进 `SkillCatalog.problems`，不影响其他技能。
- 同名时项目技能覆盖用户技能，用户技能覆盖内置技能（`source` 分别为 `project`、`user`、`builtin`）。清单按名字排序。
- `load(name)` 找不到时抛 `tool/not-found`，消息里列出可用技能；若该名字的文件有问题，把问题一并写出。

## 工具

- `load_skill { name }`：返回 `# Skill: <name>`、描述行与正文。未知名字 → 工具错误 `tool/not-found`。
- `read_document { path, sheet?, maxRows?, pages? }`：`effects: ['read']`、`approval: 'never'`，`read-only` 模式可用，不写任何文件。
  - 路径按工作区解析，经 `ctx.sandbox` 的读策略检查（按本次调用的沙箱模式）：拒绝 → `sandbox/denied`；需要审批 → 走调用的审批流程。`materials/` 可读，`.nexgent/sessions/` 等宿主目录被拒。
  - 只接受 `.docx` `.xlsx` `.pdf`（扩展名不分大小写），其他 → `tool/invalid-input` 并提示用 `read_file`。文件上限 50 MiB；输出上限 100 000 字符，超出时截断并说明如何缩小范围。
  - 文档损坏、加密或不合规时抛 `tool/failed`（消息以路径开头），loop 把它变成错误的工具结果，本轮照常进行。
- 格式细节：
  - `.docx`：只读正文（`word/document.xml`）。段落一行一个；标题样式加 `#`，列表样式或编号加 `- `；表格每行 `| a | b |`（单元格内 `|` 转义）；跳过修订删除与域代码。
  - `.xlsx`：逐 sheet 输出 `## Sheet: <名> (range A1:D120, 120 rows × 4 columns)` 加 CSV 行（RFC 4180 引号）。取缓存值，不重算公式；共享字符串、内联字符串、布尔、错误值都支持；数字格式是日期 / 时间的转成 ISO 文本（支持 1904 日期系统）。每 sheet 默认 500 行（`maxRows` 可调），超出时附说明；`sheet` 名字不存在时列出全部 sheet 名。
  - `.pdf`：逐页 `## Page n of N` 加文本；`pages` 支持 `"3"`、`"1-3"`、`"1,4-5"`，超出页数报错；没有文本层的页标出来（无 OCR）。
- 部分文件上限：解压后单个部件超过 200 MiB 拒绝读取（防 ZIP 炸弹）。

## 内置技能

`skills/office-documents/SKILL.md`：何时用 `read_document`、三种格式的输出形式与限制（缓存值、无 OCR、只读正文等），以及“资料只读、结果写到项目”的约定。

## 测试

`tests/`：front matter 的合法与各类错误；发现、项目 > 用户 > 内置的覆盖、问题列表、重名、轮中新增；`# Skills` 提供者；三种格式各一个真实生成的小夹具
（`report.docx`、`orders.xlsx` 由 python-docx / openpyxl 生成后经 LibreOffice 重算保存，`report.pdf` 由 LibreOffice 从 docx 导出，`pages.pdf` 由 reportlab 生成）
的提取断言；截断、随机字节、缺部件、坏 XML 的文档都给 `DocumentError`；工具在 `read-only` 下读资料且工作区文件不变、沙箱拒绝项目外与宿主目录；
经 kernel agent loop（脚本化模型）跑一轮：系统提示含说明文件与技能清单、资料引用注入、`load_skill` 与 `read_document` 的结果，以及损坏文件变成错误工具结果而本轮完成。
