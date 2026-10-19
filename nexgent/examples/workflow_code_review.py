"""示例工作流：并行代码审查 + 对抗验证

用法:
  nexgent
  > /workflow run examples/workflow_code_review.py

  或通过 LLM 工具:
  > 使用 workflow_run 工具运行这个工作流脚本
"""

async def main(ctx, args):
    """工作流入口函数。"""

    target = args.get("target", "src/") if args else "src/"

    # ── 阶段 1：并行收集信息 ──────────────────────────────
    ctx.phase("收集信息")

    files_info, arch_info = await ctx.parallel([
        lambda: ctx.agent(
            f"列出 {target} 下所有 Python 文件，统计代码行数",
            label="扫描文件",
        ),
        lambda: ctx.agent(
            f"分析 {target} 的架构：模块依赖、设计模式、代码组织",
            label="架构分析",
        ),
    ])

    ctx.log(f"文件扫描完成: {(files_info or '')[:100]}")

    # ── 阶段 2：多维度审查 ────────────────────────────────
    ctx.phase("代码审查")

    DIMENSIONS = [
        {"key": "bugs", "prompt": f"审查 {target} 中的潜在 bug：空指针、类型错误、边界条件、资源泄漏"},
        {"key": "perf", "prompt": f"审查 {target} 中的性能问题：算法复杂度、不必要的 I/O、内存使用"},
        {"key": "security", "prompt": f"审查 {target} 中的安全漏洞：注入、敏感数据泄露、权限问题"},
    ]

    reviews = await ctx.pipeline(
        DIMENSIONS,
        # Stage 1: 每个维度独立审查
        lambda dim, _, idx: ctx.agent(dim["prompt"], label=f"review:{dim['key']}"),
    )

    # 过滤失败的结果
    valid_reviews = [r for r in reviews if r]
    ctx.log(f"审查完成: {len(valid_reviews)}/{len(DIMENSIONS)} 维度成功")

    # ── 阶段 3：对抗验证 ──────────────────────────────────
    ctx.phase("验证")

    async def verify_finding(review_text):
        return await ctx.agent(
            f"作为资深开发者，验证以下审查发现是否为真实问题，"
            f"过滤误报。对每个发现给出 verdict: confirmed/false_positive\n\n"
            f"{review_text}",
            label="验证",
        )

    verifications = await ctx.parallel([
        lambda r=r: verify_finding(r) for r in valid_reviews
    ])

    # ── 阶段 4：汇总报告 ──────────────────────────────────
    ctx.phase("汇总")

    report = await ctx.agent(
        "汇总以下代码审查结果，按严重程度排序，给出改进建议：\n\n"
        + "\n\n---\n\n".join(v for v in verifications if v),
        label="汇总报告",
    )

    ctx.log("工作流完成!")
    return {"report": report}
