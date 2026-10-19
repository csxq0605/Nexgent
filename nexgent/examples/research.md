# Research Examples

## Web Search
```
nexgent

> 搜索一下小米 MiMo 模型的最新消息
# Agent 调用 web_search 搜索并整理结果

> 打开第一个链接看看详细内容
# Agent 调用 web_fetch 获取页面内容

> 把关键信息整理成笔记保存
# Agent 调用 create_doc 生成笔记
```

## Fetch and Analyze
```
nexgent

> 抓取 https://example.com 的内容，帮我总结要点
# Agent 调用 web_fetch 获取页面，分析并摘要

> 把摘要翻译成英文
# Agent 直接翻译
```

## Multi-step Research
```
nexgent

> 搜索 "AI agent frameworks 2026"，取前 3 个结果，写一份对比文档
# Agent 调用 web_search 搜索，逐个 web_fetch 抓取，最后 create_doc 生成对比文档

> 再搜一下这些框架的 GitHub star 数
# Agent 再次 web_search 补充数据

> 更新对比文档加上 star 数对比
# Agent 调用 edit_file 更新文档
```

## Code Research
```
nexgent

> 搜索 Python 异步编程最佳实践，写一份速查表
# Agent 调用 web_search 搜索多个来源

> 保存到 cheatsheet.md
# Agent 调用 write_file 保存

> 读一下内容，看看有没有遗漏的重要点
# Agent 调用 read_file 自查，补充内容
```

## Pipe and Analyze
```
curl -s https://api.example.com/data | nexgent -p "分析这个 JSON 数据，找出趋势和异常值"
# Agent 解析 JSON 数据，识别模式和异常
```

## Document Analysis
```
nexgent

> 列出 reports/ 目录下所有 PDF 文件
# Agent 调用 glob_files 搜索

> 读一下这 3 份报告，做一个对比矩阵
# Agent 逐个 read_file 读取，调用 create_doc 生成对比矩阵

> 哪份报告的结论最乐观？引用原文
# Agent 分析内容，给出引用
```

## Research with Memory
```
nexgent --session-id "ml-research"

> 搜索最近的 transformer 架构论文
# Agent 调用 web_search 搜索

> 读一下前两篇的摘要
# Agent 调用 web_fetch 获取内容

> /remember   # 把研究发现存到记忆

> /memory     # 查看已存储的记忆

# --- 下次继续 ---

nexgent --session-id "ml-research"
# 按 ID 精确恢复上次的研究会话

> 上次我们研究到哪了？
# Agent 从上下文和记忆中恢复研究进度
```

## Interactive Exploration
```
nexgent

> 搜索 "RAG vs fine-tuning comparison"
# Agent 调用 web_search

> 第二个链接看起来不错，打开看看
# Agent 调用 web_fetch

> 这篇文章的核心论点是什么？
# Agent 分析内容

> 我不太同意第三点，帮我找反驳的证据
# Agent 再次 web_search 搜索反方观点

> 把正反双方的观点整理成一个表格
# Agent 调用 create_doc 生成对比表

> /tokens   # 看看用了多少 token
```
