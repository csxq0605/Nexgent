# BIG-Bench Hard 两任务插件

这是可单独安装的 Nexgent benchmark 插件，入口组为 `nexgent.benchmarks`、ID 为 `bbh`。核心运行时不导入本插件；本插件不依赖科学计算任务、NumPy 或科学工具箱。

## 来源与范围

采用官方 [BIG-Bench-Hard 仓库](https://github.com/suzgunmirac/BIG-Bench-Hard/tree/9ee07bd481feebf959a6b59d61ea57bdcf30964d) 的 `boolean_expressions` 和 `word_sorting`，各 250 题。原始 BBH 包含 23 项任务；本插件的两任务子集结果不能称为完整 BBH 成绩，也不复现论文的模型/提示设置。[原始论文，Findings of ACL 2023](https://aclanthology.org/2023.findings-acl.824/)

数据固定提交为 `9ee07bd481feebf959a6b59d61ea57bdcf30964d`。下载脚本核对文件 SHA256，保留原始 JSON 字节、canary 和上游 [MIT LICENSE](https://github.com/suzgunmirac/BIG-Bench-Hard/blob/9ee07bd481feebf959a6b59d61ea57bdcf30964d/LICENSE)。数据不打进安装包，导入和安装不会访问网络；只有显式下载命令获取数据。

| 文件 | SHA256 |
| --- | --- |
| `boolean_expressions.json` | `ea6c754ec005e2d3f2d085d349a740f593b5764f32ea4638ffed4cfc0061b12a` |
| `word_sorting.json` | `2a6132d2c99f00d0d2eb1113ac6b4a918bd969d863c48749210d969713db8d43` |
| `LICENSE` | `4ef2ff4295d26ab6211235039c132697408cec5391d2c091b41e983771978db8` |

## 安装与数据准备

在 Nexgent 仓库根目录执行：

```powershell
.venv\Scripts\python.exe -m pip install -e benchmarks/bbh
.venv\Scripts\nexgent-bbh-download.exe --destination .nexgent/benchmarks/bbh
.\start.ps1
```

在界面的任务基准下拉框选择 BBH。框架通过 `from_project(project_root)` 默认读取项目的 `.nexgent/benchmarks/bbh`，因此按上述目录下载后无需设置环境变量；`NEXGENT_BBH_DATA` 用于覆盖位置。Linux 或已激活环境可直接执行 `nexgent-bbh-download --destination PATH`。缺数据、manifest 不一致或文件哈希错误都会显示不可用，不会替换成模拟数据。

## 执行与评价

任务程序仍是普通的 `solve(problem, tools)`。公开参数只含任务 ID、类别、题目与提交规则；答案留在宿主评价器。程序返回 `{"answer": "..."}`，宿主对两侧空白规范化后做区分大小写的精确匹配。额外解释文字不被自动当作答案提取。

初始任务程序具有完整的布尔递归解析（括号、重复否定、运算优先级）与词语排序算法；没有针对数据答案拟合或刻意削弱基线。后代可修改 Python 算法，也可经通用预算能力使用模型。算法基线评价没有模型请求；真实模型研究必须另行登记预算。

分区先按规范化公开输入去重，按输入摘要排序，再固定分成 40% 开发、20% 选择、20% 迁移、10% 元迁移、10% 确认。种子只改变各池内的抽样顺序，不能让例题跨池；默认每任务每次取 6 题，实际样本身份纳入 suite 摘要。同池不同种子可以抽到相同题目，不能把这些重复样本当成独立数据。

框架的 `final_transfer` 角色使用原生 `transfer` 池，两者是别名，不是两个独立分区。报告的 `split` 保留调用方请求，`native_split` 标明实际池；别名映射也进入评价器快照。同一种子下两种名称的任务与 suite 摘要一致。其余框架角色 `development`、`selection`、`meta_transfer` 直接对应同名池；插件额外提供 `confirmation`。

资源成本取执行收据中的 Python 源码 trace 事件数，标为 `source_instruction_events`。它不是机器指令、墙钟时间或 C 内置函数的完整运算量，也不能与别的插件的数值工作单位直接相比。超时、中断和资源耗尽保持缺测；缺少成本收据时明确记为预留上限，不能当成实际零成本。

BBH 是公开数据，当前运行的反馈隔离不代表模型预训练从未见过这些题。研究结论需要明确基准范围、潜在数据污染、已饱和的准确率、成本单位与对照条件。

## 已完成的有界验证

2026-09-16，18 项插件测试通过；测试仅使用显式 `fixture=True` 的自编接口样例或模拟下载，不隐式下载数据、调用模型或把样例标为官方成绩。覆盖公共 `StudyController.evaluate_benchmark` 的默认 `final_transfer`，以及一次完整 `StudyController.run` 的源码执行、任务合同传递、候选评价和最终迁移评分。完整流程使用明确标注的无模型测试改进器，只验证接口与执行链。

另对上述官方 500 题运行固定算法控制，经相同 `ProgramRunner` 的独立源码进程得到 **500/500**，两项各 250/250。该检查没有演化或模型请求，说明强控制的执行与评分可复核，也说明当前两项任务的准确率已饱和。它不证明自改进增益或通用 RSI。完整本机回执位于仓库忽略的 `build-validation/bbh-official-baseline.json`。

公共控制器的官方数据验证为 `study-0f9a682602ae4870`：默认 `final_transfer`、种子 101/202，每种子每任务 6 题；2 次测量、0 缺测、均分 1.0、1,034 个源码执行事件、0 模型调用。完整导出在忽略的 `build-validation/bbh-framework-fixed-study-0f9a682602ae4870.json`。这只是固定程序的有界基准执行；原先因缺少分区别名而全缺测的 `study-da80cbd06bc24a8b` 原样保留，没有在原 ID 上重跑。
