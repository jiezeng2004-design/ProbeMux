# ProbeMux v0.1.0 产品需求

状态：Implementation baseline  
日期：2026-08-25  
产品名：ProbeMux

## 1. 正式定位

ProbeMux 是一个跨 Agent 的模型能力探测与自动配置工具。

**Probe once. Configure everywhere.**

它对用户实际提供的 `Endpoint + Model` 做受限黑盒探测，生成 Agent 无关的 Canonical Capability Manifest，再通过 Adapter 为 Codex、OpenCode 和 DeepSeek Harness / DSH 生成配置。

## 2. 问题

同一个模型经过官方 API、中转站或自定义网关暴露时，可能拥有不同的：

- API protocol；
- reasoning 参数路径和值域；
- `system` / `developer` role 兼容性；
- tool/function calling 行为。

模型名称、静态目录和单次 HTTP 200 都不足以证明这些能力。错误配置可能被网关静默忽略，也可能直接产生 400。

## 3. v0.1.0 用户

- 同时使用 Codex、OpenCode、DSH 的个人开发者。
- 经常切换模型或中转站，需要减少重复配置的人。
- 维护 OpenAI-compatible Endpoint 或 DSH 插件的开发者。

## 4. 核心用户故事

| 编号 | 用户故事 | 成功结果 |
| --- | --- | --- |
| US-01 | 输入 Endpoint 后查看真实可用模型 | 输出去敏 Endpoint 指纹与 literal model ID |
| US-02 | 对一个模型执行能力探测 | 得到带证据、置信度和 UNKNOWN 的 Manifest |
| US-03 | 一次探测后配置多个 Agent | 同一 Manifest 生成三个目标配置 |
| US-04 | 修改配置前确认差异 | 先看到 diff，并生成不可静默绕过的计划 |
| US-05 | 安全应用配置 | 备份、哈希校验、原子替换；未确认则拒绝 |

## 5. v0.1.0 范围

### 5.1 Probe Engine

Probe Engine 必须与 Agent 无关，探测：

1. Protocol：
   - `POST /v1/responses`
   - `POST /v1/chat/completions`
2. Reasoning：
   - `off / none / minimal / low / medium / high / xhigh / max`
3. Reasoning 方言：
   - `reasoning.effort`
   - `reasoning_effort`
   - 以上路径在两个协议上的实际兼容结果
4. Message role：
   - `system`
   - `developer`
5. Tool/function calling：
   - 强制调用固定的无副作用函数
   - 仅检查结构，不执行模型返回的调用

### 5.2 Canonical Capability Manifest

Manifest：

- `schemaVersion = 0.1.0`；
- 主键包含 Provider、literal model ID、去敏 Endpoint 指纹；
- 分别保存协议、reasoning dialect、档位、role、tool calling；
- 每个结论保存 status、confidence、evidence IDs；
- 保留 conflicts，禁止丢弃冲突证据；
- 不包含 API key、原始响应正文或 chain-of-thought。

状态：

| 状态 | 判定 |
| --- | --- |
| `VERIFIED` | 协议结构正确、校验器明确枚举值、role 请求结构正确，或返回预期 tool call |
| `LIKELY` | 存在强端点信号，但字段可能被忽略 |
| `INFERRED` | 由静态目录或文档推导，未在当前 Endpoint 复现 |
| `UNKNOWN` | 证据不足、错误不具判别力、预算耗尽或成功响应缺少所需结构 |
| `UNSUPPORTED` | 明确的 endpoint/parameter/role/tool 拒绝 |

### 5.3 Adapter

首批只支持：

- Codex Adapter；
- OpenCode Adapter；
- DSH Adapter。

Adapter：

- 只依赖 Manifest；
- 只投影当前 Agent 能表达的 VERIFIED 交集；
- 对不可表达档位显式列入 omitted levels；
- 不静默下调默认 reasoning 档位；
- 输出 `VERIFIED / REVIEW_REQUIRED / BLOCKED` 渲染安全级别。

### 5.4 CLI

```text
probemux scan
probemux probe
probemux render
probemux diff
probemux apply
```

保留 `validate` 作为 Manifest 校验命令。

### 5.5 配置事务

固定流程：

```text
Scan → Probe → Result → Render → Diff → Backup → Apply
```

- `scan/probe/render/diff` 不修改 Agent 配置。
- `diff` 记录 target/candidate SHA-256。
- `apply` 必须传入已生成计划和 `--confirm APPLY`。
- 目标或候选在 diff 后发生变化时拒绝执行。
- 目标存在时先创建时间戳备份。
- 使用同目录临时文件原子替换。

## 6. 明确不做

- 不支持 Claude Code、Roo、Cline 或其他 Agent。
- 不根据模型名把能力标为 VERIFIED。
- 不把 HTTP 200 直接视为能力支持。
- 不执行模型返回的 tool call。
- 不做模型质量 benchmark。
- 不自动按任务难度选择 reasoning。
- 不在未经确认时覆盖配置。
- 不结构化合并任意复杂 TOML/JSONC/YAML；v0.1 应用完整、已审阅候选文件。
- 不发布 npm、GitHub Release 或自动推送远端。

## 7. 非功能与安全要求

- Node.js 22.18+，运行时零第三方依赖。
- API key 只从用户指定的环境变量读取。
- URL 去除用户名、密码、query 和 fragment。
- 默认最多 12 个主动请求；每个生成探针限制输出。
- error detail 去敏且最多 500 字符。
- Probe Engine 不导入任意 Agent Adapter。
- Adapter 是确定性纯投影。

## 8. 验收标准

1. 一次 Probe 产生可校验的 Capability Manifest。
2. 两个 protocol 独立判定。
3. 四个 reasoning path/protocol 组合独立判定。
4. HTTP 200 但响应结构错误时保持 UNKNOWN。
5. reasoning 请求 200 但没有直接证据时不标 VERIFIED。
6. tool calling 只有返回预期函数调用才 VERIFIED。
7. 同一 Manifest 能渲染 Codex、OpenCode、DSH。
8. Codex 不接受 `none/off/max` 时不静默降档。
9. apply 未确认、计划过期或候选变化时拒绝。
10. apply 前创建备份并原子替换。
11. 默认测试不访问真实 API、不读取真实密钥。

## 9. 成功指标

- 完成至少 10 个真实 Endpoint + Model 案例。
- 至少 5 个案例同时生成两个以上 Agent 的可用配置。
- 已覆盖案例的 reasoning 参数 400 降为 0。
- UNKNOWN 能清楚说明缺少哪类证据，而不是诱导用户猜测。

## 10. 后续版本

| 版本 | 建议 |
| --- | --- |
| 0.1.1 | 真实 Endpoint transcript fixture、逐档位可选验证、更多错误解析器 |
| 0.2.0 | Agent 原生配置读取与结构化 merge、漂移检测、回滚命令 |
| 0.3.0 | 稳定 Adapter SDK，再评估第四个 Agent |

## 11. 上游依据

- OpenAI reasoning 参数和值域：[Reasoning models](https://developers.openai.com/api/docs/guides/reasoning)。
- Codex 自定义 Provider、Responses wire API 与持久化 effort 值域：[Configuration Reference](https://developers.openai.com/codex/config-reference)。
- OpenCode 自定义 Provider、SDK 选择与 baseURL：[Providers](https://opencode.ai/docs/providers)；variants：[Models](https://opencode.ai/docs/models/)。
- DSH `llm-pi-ai` 的 `api/baseURL/apiKeyEnv/models[].reasoningEfforts`：[官方 README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-pi-ai/README.md)。
