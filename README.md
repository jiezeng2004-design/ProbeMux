# ProbeMux

**Probe once. Configure everywhere.**

ProbeMux 是一个跨 Agent 的模型能力探测与自动配置工具。它针对用户实际提供的模型 Endpoint 进行黑盒探测，生成 Agent 无关的 Canonical Capability Manifest，再通过 Adapter 生成 Codex、OpenCode 和 DeepSeek Harness / DSH 配置。

当前状态：`v0.1.0-dev` MVP。项目包保持 `private`，不会发布 npm 或自动推送远端。

## v0.1.0 支持范围

- API protocol：`/v1/responses`、`/v1/chat/completions`。
- Reasoning 档位：`off / none / minimal / low / medium / high / xhigh / max`。
- Reasoning 方言：`reasoning.effort`、`reasoning_effort`，并分别在两个协议上探测。
- Message role：`system`、`developer`。
- 基础 tool / function calling。
- Agent Adapter：Codex、OpenCode、DSH。

Claude Code、Roo、Cline 等不属于 v0.1.0。

## 架构

```text
Probe Engine
    ↓
Canonical Capability Manifest
    ↓
Adapter Layer
    ├── Codex Adapter
    ├── OpenCode Adapter
    └── DSH Adapter
```

Probe Engine 不依赖具体 Agent。Adapter 只读取 Manifest，不参与网络探测。

## 安全工作流

```text
Scan → Probe → Result → Render → Diff → Backup → Apply
```

- `scan` 只读取 `/v1/models`。
- `probe` 必须显式传入 `--active`，默认最多 12 个受限请求。
- `render` 只生成候选配置。
- `diff` 固化当前文件和候选文件的 SHA-256。
- `apply` 只有在目标和候选均未变化、且明确传入 `--confirm APPLY` 时才执行。
- 修改前创建时间戳备份，并通过同目录临时文件原子替换。

v0.1.0 的 `apply` 写入的是用户已经审阅的完整候选文件，不尝试无依赖解析和结构化合并任意 TOML/JSONC/YAML。

## Capability 状态

| 状态 | 含义 |
| --- | --- |
| `VERIFIED` | 有直接、可复现的端点行为或明确校验响应 |
| `LIKELY` | 有较强端点信号，但无法证明参数实际生效 |
| `INFERRED` | 来自目录、官方资料或其他间接证据 |
| `UNKNOWN` | 证据不足、请求失败或 HTTP 成功但响应结构/行为不符合预期 |
| `UNSUPPORTED` | 端点明确拒绝对应协议、字段、role 或 tool |

HTTP 200 本身不会得到 `VERIFIED`。例如 reasoning 请求只有在服务端明确枚举允许值时才验证档位；tool calling 只有返回预期的真实 function call 才验证。

## 快速体验

需要 Node.js 22.18+。唯一运行时依赖是 `yaml`（用于保留注释的最小 leaf-level 配置补丁），首次使用先安装：

```bash
npm install
node src/cli.ts --help
node --test test/*.test.ts
node src/cli.ts validate examples/manifests/verified-fixture.json
```

## DSH Quick Start

> If DSH is already configured, you do not need to re-enter the Base URL, model, or API key.
> ProbeMux reads the existing DSH configuration and credential reference, probes the actual
> endpoint, and patches only the verified model capabilities.

首先查看 ProbeMux 从 DSH 自动发现了什么（不发送任何探测请求）：

```bash
probemux dsh inspect
# 或 JSON 输出
probemux dsh inspect --json
```

一键探测 + 生成最小候选补丁并展示 diff（**不会写入任何内容**）：

```bash
probemux dsh sync --active
# ...
# Re-run with --confirm APPLY to apply this configuration.
```

审阅 diff 后真正写回（保留时间戳备份 + 原子替换）：

```bash
probemux dsh sync --active --confirm APPLY
```

DSH 集成流程：自动发现 `DSH_HOME`（`--dsh-home` 可覆盖）→ 读取 `agent-default-model` 与 provider 配置（`llm-pi-ai.providers.<id>` 或 `deepseek-official`）→ 解析 endpoint 与 credential 引用 → 探测真实端点（必须 `--active`）→ 只把 **VERIFIED** 的 reasoningEfforts 以最小 leaf-level patch 合并进目标 model（显式 `models` 列表内合并该条目；catalog 路由走 `modelOverrides` merge，绝不替换整个 catalog）。

安全边界：

- **ProbeMux never writes your API key into a Capability Manifest or settings.yaml.** API key 只通过引用解析（process env → `$DSH_HOME/.credentials.yaml` → `cwd/.env` → `$DSH_HOME/.env`），只存运行时内存，任何输出都会被 redact。
- 无显式 `baseURL` 的 catalog provider 不会被猜测 endpoint，明确提示 `catalog-derived and ProbeMux cannot resolve it safely yet`。
- `deepseek-official` 的 reasoning 档位受当前 DSH 版本 whitelist 限制，无法安全确认时只输出 warning 且不写入任何档位，推荐改用 `llm-pi-ai` custom route。
- 显式 `--default-effort` 未 VERIFIED 时拒绝写入；未显式指定且当前档位失效时，自动选择 VERIFIED 的 `high`（无则取最高非 off 档位），任何默认档位变化都会出现在 diff 中。
- 已有 `baseURL` / `apiKeyEnv` / `displayName` / `headers` / `retryPolicy` / `timeout` / `transport` / `compat` / `contextWindow` / `maxTokens` / `input` 等配置、其他 model、其他 provider、未知 section 与注释全部原样保留。

`render` 与 `dsh sync` 概念分离：`render` 从 Manifest 生成独立候选配置；`dsh sync` 只对现有 settings.yaml 做最小 leaf-level patch，二者互不替代。

完整闭环：

```bash
PROBEMUX_API_KEY=... node src/cli.ts scan \
  --base-url https://api.example.com/v1 \
  --api-key-env PROBEMUX_API_KEY \
  --output scan.json

PROBEMUX_API_KEY=... node src/cli.ts probe \
  --base-url https://api.example.com/v1 \
  --provider-id my-provider \
  --model my-model \
  --api-key-env PROBEMUX_API_KEY \
  --active \
  --output manifest.json

node src/cli.ts render manifest.json \
  --target codex \
  --default-effort high \
  --api-key-env PROBEMUX_API_KEY \
  --output candidate.toml

node src/cli.ts diff \
  --current ~/.codex/config.toml \
  --candidate candidate.toml \
  --plan codex-plan.json

node src/cli.ts apply --plan codex-plan.json --confirm APPLY
```

## 文档

- [v0.1.0 PRD](docs/PRD-v0.1.0.md)
- [v0.1.0 架构](docs/architecture-v0.1.0.md)
- [Gap analysis](docs/gap-analysis-v0.1.0.md)
- [v0.1.0 实施报告](docs/implementation-report-v0.1.0.md)
- [竞品与需求证据](docs/competitive-research.md)
- [证据优先 ADR](docs/adr/0002-evidence-first.md)

## 命名

项目、CLI 和本地 package 已正式命名为 `ProbeMux` / `probemux`。该工作区保持 `private`；在公开发布前仍须单独完成名称与包注册可用性检查。
