# Third-Party Notices / 第三方软件声明

Nexgent 以 [MIT](LICENSE) 许可发布。本文件列出 Nexgent 使用、参考或改写的第三方软件；每个项目仍受其自身许可约束，本文件不改变这些条款。npm 依赖的完整传递闭包以精确版本记录在工作区的 `pnpm-lock.yaml` 中，可用 `pnpm licenses list` 查看。

## 组件

| 组件 | 版本 / 提交 | 用途 | 许可 | 版权 |
| --- | --- | --- | --- | --- |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`deepseek-ai/deepseek-harness`） | `46a7f68b0922371ce7144b668b90e377d8e799f4`（0.1.7-rc.1） | 只读参考（`reference/deepseek-harness` 子模块，不参与构建）；部分文件复制后改写进 Nexgent，见下方清单 | MIT | Copyright (c) 2026 DeepSeek |
| [`@deepseek-ai/cordis`](https://www.npmjs.com/package/@deepseek-ai/cordis)（上游 `cordis`） | 4.0.4 | 运行架构（npm 依赖） | MIT | Copyright (c) 2021-present Shigma |
| [`@deepseek-ai/schemastery`](https://www.npmjs.com/package/@deepseek-ai/schemastery)（上游 `schemastery`） | 3.18.4 | 配置 schema（npm 依赖） | MIT | Copyright (c) 2021-present Shigma |
| [`@cordisjs/loader`](https://www.npmjs.com/package/@cordisjs/loader) | 以 `pnpm-lock.yaml` 为准 | YAML profile 装载（npm 依赖） | MIT | Shigma |
| [`fflate`](https://www.npmjs.com/package/fflate) | 0.8.3 | `@nexgent/skill`：解压 `.docx` / `.xlsx`（npm 依赖） | MIT | Copyright (c) 2026 Arjun Barrett |
| [`unpdf`](https://www.npmjs.com/package/unpdf) | 1.8.1 | `@nexgent/skill`：读取 `.pdf` 文本（npm 依赖） | MIT | Copyright (c) 2023-PRESENT Johann Schopplich |
| [`turndown`](https://www.npmjs.com/package/turndown) | 7.2.4 | `@nexgent/web`：HTML 转 Markdown（npm 依赖） | MIT | Copyright (c) 2017 Dom Christie |
| [`@mixmark-io/domino`](https://www.npmjs.com/package/@mixmark-io/domino)（`turndown` 的依赖） | 2.2.0 | `turndown` 在 Node 下解析 HTML 用的 DOM | BSD-2-Clause | Copyright (c) 2011 The Mozilla Foundation |
| [`@joplin/turndown-plugin-gfm`](https://www.npmjs.com/package/@joplin/turndown-plugin-gfm) | 1.0.67 | `@nexgent/web`：GitHub 风格表格（npm 依赖） | MIT | Copyright (c) 2017 Dom Christie |
| [PDF.js](https://github.com/mozilla/pdf.js)（打包在 `unpdf` 内） | 6.1.x（随 `unpdf` 1.8.1） | `.pdf` 解析 | Apache-2.0 | Copyright Mozilla Foundation |

`@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery` 是 DeepSeek 对上游 `cordis` / `schemastery` 的再发布，包内保留上游 LICENSE。

## 从 DeepSeek Harness 改写的文件

从参考库复制并改写的每个文件，第一行注明 `Adapted from deepseek-harness@46a7f68b <path>`，并在此登记。规则见 [`docs/reference-map.md`](docs/reference-map.md)。

| Nexgent 路径 | 来源（参考库内路径） |
| --- | --- |
| `packages/kernel/src/util/atomic-write.ts` | `packages/util/atomic-write/src/index.ts`、`packages/storage/storage-json/src/atomic.ts` |
| `packages/kernel/src/util/timeout.ts` | `packages/util/timeout/src/index.ts` |
| `packages/kernel/src/storage/json-file.ts` | `packages/storage/storage-json/src/index.ts` |
| `packages/kernel/src/profile.ts` | `packages/boot/app-boot/src/profile.ts`、`packages/boot/app-boot/src/profile-plugins.ts` |
| `packages/kernel/src/app.ts` | `packages/boot/app-boot/src/index.ts` |
| `packages/kernel/src/agents.ts` | `packages/core/agent/src/index.ts`、`packages/core/agent-default-model/src/index.ts` |
| `packages/kernel/src/tools.ts` | `packages/core/tools/src`（作用域注册表设计）、`packages/core/scope/src/index.ts` |
| `packages/workspace/src/paths.ts` | `packages/fs/fs-sandbox/src/containment.ts` |
| `packages/workspace/src/process.ts` | `packages/subprocess/subprocess-local/src/spawn.ts` |
| `apps/cli/src/json-lines.ts` | `packages/bundle/headless/src/json-stream.ts` |
| `packages/web/src/markdown.ts` | `packages/web/tool-web/src/fetch.ts`（turndown 规则与嵌套深度保护） |
| `packages/web/src/turndown-plugin-gfm.d.ts` | `packages/web/tool-web/src/turndown-plugin-gfm.d.ts` |

`@nexgent/session` 与 `packages/test-support` 没有复制件（只参考设计）。`apps/cli/bin/nexgent.ps1` 移植自 Nexgent 自己的 PR #4 `run.ps1`，不是 DeepSeek Harness 代码。按包划分的“复制 / 只参考设计”清单见 `docs/reference-map.md` §步骤 1 复制件登记。

## MIT License

以下许可文本适用于上表中标为 MIT 的全部组件，版权行以各组件自身的 LICENSE 文件为准。

```text
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Apache License 2.0

上表中标为 Apache-2.0 的组件（PDF.js）按 Apache License, Version 2.0 授权，全文见 <https://www.apache.org/licenses/LICENSE-2.0>。Nexgent 未修改其代码，只经 `unpdf` 的打包版本调用。

## BSD 2-Clause License

上表中标为 BSD-2-Clause 的组件（`@mixmark-io/domino`，经 `turndown` 间接使用，Nexgent 未修改）的许可全文：

```text
Copyright (c) 2011 The Mozilla Foundation.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

    Redistributions of source code must retain the above copyright
    notice, this list of conditions and the following disclaimer.

    Redistributions in binary form must reproduce the above copyright
    notice, this list of conditions and the following disclaimer in the
    documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS
IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED
TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A
PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED
TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```
