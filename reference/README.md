# 参考库

`reference/deepseek-harness` 是 DeepSeek Harness（DSH）源码的只读 git 子模块，固定在
`46a7f68b0922371ce7144b668b90e377d8e799f4`（`rel/dsh-0.1.7-rc.1`，2026-09-23，MIT）。

- 只供对照阅读；不参与 `pnpm install`、构建、测试与 CI（工作流不检出子模块）。
- 不要在这里修改代码；Nexgent 需要的实现按 [`docs/reference-map.md`](../docs/reference-map.md)
  的对照表改写进 `packages/*`，复制的文件在头部注明来源并登记到
  [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)。
- 获取方式（无需完整历史）：

```sh
git clone --no-checkout --filter=blob:none https://github.com/deepseek-ai/deepseek-harness.git reference/deepseek-harness
git -C reference/deepseek-harness checkout 46a7f68b0922371ce7144b668b90e377d8e799f4
```

更换参考版本时同时更新子模块指针、本文件、`docs/reference-map.md` 与 `THIRD_PARTY_NOTICES.md`。
