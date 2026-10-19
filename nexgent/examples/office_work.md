# Office Work Examples

## Create Reports
```
nexgent

> 帮我写一份周报，包含本周进展、阻塞问题、下周计划三个部分
# Agent 调用 create_doc 创建 markdown 文件

> 把"阻塞问题"部分加上具体的 Jira 链接
# Agent 调用 edit_file 补充链接
```

## Generate Spreadsheets
```
nexgent

> 创建一个预算表 CSV，列：项目、预估成本、实际成本、差异
# Agent 调用 create_spreadsheet 生成 CSV

> 再加一行汇总，算出总差异
# Agent 调用 edit_file 追加汇总行
```

## Summarize Documents
```
nexgent

> 读一下 meeting_notes.md，帮我提取会议摘要和待办事项
# Agent 调用 read_file 读取会议记录

> 把待办事项单独保存成 action_items.md
# Agent 调用 write_file 保存待办文件

> /remember   # 把这个会议的关键决策存到记忆里
```

## Data Processing
```
nexgent

> 读一下 data.csv，算一下 score 列的平均值和标准差
# Agent 调用 read_file 读取数据，调用 calculator 计算

> 把结果写成一份分析报告
# Agent 调用 create_doc 生成报告
```

## Pipe CSV Data
```
cat sales_q1.csv | nexgent -p "按区域统计总营收，生成汇总表"
# Agent 解析 CSV 数据，按区域分组计算
```

## Task Tracking
```
nexgent

> 创建一个数据库迁移的任务清单：1) 更新 schema 2) 迁移数据 3) 更新 API 4) 写测试
# Agent 调用 task_create 创建 4 个任务

> /tools   # 查看可用工具

> 列出所有任务
# Agent 调用 task_list 显示任务列表

> 把第 1 个任务标记为进行中
# Agent 调用 task_update 更新状态
```

## Multi-file Workflow
```
nexgent

> 读一下 specs/ 目录下所有 markdown 文件
# Agent 调用 glob_files 列出文件，逐个 read_file

> 把每个文件的需求提取出来，合并成一个 requirements.md
# Agent 调用 write_file 生成合并文件

> 搜索一下这些需求涉及的第三方库的最新文档
# Agent 调用 web_search 搜索

> /compact   # 上下文太多了，压缩一下
```

## Session Resume
```
nexgent --name "quarterly-report"

> 读一下去年的年报模板，按同样的结构写今年的
# Agent 调用 read_file 读取模板，调用 create_doc 创建新文件

# ... 中途退出 ...

nexgent --continue
# 自动恢复上次会话，继续写年报

# 或者用指定 ID 恢复（适合自动化场景）
nexgent --session-id quarterly-report
# 按 ID 精确恢复，不存在则创建新会话
```
