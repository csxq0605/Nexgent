# @nexgent/tool-spreadsheet

`.xlsx` 表格的读写工具：`read_spreadsheet` 读单元格的值与公式，`write_spreadsheet` 从行数据写出带公式的工作簿。
公式由包内的计算器用纯 JS 求值，写出的文件同时带公式和缓存值，用 Excel、LibreOffice 或只读缓存值的程序打开都看到同样的数。
工具名、`effects` 与 `approval` 冻结在契约 `STEP3_MIGRATED_TOOLS`（`packages/kernel/src/contracts/step3-tools.ts`）；参数 schema 归本包。

运行时依赖：Node 内置模块、`@nexgent/kernel`、`@nexgent/skill`（`readXlsxCells` 解析 OOXML）、
`fflate`（打包 zip）。没有原生模块，不需要 Python、LibreOffice 或 Excel。公式计算器是自写的：可选的成熟库里 HyperFormula 是 GPL，其余的或停更或只有函数没有解析器，按用户的“只用 MIT / Apache 类许可”要求不引入。

## Public API

| Export | What it does |
| --- | --- |
| `SpreadsheetPlugin` / `apply` / `name` | 行名 `@nexgent/tool-spreadsheet`；`inject: ['workspace', 'sandbox']`；有 `ctx.tools` 时注册两个工具，卸载即注销 |
| `readSpreadsheetTool(sandbox)` / `writeSpreadsheetTool(sandbox)` | 两个工具 |
| `loadWorkbook(bytes)` | `.xlsx` → `SheetData[]`（展开共享公式；数组公式、数据表公式保留缓存值） |
| `buildWorkbook(input)` / `sheetsFromInput` / `WRITE_LIMITS` | 行数据 → 计算后的 `.xlsx` 字节；输入不合法抛 `SpreadsheetInputError`，公式失败抛 `CalculationError` |
| `Calculator(sheets, { strict })` | 记忆化求值、环检测；`strict` 时不支持的公式与错误结果抛出，否则记进 `issues` |
| `tokenize` `parseFormula` `evaluate` `FUNCTIONS` `SUPPORTED_FUNCTIONS` `translateFormula` `toFileFormula` | 公式的词法、语法、求值与函数表 |

## 工具

两个工具都按本次调用的沙箱模式检查路径（与 `read_file` / `write_file` 同一套规则）：拒绝 → `sandbox/denied`；需要审批 → 走调用的审批流程。

`read_spreadsheet { path, sheet?, range? }`：`effects: ['read']`、`approval: 'never'`，`read-only` 下可用，资料（`.nexgent/materials/`）可读。
- 只接受 `.xlsx` / `.xlsm`（`.csv` 提示用 `read_file`，`.xls` 提示另存为 `.xlsx`），文件上限 50 MiB，工作簿上限 50 万个已用单元格。
- 输出：各 sheet 名与已用范围；一个 sheet（默认第一个，名字不分大小写）的 CSV（首行 `row,A,B,…`，每行带行号），每次最多 5000 个单元格，超出时说明用 `range` 翻页；之后列出公式（`B2: =SUM(A2:A9) → 42`）。
- 公式按文件当前的输入重新计算；计算器不支持的公式保留文件里的缓存值并在“Not recalculated”里列出原因；重算结果与文件缓存值不同时注明个数。
- `meta`：`{ path, sheet, range, formulas, notRecalculated, changedFromSaved, truncated }`。

`write_spreadsheet { path, sheets: [{ name, rows, headerRow? }], overwrite? }`：`effects: ['write']`、`approval: 'never'`（与 `write_file` 相同：`workspace-write` 下直接写，`read-only` 下被 loop 拒绝）。
- 单元格是数字、文本、`true` / `false` 或 `null`；以 `=` 开头的文本是公式，`'=` 开头是字面文本。公式支持 A1 引用、`Sheet!A1` / `'My sheet'!A1`、有界区域。
- 写之前计算全部公式；任何一个失败就**整份不写**，错误指出单元格。已有文件只在 `overwrite: true` 时替换。首行默认加粗并冻结。
- 上限：32 个 sheet，每 sheet 10 000 行 × 256 列，共 100 000 个非空单元格，单元格文本 32 767 字符。

### 拒绝与错误码

| 情况 | 错误码 | `details` |
| --- | --- | --- |
| 外部工作簿引用 `[Book2.xlsx]Sheet1!A1`、未知函数、名字（`TaxRate`）、不存在的 sheet、循环引用、结果为错误值（`#DIV/0!` 等）、3-D 引用、整列 / 整行引用、数组常量 | `tool/failed`（消息以 `nothing was written:` 开头） | `{ reason: 'formula', cell: 'Data!B2' }` |
| 已有文件且没给 `overwrite: true` | `tool/failed` | `{ reason: 'exists' }` |
| 超上限（行、列、单元格、sheet 数、文本长度）、sheet 名不合法或重复、扩展名不是 `.xlsx` | `tool/invalid-input` | — |
| schema 不符（loop 校验） | `tool/invalid-input` | — |
| 路径在项目外、宿主目录（`.nexgent/sessions/` 等）、`read-only` 模式下写 | `sandbox/denied` | — |

`read_spreadsheet` 读到损坏的文件给 `tool/failed`；`sheet` 不存在、`range` 格式不对或超过 5000 个单元格给 `tool/invalid-input`。

## 公式计算器

- 运算：`+ - * / ^ & %`、比较、一元正负；Excel 的类型转换（文本数字参与运算、空单元格为 0 或空文本、布尔）、区域广播、错误值传播（`#DIV/0!` `#VALUE!` `#REF!` `#NAME?` `#N/A` `#NUM!`）；数值按 15 位有效数字收敛。
- 约 75 个函数：聚合（SUM AVERAGE MIN MAX MEDIAN COUNT COUNTA COUNTBLANK PRODUCT SUMPRODUCT）、取整与数学（ROUND ROUNDUP ROUNDDOWN TRUNC INT MOD POWER LOG CEILING FLOOR CEILING.MATH FLOOR.MATH ABS SQRT 等）、条件（SUMIF(S) COUNTIF(S) AVERAGEIF(S) MAXIFS MINIFS，支持通配符）、逻辑（IF IFS IFERROR IFNA AND OR XOR NOT IS*）、查找（VLOOKUP HLOOKUP MATCH INDEX XLOOKUP CHOOSE）、文本（CONCAT TEXTJOIN LEFT MID SUBSTITUTE FIND SEARCH 等）、日期（DATE YEAR MONTH DAY）。完整列表见 `SUPPORTED_FUNCTIONS`。
- 不支持：TODAY、NOW、TEXT 与其他依赖时间或格式的函数，数组公式与动态数组，名字，表格结构化引用，交集运算符。写时拒绝，读时保留缓存值并报告。
- 新函数（CONCAT TEXTJOIN IFS MAXIFS MINIFS XLOOKUP IFNA CEILING.MATH FLOOR.MATH XOR）写入文件时加 `_xlfn.` 前缀，工作簿设置打开时全量重算。

## 测试

`tests/`：公式词法、语法与求值（类型转换、广播、错误值、各函数族）；工作簿计算（环、缺 sheet、共享公式、陈旧缓存重算、不支持公式的宽松处理）；
写出文件的 XML（公式与缓存值、共享字符串、冻结首行）再读回；由 LibreOffice 生成的夹具读取；工具的沙箱（`read-only`、`outputs/`、资料、项目外、`.nexgent/sessions/`）、翻页与错误码；
补货场景（写订单与汇总、按反馈改库存后重写、读回值）；经 kernel agent loop（脚本化模型）写再读一轮。旧 Python 测试（`test_organization_spreadsheets.py`）的用例都有对应。
