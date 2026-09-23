# 可携带能力发布合同 v1

日期：2026-09-24。状态：**E1 合同已实现；发布、运行与跨任务采用未实现。**

## 问题与边界

任务内模型可开发 `tool/local_compute` 和 `service_provider/model_context.v1`。其 Definition、bundle、Instance 均绑定创建它的 Episode；直接删除 `origin_episode_id` 校验或把同名处理器加入全局注册表，会绕过独立评价和新任务的授权边界。

`CapabilityRelease v1` 是内容寻址的**惰性候选材料**。`build_capability_release(definition, package)` 只接受已验证的这两类纯 Definition，冻结源码、公共 schema、接口、effect、运行时、空依赖锁及 creator Definition/package 谱系。`verify_capability_release` 重建源 Episode 的 Definition 校验谱系，即使有人重算 release 摘要，也不能悄悄换来源或权限要求。`authority_requirements` 仅描述要求，不含 EpisodeAuthority grant、预算或部署状态。

```text
creator Episode 中实际调用的 Definition/Instance
  → 惰性 CapabilityRelease + 来源/使用收据校验
  → AgentPackage 的 S 组件候选（PackagePatch v3 / Generation）
  → 同授权的父子独立评价、guard、晋升
  → 后续 Episode 从已晋升 AgentPackage 执行该 S 组件
```

后续 Episode **不重挂源 Definition，也不伪造新的源 Episode Definition**。已晋升 AgentPackage 的组件应由宿主按 package/component digest 直接执行，保留独立的 package 能力收据；任务内动态 Definition 则继续按原有 origin-bound 路径执行。两条来源在 inventory、预算、加载证据中必须区分。

## 尚未通过的出口

- 目前没有 release 持久候选登记、creator 成功使用检查或 FeedbackBundle 绑定。单独调用 builder 不能晋升。
- Package manifest 尚未承载 tool/service 的 S 组件，Generation closure 尚未重放这些组件。
- 后续任务没有 package 能力的执行、调用预算和身份收据，也没有针对能力**真实使用**的激活门。
- MiMo 图任务仍是负结果；没有任务来源能力在独立任务中取得净收益的证据。

实施顺序：先补 manifest/patch 组件合同，再补 package 能力受控执行与来源收据；其后让 creator 的成功使用收据与 FeedbackBundle 共同形成 Generation 候选，经配对选择、guard、晋升后验证新 Episode 复用。正式效果对照在这条真实闭环之后。

参考边界：[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Agent 作用域 provider 与插件管理提供本地隔离参考；[AutoSci 论文版本](https://github.com/skyllwt/AutoSci/tree/arxiv-v1) 的 SciEvolve、[ADAS](https://arxiv.org/abs/2408.08435v2) 和 [AFlow](https://arxiv.org/abs/2410.10762v4) 提醒我们以跨任务候选选择和行为效果为验收，而非以 release 对象存在为验收。
