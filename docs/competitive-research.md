# ProbeMux 竞品调研与需求证据

调研日期：2026-08-25  
范围：模型能力目录、API 兼容层、Agent 客户端推理设置、DSH 专用插件、同名项目。  
方法：优先使用官方文档、项目仓库和项目自身 issue/discussion；issue 用于证明用户痛点，不将单个 issue 当成普遍技术事实。

## 1. 结论先行

项目值得做，但定位必须收窄并升级：

- **需求真实且跨生态**：DSH、Codex、OpenCode、GitHub Copilot CLI、Hermes Agent 和 OpenAgent 都出现了“模型切换后推理参数不匹配、档位缺失、静默回退或直接 400”的问题。
- **DSH 单点方案已经拥挤**：短时间内出现多款 reasoning-effort 插件，说明痛点强，也说明再做一个 DSH UI 插件差异不足。
- **静态目录赛道已有强者**：models.dev 已经提供 provider/model 级 `reasoning_options`，并被 OpenCode 使用。ProbeMux 不应复制一份静态模型表。
- **剩余机会**：把目录作为候选证据，对用户实际端点做安全探测，保留 Provider/Protocol 差异，再投影到多个 Agent 配置。这一闭环目前没有看到成熟、专门的开源方案。

推荐定位：**evidence-first capability probe + cross-agent config compiler**。

## 2. 需求证据

| 生态 | 观察到的问题 | 对 ProbeMux 的启示 |
| --- | --- | --- |
| DSH | 自定义 OpenAI-compatible 模型没有 `reasoningEfforts`，UI 不显示档位；手写配置还可能触发 `developer` role 兼容问题。[DSH discussion #843](https://github.com/deepseek-ai/deepseek-harness/discussions/843) | 能力和协议兼容必须分开建模；只注入档位可能制造新 400 |
| Codex | 用户请求按任务动态选择 effort，原因包括手动选择成本、简单任务过度推理和复杂任务推理不足。[Codex issue #8649](https://github.com/openai/codex/issues/8649) | 自动策略有需求，但应作为后续层，不与 v0.1 能力发现混合 |
| Hermes Agent | 全局 `reasoning_effort` 无法适配不同模型，用户希望切换模型时应用每模型设置。[Hermes issue #15511](https://github.com/NousResearch/hermes-agent/issues/15511) | 需要 per-provider-model profile，而不是全局值 |
| OpenAgent | GPT 模型继承 Claude `thinking` 配置，需按 Provider 自动清理并应用 `reasoningEffort`。[issue #144](https://github.com/code-yeongyu/oh-my-openagent/issues/144) | adapter 必须知道字段形状，不能只换模型 ID |
| GitHub Copilot CLI | Auto 从支持 reasoning 的模型切到不支持模型后仍携带 `high`，返回 400。[issue #2870](https://github.com/github/copilot-cli/issues/2870) | 参数生命周期和模型切换需绑定；unsupported 时应 omit |
| OpenCode | 用户请求按任务复杂度自动选择档位；另有 max 档位缺失、配置生效但 UI 不显示等问题。[issue #21483](https://github.com/anomalyco/opencode/issues/21483)、[issue #36141](https://github.com/anomalyco/opencode/issues/36141) | 目录、请求层和 UI 有三套状态，工具应给出 effective projection 与警告 |

DSH 内部已经出现多种相近插件，例如 [dsh-reasoning-effort](https://github.com/HanaAyane/dsh-reasoning-effort)、[dsh-thinking-effort](https://github.com/hytime/dsh-thinking-effort)、[dsh-better-reasoning-effort](https://github.com/HaoyueQin/dsh-better-reasoning-effort) 和 [custom-provider-enhancer](https://github.com/cinob/dsh-plugin-custom-provider-enhancer)。这证明需求强，但也把“只服务 DSH 的推理档位 UI”变成红海。

## 3. 直接与相邻竞品

### 3.1 models.dev

[models.dev](https://github.com/anomalyco/models.dev) 是最重要的上游与潜在替代品。它提供开源模型规格、价格、能力和 API，数据按模型实验室与具体 Provider 分层；其维护规范已经要求 reasoning 模型写 `reasoning_options`，且明确反对为所有推理模型发明统一 low/medium/high。

优势：

- Provider/Model 数据面广，社区维护，MIT。
- 已把 `reasoning = true` 与 `reasoning_options` 分开。
- OpenCode 等下游已经使用，生态势能强。

缺口：

- 目录记录不等于用户当前 endpoint 的实测结果。
- 不负责把同一条目编译成 Codex、OpenCode、DSH 配置。
- 无法确认中转站是否过滤、改名、忽略或错误映射字段。

决策：**不竞争、不 fork 数据库；把它作为默认候选证据源。**

### 3.2 LiteLLM

[LiteLLM reasoning 文档](https://docs.litellm.ai/docs/reasoning_content) 提供跨 Provider 参数翻译、`supports_reasoning()` 和代理层能力。它能解决大量运行时兼容问题。

优势：

- 覆盖 Provider 多，转换逻辑成熟。
- 处于真实请求路径，能统一协议和观察 usage。

缺口：

- 是 SDK/网关，不是轻量的能力审计与多 Agent 配置生成器。
- 能力判断依赖内置 model map；新模型可能需要升级 LiteLLM。
- 引入代理会改变用户架构，ProbeMux 的目标是可独立、只读地工作。

决策：把 LiteLLM 视为可选证据源/未来 adapter，而不是依赖它做核心。

### 3.3 OpenRouter Models API

[OpenRouter Models API](https://openrouter.ai/docs/guides/overview/models) 暴露 `supported_parameters` 并能按参数筛选模型。

优势：

- hosted model/provider 数据及时。
- 可直接知道某个 OpenRouter 路由是否宣称支持 `reasoning`。

缺口：

- 主要描述 OpenRouter 自己的路由，不能代表任意自建/第三方 endpoint。
- `supported_parameters` 通常只能证明存在 `reasoning` 参数，未必给出全部档位和 wire 映射。
- 不生成本地 Agent 配置。

决策：OpenRouter 路由的高价值 provider catalog source。

### 3.4 Aider

[Aider reasoning 配置](https://aider.chat/docs/config/reasoning.html) 区分 `reasoning_effort` 与 `thinking_tokens`，并用 `accepts_settings` 防止向不支持模型发送参数。

优势：

- 用户体验清楚：不支持的设置会警告并忽略。
- 已证明“每模型 accepts settings”是有效设计。

缺口：

- 元数据服务于 Aider 自身，不产出可移植档案。
- Provider 映射逻辑仍嵌在客户端实现中。

决策：借鉴它的安全默认值和强制覆盖机制，不复制其内部模型表。

### 3.5 DSH reasoning 插件

优势：

- 最贴近 DSH 用户，安装后立即看到 UI 改善。
- 一些插件支持任意规范档位到 wire value 的映射。

缺口：

- 多数是 DSH-only。
- 一些方案给未知模型自动注入 Off/High/Max；这方便但属于猜测。
- 只解决 UI/配置的一面，无法证明中转站是否实际接受和执行参数。

决策：ProbeMux 未来提供 DSH adapter 或插件调用的能力档案，不与这些插件抢 UI。

### 3.6 各 Agent 的内建能力

- Codex 已提供 `model_reasoning_effort`，但客户端值域与 API 模型值域可能不同；[官方配置参考](https://developers.openai.com/codex/config-reference)。
- OpenCode 使用 AI SDK 和 models.dev，并允许自定义 variants；[官方模型文档](https://opencode.ai/docs/models/)。
- Claude Code 等其他 Agent 也存在独立能力声明，但不进入 v0.1.0；只有在三 Agent 核心抽象稳定后再评估扩展。

这些客户端不是 ProbeMux 的竞品，而是目标后端。它们说明 adapter 不能只是换文件格式，还要计算每个目标的表达能力交集。

### 3.7 同名项目

名称存在明确冲突：

- [cuihuan/modelprobe](https://github.com/cuihuan/modelprobe) 是 OpenAI-compatible 网关可用性与延迟探针。
- npm 已有 [`model-probe`](https://www.jsdelivr.com/package/npm/model-probe)，用于探测网关模型与元数据。
- PyPI 已有 `modelprobe` 评测/回归测试包记录。

历史结论：`ModelProbe` 仅作为早期工作名。当前本地项目已正式改名为 ProbeMux；公开发布前必须重新做 GitHub/npm/PyPI/域名检索，当前代码包保持 private。

## 4. 竞品矩阵

| 方案 | 静态目录 | 用户端点实测 | 推理 wire 映射 | 多 Agent 配置生成 | 不引入代理 | 证据/不确定性 |
| --- | --- | --- | --- | --- | --- | --- |
| models.dev | 强 | 无 | 强（目录层） | 无 | 是 | 部分 |
| LiteLLM | 强 | 处于运行路径 | 强 | 无 | 否 | 较弱 |
| OpenRouter API | 强（自家路由） | 仅 OpenRouter | 中 | 无 | 是 | 较弱 |
| Aider metadata | 中 | 无 | 中 | 仅 Aider | 是 | 警告型 |
| DSH reasoning 插件 | 弱到中 | 通常无 | DSH 内强 | 仅 DSH | 是 | 多数较弱 |
| 现有 modelprobe | 无 | 可用性/延迟 | 无 | 无 | 是 | 健康检查型 |
| ProbeMux 目标 | 借用上游 | 强、显式、受限 | 强 | Codex/OpenCode/DSH | 是 | 强 |

## 5. 差异化护城河

### 5.1 不是另一份模型表

目录数据变化太快，models.dev 已经更适合承担社区事实库。ProbeMux 的本地 overlay 只保存：

- 用户端点观察结果；
- 显式 override；
- 目标客户端投影；
- 与上游目录的冲突和漂移。

### 5.2 “接受”与“生效”分级

许多 OpenAI-compatible 网关会忽略未知字段。单次 2xx 不能证明 reasoning effort 生效。ProbeMux 的 evidence 状态需要区分：

- declared；
- rejected；
- accepted；
- observed；
- verified mapping。

### 5.3 同时理解模型端和客户端

例如一个模型有 `max`，并不意味着 Codex 持久化配置、OpenCode variant 或 DSH `reasoningEfforts` 都能安全表达它。投影器必须同时读取 source capability 与 target capability。

### 5.4 可供插件复用的稳定 profile

DSH 插件、OpenCode 插件或 MCP 只消费统一 JSON profile，不在每个插件中重复维护模型名规则和协议映射。

## 6. 主要风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| models.dev 快速补齐更多能力 | 静态部分失去价值 | 将其作为上游，专注实测与投影 |
| 主动探测产生费用或触发限流 | 用户不信任 | 默认被动；显式 active；1 token/1 request 上限 |
| 网关静默忽略参数 | 假阳性 | 2xx 只标 accepted，不标 verified |
| 错误消息格式不稳定 | 探针解析脆弱 | Provider-specific parser + 原始分类测试 + unknown fallback |
| Agent 配置版本快速变化 | adapter 漂移 | target capability versioning、fixture 测试、drift checks |
| 名称冲突 | 搜索和发布混淆 | 发布前改名，当前包 private |
| 范围膨胀到自动调度/benchmark | v0.1 无法交付 | 自动 effort policy 与质量评测明确排除 |

## 7. Go / No-Go 判断

**Go，但按窄切口推进。**

首个可验证闭环应是：

1. 输入自定义 endpoint + model；
2. 合并 `/v1/models`、models.dev 与可选枚举探针；
3. 生成 evidence-rich profile；
4. 输出 DSH + 至少一个非 DSH 客户端配置；
5. 用真实中转站验证配置不再出现 reasoning 参数 400。

若 10 个真实案例中，大多数仅靠 models.dev 就完全正确，且用户不需要多 Agent 配置，那么项目应收缩为 models.dev 的 adapter 工具；反之，端点差异和配置投影就是长期价值。
