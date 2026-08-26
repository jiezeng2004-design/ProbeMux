# ADR-0002：采用证据优先而非模型名推断

状态：Accepted  
日期：2026-08-25

## 背景

多个客户端根据模型 ID 模式开启 reasoning UI。自定义 deployment name、代理别名或新模型无法匹配时，功能会消失；反过来，名称猜测也可能向不兼容 endpoint 发送错误字段。

同一个底层模型在不同 Provider 与协议上的控制面不同，模型名不是充分条件。

## 决策

- 最终能力档案由 observations 经 resolver 产生。
- 名称启发式仅是最低等级证据，不能单独生成可写配置。
- `unknown` 是一等状态，不自动折叠为 `false`。
- 成功 HTTP 响应只证明参数被接受；没有 usage/metadata 时标记 `accepted-but-unverified`。
- 配置 adapter 必须计算 source 与 target 的能力交集并报告 omitted levels。

## 结果

优点：

- 降低新模型、别名和中转站导致的假阳性。
- 报告可以解释“为什么得出这个结论”。
- 上游目录错误或漂移时可保留冲突。

代价：

- 初次使用可能看到更多 `unknown`。
- schema、resolver 和测试比简单映射表更复杂。
- 强结论可能需要用户选择主动探测。

这些代价符合项目定位；若只追求一键注入默认档位，已有 DSH 插件已经更合适。
