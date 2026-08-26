# ProbeMux

**Probe once. Configure everywhere.**

[![npm](https://img.shields.io/npm/v/probemux?label=npm)](https://www.npmjs.com/package/probemux)
[![CI](https://github.com/jiezeng2004-design/ProbeMux/actions/workflows/ci.yml/badge.svg)](https://github.com/jiezeng2004-design/ProbeMux/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.18-339933)](package.json)

ProbeMux 是一个跨 Agent 的模型能力探测与自动配置工具。它针对你**实际使用的模型 Endpoint** 做黑盒能力探测，生成 Agent 无关的 Canonical Capability Manifest，再通过 Adapter 为 Codex、OpenCode 生成配置，并为 DeepSeek Harness / DSH 提供完整的配置同步工作流。

当前状态：`v0.1.0` 已正式发布，npm 包名为 `probemux`。

## 为什么需要 ProbeMux？

同一个模型接到不同 Coding Agent 后，经常遇到这些问题：

- 模型明明支持 reasoning，但 Agent 不知道该用 `medium`、`high` 还是 `max`。
- 同一能力在不同 API / Provider 上字段不一样，例如 `reasoning.effort` 与 `reasoning_effort`。
- Codex、OpenCode、DSH 的配置格式和能力声明方式不同。
- “请求返回 HTTP 200”并不代表某个参数真的生效。
- 手工改配置容易覆盖原有字段、泄露 API Key，或者把未经验证的能力写进去。

ProbeMux 的做法是：

```text
Your real model endpoint
        ↓
   Probe Engine
        ↓
Canonical Capability Manifest
        ↓
   Adapter Layer
   ├── Codex
   ├── OpenCode
   └── DSH
```

**先探测一次，再为不同 Agent 复用同一份能力证据。**

## 30 秒 Quick Start

需要 Node.js 22.18+。

如果你已经在 DSH 中配置好了 Provider / Model / API Key，不需要重新输入：

```bash
npm install -g probemux
probemux dsh inspect
probemux dsh sync --active
```

`dsh inspect` 只读取本地配置，不访问模型 API。  
`dsh sync --active` 会真实探测 Endpoint，但**只展示 diff，不写文件**。

确认结果后再应用：

```bash
probemux dsh sync --active --confirm APPLY
```

ProbeMux 会先创建时间戳备份，再做原子写入，并且只同步已经验证的能力。

## Demo

![ProbeMux DSH demo](docs/assets/probemux-demo.svg)

典型流程就是：

```text
inspect current model
        ↓
probe the real endpoint
        ↓
VERIFIED / LIKELY / UNKNOWN / UNSUPPORTED
        ↓
review diff
        ↓
confirm APPLY
```

## v0.1.0 支持范围

| 能力 | v0.1.0 |
| --- | --- |
| `/v1/responses` | ✅ |
| `/v1/chat/completions` | ✅ |
| Reasoning effort probing | ✅ |
| `reasoning.effort` / `reasoning_effort` | ✅ |
| `system` / `developer` role | ✅ |
| Tool / function calling | ✅ |
| Codex Adapter / config render | ✅ |
| OpenCode Adapter / config render | ✅ |
| DSH Adapter + inspect / probe / sync | ✅ |
| Claude Code / Roo / Cline | ⏳ Not in v0.1.0 |

Reasoning 档位覆盖：

`off / none / minimal / low / medium / high / xhigh / max`

> v0.1.0 是 **DSH-first** 的完整集成体验；Codex 与 OpenCode Adapter 已包含，后续版本会继续统一三端的直接 sync 体验。  
> Codex 与 OpenCode 的 Adapter 映射和配置生成已覆盖自动化测试；v0.1.0 尚未提供与 DSH 相同的 native inspect / sync 工作流。

## 证据优先，而不是“HTTP 200 = 支持”

ProbeMux 不会因为请求成功就把能力标记成 VERIFIED。

| 状态 | 含义 |
| --- | --- |
| `VERIFIED` | 有直接、可复现的端点行为或明确校验响应 |
| `LIKELY` | 有较强端点信号，但无法证明参数实际生效 |
| `INFERRED` | 来自目录、官方资料或其他间接证据 |
| `UNKNOWN` | 证据不足、请求失败或响应行为不符合预期 |
| `UNSUPPORTED` | 端点明确拒绝对应协议、字段、role 或 tool |

例如：

- reasoning 请求只有在服务端明确枚举允许值等强证据下才验证对应档位；
- tool calling 只有返回预期的真实 function call 才验证；
- 单纯 HTTP 200 不会自动升级成 `VERIFIED`。

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

## DSH Quick Start

> If DSH is already configured, you do not need to re-enter the Base URL, model, or API key.  
> ProbeMux reads the existing DSH configuration and credential reference, probes the actual endpoint, and patches only the verified model capabilities.

普通 DSH 用户只需要这 4 条命令：

```bash
npm install -g probemux
probemux dsh list
probemux dsh inspect
probemux dsh sync --active
```

前三步是安装/本地读取；`dsh list` 与 `dsh inspect` 不发模型网络请求。  
第 4 步真实探测端点，但默认仍然不会写入。

审阅 diff 后真正写回：

```bash
probemux dsh sync --active --confirm APPLY
```

也可以单独验证某个 provider/model：

```bash
probemux dsh inspect \
  --provider openrouter-latest \
  --model deepseek/deepseek-v4-flash-vision-exp

probemux dsh probe --active \
  --provider openrouter-latest \
  --model deepseek/deepseek-v4-flash-vision-exp
```

首次使用也可用 JSON 输出确认细节：

```bash
probemux dsh list --json
probemux dsh inspect --json
```

DSH 集成流程：

```text
discover DSH_HOME
    ↓
read provider / default-model config
    ↓
resolve endpoint + credential reference
    ↓
probe actual endpoint (--active)
    ↓
merge VERIFIED reasoningEfforts only
    ↓
show diff
    ↓
backup + atomic apply (--confirm APPLY)
```

### DSH 安全边界

- **ProbeMux never writes your API key into a Capability Manifest or settings.yaml.**
- API key 只通过引用解析：process env → `$DSH_HOME/.credentials.yaml` → `cwd/.env` → `$DSH_HOME/.env`。
- API key 只存在于运行时内存，任何输出都会 redact。
- 无显式 `baseURL` 的 catalog provider 不会被猜测 endpoint。
- `deepseek-official` 的 reasoning 档位受当前 DSH 版本 whitelist 限制；无法安全确认时只 warning，不写入。
- 显式 `--default-effort` 未 VERIFIED 时拒绝写入。
- 未显式指定且当前档位失效时，优先选择 VERIFIED 的 `high`，否则取最高非 off VERIFIED 档位。
- 已有 `baseURL` / `apiKeyEnv` / `displayName` / `headers` / `retryPolicy` / `timeout` / `transport` / `compat` / `contextWindow` / `maxTokens` / `input` 等配置、其他 model、其他 provider、未知 section 与注释全部原样保留。
- catalog 路由使用 `modelOverrides` merge，不替换整个 catalog。

`render` 与 `dsh sync` 概念分离：`render` 从 Manifest 生成独立候选配置；`dsh sync` 只对现有 `settings.yaml` 做最小 leaf-level patch。

## 通用 Probe → Render → Diff → Apply

除了 DSH 原生 sync，也可以直接对任意 OpenAI-compatible Endpoint 建立 Capability Manifest：

```bash
PROBEMUX_API_KEY=... probemux scan \
  --base-url https://api.example.com/v1 \
  --api-key-env PROBEMUX_API_KEY \
  --output scan.json

PROBEMUX_API_KEY=... probemux probe \
  --base-url https://api.example.com/v1 \
  --provider-id my-provider \
  --model my-model \
  --api-key-env PROBEMUX_API_KEY \
  --active \
  --output manifest.json
```

然后生成 Agent 配置：

```bash
probemux render manifest.json \
  --target codex \
  --default-effort high \
  --api-key-env PROBEMUX_API_KEY \
  --output candidate.toml
```

审阅并应用：

```bash
probemux diff \
  --current ~/.codex/config.toml \
  --candidate candidate.toml \
  --plan codex-plan.json

probemux apply --plan codex-plan.json --confirm APPLY
```

## 本地开发

```bash
npm install
npm test
npm run build
npm run check
```

主要目录：

```text
src/
├── probes/         # Endpoint capability probes
├── adapters/       # Codex / OpenCode / DSH
├── integrations/   # Agent-specific integration workflows
├── discovery/      # Endpoint / provider discovery
├── domain/         # Capability model
└── config/         # Safe config handling
```

## 文档

- [v0.1.0 PRD](docs/PRD-v0.1.0.md)
- [v0.1.0 架构](docs/architecture-v0.1.0.md)
- [Gap analysis](docs/gap-analysis-v0.1.0.md)
- [v0.1.0 实施报告](docs/implementation-report-v0.1.0.md)
- [竞品与需求证据](docs/competitive-research.md)
- [证据优先 ADR](docs/adr/0002-evidence-first.md)

## Roadmap

当前 `v0.1.0` 聚焦：

- DSH-first 的安全探测与 verified-only sync。
- Codex / OpenCode 配置 Adapter。
- OpenAI-compatible Endpoint 黑盒能力探测。
- Canonical Capability Manifest。

后续优先方向：

- `probemux codex sync`
- `probemux opencode sync`
- 更多 Agent Adapter
- 更强的行为型 capability verification
- 更友好的交互式 CLI / report

## License

MIT
