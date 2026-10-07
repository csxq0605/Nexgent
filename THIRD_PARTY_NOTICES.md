# Third-Party Notices / 第三方软件声明

Nexgent 以 [MIT](LICENSE) 许可发布。本文件列出 Nexgent 使用、参考或改写的第三方软件；每个项目仍受其自身许可约束，本文件不改变这些条款。npm 依赖的完整传递闭包以精确版本记录在工作区的 `pnpm-lock.yaml` 中，可用 `pnpm licenses list` 查看。

## 组件

| 组件 | 版本 / 提交 | 用途 | 许可 | 版权 |
| --- | --- | --- | --- | --- |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`deepseek-ai/deepseek-harness`） | `46a7f68b0922371ce7144b668b90e377d8e799f4`（0.1.7-rc.1） | 只读参考（`reference/deepseek-harness` 子模块，不参与构建）；部分文件复制后改写进 Nexgent，见下方清单 | MIT | Copyright (c) 2026 DeepSeek |
| [`@deepseek-ai/cordis`](https://www.npmjs.com/package/@deepseek-ai/cordis)（上游 `cordis`） | 4.0.4 | 运行架构（npm 依赖） | MIT | Copyright (c) 2021-present Shigma |
| [`@deepseek-ai/schemastery`](https://www.npmjs.com/package/@deepseek-ai/schemastery)（上游 `schemastery`） | 3.18.4 | 配置 schema（npm 依赖） | MIT | Copyright (c) 2021-present Shigma |
| [`@cordisjs/loader`](https://www.npmjs.com/package/@cordisjs/loader) | 以 `pnpm-lock.yaml` 为准 | YAML profile 装载（npm 依赖） | MIT | Shigma |

`@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery` 是 DeepSeek 对上游 `cordis` / `schemastery` 的再发布，包内保留上游 LICENSE。

## 从 DeepSeek Harness 改写的文件

从参考库复制并改写的每个文件，第一行注明 `Adapted from deepseek-harness@46a7f68b <path>`，并在此登记。规则见 [`docs/reference-map.md`](docs/reference-map.md)。

| Nexgent 路径 | 来源（参考库内路径） |
| --- | --- |
| （尚无；步骤 1 开始登记） | |

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
