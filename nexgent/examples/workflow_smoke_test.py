"""Smoke test: 最简工作流，验证 agent() 调用能实际执行。"""

async def main(ctx, args):
    ctx.phase("测试")

    # 单个 agent 调用
    result = await ctx.agent(
        "用一句话回答：1+1等于几？",
        label="算术",
    )

    ctx.log(f"结果: {result}")
    return {"answer": result}
