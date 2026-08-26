# ADR-0001：正式命名为 ProbeMux

状态：Accepted  
日期：2026-08-25

## 背景

早期工作名 `ModelProbe` 存在明确冲突：

- GitHub 已有 `cuihuan/modelprobe`，定位为 OpenAI-compatible 网关可用性与延迟探针。
- npm 已有 `model-probe`。
- PyPI 已有 `modelprobe`。
- 其他领域也有多个 ModelProbe 项目。

继续使用同名会造成搜索、安装命令、品牌和安全上的混淆。

## 决策

- 项目正式命名为 `ProbeMux`，CLI binary 为 `probemux`，本地 private package 为 `probemux-workspace`。
- Canonical Capability Manifest、scan result 和 config diff plan 使用 `probemux.*` kind；备份与临时文件使用 `.probemux-*` 前缀。
- 根 package 保持 `private: true`，不发布 npm、不创建 GitHub Release、不推送远端。
- 在任何公开建仓或发包前重新检索 GitHub/npm/PyPI/域名，并单独冻结公开包名和 scope。

该命名强调“将一次能力探测复用到多个 Agent 配置”的多路复用目标，且不暗示模型 benchmark 或单纯健康检查。
