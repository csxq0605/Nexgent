# Coding Assistant Examples

## Generate and Test Code
```
nexgent

> 写一个 merge sort 函数，用 [3,1,4,1,5,9,2,6] 测试一下
# Agent 调用 execute_python 编写并运行代码，输出排序结果

> 把这个函数保存到 sort.py
# Agent 调用 write_file 保存文件
```

## Debug Code
```
nexgent

> 读一下 main.py，帮我找 bug
# Agent 调用 read_file 读取代码，分析问题

> 修复第 42 行的空指针问题
# Agent 调用 edit_file 定点修改

> 运行一下看看修好了没
# Agent 调用 run_command 执行 python main.py
```

## Refactor
```
nexgent

> 读一下 utils.py，把里面的 for 循环改成列表推导式
# Agent 调用 read_file 分析，再调用 edit_file 重构

> 运行测试确认没有破坏功能
# Agent 调用 run_command 执行 pytest
```

## Add Tests
```
nexgent

> 读一下 calculator.py，给所有函数写单元测试
# Agent 调用 read_file 分析函数签名

> 保存到 test_calculator.py
# Agent 调用 write_file 创建测试文件

> 跑一下测试
# Agent 调用 run_command 执行 pytest -v
```

## Pipe Error Logs
```
cat app.log | nexgent -p "分析这些错误日志，找到根因并建议修复方案"
# Agent 解析日志内容，逐条分析错误原因
```

## Edit Jupyter Notebook
```
nexgent

> 打开 analysis.ipynb，在第 5 个 cell 后面加一个画分布图的 cell
# Agent 调用 notebook_edit 插入新 cell

> 运行一下 notebook 看看效果
# Agent 调用 run_command 执行 jupyter nbconvert
```

## Code Review
```
nexgent --effort high

> 审查 src/auth.py 的安全漏洞，给出修复建议
# Agent 调用 read_file 读取代码，逐行分析安全问题

> 按优先级帮我修复高危漏洞
# Agent 调用 edit_file 逐个修复
```

## Interactive Multi-turn
```
nexgent

> 列出当前目录所有 Python 文件
# Agent 调用 glob_files 搜索

> 读一下最大的那个文件
# Agent 调用 read_file 读取

> 这个文件有什么可以优化的地方？
# Agent 分析代码并给出建议

> 按你的建议改一下
# Agent 调用 edit_file 修改代码

> /context   # 查看 token 使用情况
> /rewind    # 如果改错了，回退到检查点
```
