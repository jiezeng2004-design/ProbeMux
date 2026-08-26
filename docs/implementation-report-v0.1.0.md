# ProbeMux v0.1.0 MVP 实施报告

日期：2026-08-25

## 1. 修改前基线

- `ModelProfile 0.1`，重点为 reasoning 证据与只读配置投影。
- CLI：`validate / render / discover / probe-openai`。
- Adapter：DSH、Codex、OpenCode、Claude Code。
- 主动探测：用户先指定协议，仅测试一个默认 reasoning 参数路径。
- 没有 protocol、role、tool 的统一 Probe Engine。
- 没有 diff/backup/apply。
- 基线测试：16/16 通过。
- 目录不是 Git 工作树；修改前 zip 为可复查基线。

详细对比见 [Gap Analysis](gap-analysis-v0.1.0.md)。

## 2. 实际修改文件

### 命名迁移（本轮）

- 项目目录由 `ModelProbe/` 改为 `ProbeMux/`。
- package、CLI、Capability Manifest、scan result、diff plan、备份/临时文件前缀和默认 API-key 环境变量统一为 `ProbeMux` / `probemux` / `PROBEMUX_API_KEY`。
- README、PRD、架构、竞品调研和 ADR 已同步为正式名称；历史同名项目仅在调研证据中保留。

### 新增

- `schema/capability-manifest.schema.json`
- `schema/README.md`
- `src/domain/manifest.ts`
- `src/probes/probe-engine.ts`
- `src/config/transaction.ts`
- `examples/manifests/verified-fixture.json`
- `docs/gap-analysis-v0.1.0.md`
- `docs/implementation-report-v0.1.0.md`
- `test/probe-engine.test.ts`
- `test/config-transaction.test.ts`
- `test/cli.integration.test.ts`

### 修改

- `README.md`
- `package.json`
- `docs/PRD-v0.1.0.md`
- `docs/architecture-v0.1.0.md`
- `docs/competitive-research.md`
- `src/cli.ts`
- `src/index.ts`
- `src/adapters/types.ts`
- `src/adapters/shared.ts`
- `src/adapters/codex.ts`
- `src/adapters/opencode.ts`
- `src/adapters/dsh.ts`
- `src/adapters/index.ts`
- `test/fixtures.ts`
- `test/adapters.test.ts`

### 从 v0.1 MVP 移除

- `src/adapters/claude-code.ts`
- `examples/profiles/deepseek-v4-pro.json`

旧 ModelProfile、resolver、catalog importer 和单 reasoning probe 保留，避免无关重构，并为后续迁移保留基础。

## 3. 架构

```text
Probe Engine
    ↓
Canonical Capability Manifest 0.1.0
    ↓
Adapter Layer
    ├── Codex
    ├── OpenCode
    └── DSH
```

配置事务独立位于 Adapter 之后：

```text
Scan → Probe → Result → Render → Diff → Backup → Apply
```

Probe Engine 没有 Agent import；Adapter 没有网络 import。

## 4. Probe 判定逻辑

| 能力 | VERIFIED 条件 | 不足证据时 |
| --- | --- | --- |
| Protocol | 2xx 且响应满足对应协议结构 | 200 错误结构 → UNKNOWN |
| Reasoning 方言 | 400 validator 明确枚举 allowed values | 200 无直接信号 → UNKNOWN；有 reasoning signal → LIKELY |
| Reasoning 档位 | validator 明确列出的具体值 | 不根据模型名填充 |
| system/developer | baseline 已验证，role 请求返回对应协议结构 | 无判别力错误 → UNKNOWN |
| Tool calling | 返回强制的 `probemux_echo` function call | 200 但只有文本 → UNKNOWN |

主动探测默认最多 12 请求，不执行 tool call，不保存完整响应。

## 5. Agent 配置映射

| Manifest | Codex | OpenCode | DSH |
| --- | --- | --- | --- |
| Responses VERIFIED | `wire_api="responses"` | `@ai-sdk/openai` | `api: openai-responses` |
| Chat VERIFIED | 不可作为自定义 Provider wire API | `@ai-sdk/openai-compatible` | `api: openai-completions` |
| `reasoning.effort` | `model_reasoning_effort` | `variants.*.reasoningEffort` | `reasoningEfforts` |
| `reasoning_effort` | 不直接投影 | `variants.*.reasoningEffort` | `reasoningEfforts` |
| `none` | 省略 | variant `none` | label `off`，wire `none` |
| `max` | 省略且警告，不降到 xhigh | variant `max` | `max: max` |

DSH 的用户默认档位另写入 `agent-default-model.reasoningEffort`，只接受已验证档位。
OpenCode 的用户默认档位写入模型 `options.reasoningEffort`，variants 仍保留其他已验证档位。

Codex 当前官方配置只允许 `minimal/low/medium/high/xhigh` 且自定义 Provider 使用 Responses：[官方配置参考](https://developers.openai.com/codex/config-reference)。OpenCode 根据协议选择对应 AI SDK package：[官方 Provider 文档](https://opencode.ai/docs/providers)。DSH 使用 `llm-pi-ai.providers.*.api` 和 `models[].reasoningEfforts`：[官方 README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-pi-ai/README.md)。

## 6. 配置安全

- `render` 只生成 candidate。
- `diff` 对 current/candidate 生成 SHA-256 计划。
- `apply` 必须明确 `--confirm APPLY`。
- target 或 candidate 变化时拒绝。
- target 存在时先备份。
- 同目录临时文件 + rename 原子替换。

## 7. 测试结果

- 修改前：16/16。
- 修改后：22/22。
- TypeScript 文件 `node --check`：通过。
- JSON/schema/fixture 解析：通过。
- Capability Manifest fixture 校验：通过。
- 默认测试没有真实网络请求或真实 API key。

## 8. 已知限制

- 完整 Probe 最多 12 次，仍可能产生少量 token 费用。
- reasoning 依赖错误枚举；静默忽略参数的网关会保持 UNKNOWN。
- role VERIFIED 只代表请求结构兼容，不代表模型遵循该 role 的语义。
- 还没有逐档位的对照行为实验。
- v0.1 apply 替换用户审阅后的完整 candidate，不结构化 merge 任意 TOML/JSONC/YAML。
- OpenCode 和 DSH 配置格式仍在快速演进，需要版本化 fixture。
- 没有真实用户 Endpoint smoke；默认测试全部使用 fake fetch。
- ProbeMux 已是当前本地项目、CLI 与 package 名；公开发布前仍需做注册可用性检查。

## 9. 下一版本建议

v0.1.1 聚焦真实世界校准，不扩 Agent：

1. 用 3–5 个真实中转站/官方 Endpoint 生成脱敏 transcript fixture。
2. 增加可选逐档位验证与 `--max-cost` / `--max-requests` 护栏。
3. 增加 Provider-specific error parser registry。
4. 为 Codex/OpenCode/DSH 增加上游版本 fixture 和 drift check。
5. 在确认可靠性后，再为三个目标实现原生配置 parser/structural merge。
