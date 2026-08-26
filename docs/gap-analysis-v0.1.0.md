# ProbeMux v0.1.0 Gap Analysis

日期：2026-08-25  
方法：读取修改前 README、PRD、competitive research、architecture、schema、全部 source 与 test，并在任何修改前执行基线测试。

## 1. 修改前基线

- 版本：`0.1.0-dev`。
- 运行时：Node.js 22.18+，零第三方依赖。
- 数据契约：`ModelProfile 0.1`。
- 已有能力：
  - `GET /v1/models` 被动发现；
  - models.dev 候选证据导入；
  - 单一 reasoning sentinel 探针；
  - evidence precedence 与 conflict resolver；
  - DSH、Codex、OpenCode、Claude Code 只读片段；
  - `validate / render / discover / probe-openai` CLI。
- 基线测试：`16/16` 通过。
- 基线示例校验：`Valid ModelProfile 0.1: deepseek-official/deepseek-v4-pro`。
- 目录不是 Git 工作树，因此没有 commit/SHA 基线；本报告和原始交付 zip 共同承担修改前记录。

## 2. 与新正式定位的差距

| 新要求 | 修改前状态 | Gap |
| --- | --- | --- |
| 跨 Agent 正式定位 | 文档仍以 reasoning translation 为中心 | 缺少 Endpoint 全能力闭环 |
| 首批仅 3 Agent | 包含 Claude Code | MVP 范围过大 |
| Probe Engine Agent 无关 | 只有单 reasoning probe | 缺少统一 orchestration |
| 两个 API protocol | protocol 由用户预先指定 | 没有黑盒识别 |
| reasoning 方言 | 每个 protocol 只有一个固定 path | 没有交叉兼容探测 |
| system/developer role | 只在 profile 中静态记录 | 没有主动探测 |
| tool calling | 只保留静态字段 | 没有行为验证 |
| Canonical Capability Manifest | ModelProfile 重点描述 reasoning | 契约不完整 |
| VERIFIED/LIKELY/INFERRED/UNKNOWN/UNSUPPORTED | supported/unsupported/unknown/accepted-but-unverified | 语义不匹配 |
| HTTP 200 不等于支持 | reasoning 已部分遵守 | protocol/role/tool 尚无规则 |
| scan/probe/render/diff/apply | 只有 discover/render/probe-openai | 缺 4 个正式命令与事务 |
| Backup + Apply | 放在 v0.2 规划 | 新要求提升为 v0.1 P0 |

## 3. 可复用部分

- URL 去凭证和 query 的 Endpoint fingerprint。
- 显式 `--active` 防护与超时模式。
- sentinel + 400 allowed-values reasoning 判定思路。
- evidence-first、UNKNOWN 一等状态和不静默下调原则。
- Codex effort 值域交集逻辑。
- OpenCode variants 与 DSH `reasoningEfforts` 基础投影。
- fake fetch 测试方式。

## 4. 实施决策

1. 保留旧 ModelProfile、resolver、models.dev importer 与单 reasoning probe 作为兼容基础，不做无关删除。
2. 新建正式 `CapabilityManifest 0.1.0`，CLI 和三个 Adapter 改为消费它。
3. 新建 Agent 无关的 Probe Engine，默认完整预算 12 请求。
4. 从 v0.1 Adapter 注册表移除 Claude Code，不扩展其他 Agent。
5. 配置修改采用完整候选文件事务：diff 计划、双哈希校验、备份、原子替换。
6. v0.1 不实现任意 TOML/JSONC/YAML 的结构化 merge，避免无依赖 parser 造成配置损坏。

## 5. Gap 关闭结果

- 正式 CLI：`scan / probe / render / diff / apply`，另保留 `validate`。
- Manifest schema、运行时校验和 fixture 已增加。
- Protocol、reasoning dialect、message role、tool calling 均有主动探测与证据。
- Codex、OpenCode、DSH Adapter 已切到 Manifest。
- 配置事务已实现确认、stale-plan 拒绝、备份与原子替换。
- 默认测试已扩展到 domain、legacy compatibility、Probe Engine、三个 Adapter、配置事务和 CLI integration。
