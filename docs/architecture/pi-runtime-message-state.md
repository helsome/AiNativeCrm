# Pi Runtime 消息状态与产品输出边界

本项目当前安装的 `@earendil-works/pi-agent-core` 和 `@earendil-works/pi-ai` 均为 `0.86.1`，版本由 `package.json` 与锁文件固定。这里记录 CRM 适配层的实际映射；SDK 签名以本仓库 `node_modules/@earendil-works/pi-ai/dist/types.d.ts` 和 `lib/agent-runtime/pi/runtime.ts` 为准。

| CRM 端口 | Pi 适配点 | 数据边界 |
| --- | --- | --- |
| `AgentRuntime.run` | `Agent.prompt` | CRM 传入任务、模型绑定、工具和取消信号；Pi 负责模型循环。 |
| `RuntimeTool.execute` | `AgentTool.execute` | CRM 工具许可与副作用政策在执行前检查；结果作为观察进入下一轮。 |
| `RuntimeMessage` | `AgentMessage` | `content` 只包含可见文本；`privateContinuation` 保存服务端续跑所需的原始 Assistant 内容块和 Provider 元数据。 |
| `AgentRuntimeEvent` | `AgentEvent` | 对外只暴露归一化生命周期；持久化产品事件另由 Workbench 写入。 |
| `RuntimeUsage` | Pi `Usage` | 输入、输出和缓存 Token 从 Assistant 消息累计；CRM 的成本归属仍以 `llm_calls` 为准。 |
| `AbortSignal` | `Agent.abort` | CRM 的取消状态由 Worker 观察并传播；发送队列仍在最终动作关口重新检查授权。 |

`privateContinuation` 仅写入服务角色可读的 `ai_agent_run_states.messages`。其中可含 Pi 的 `thinking` 内容块与签名，恢复时由 Pi 适配层还原；`RuntimeMessage.content`、`finalText`、Workbench 运行详情和产品事件都不得读取该字段。旧运行状态没有此字段时，适配层仍按原兼容路径恢复，但无法还原旧状态里已经丢失的 Provider 元数据。

Workbench 自动写入后的继续执行，必须先采用本轮 `runtimeMessages`，再追加 CRM Harness 的执行观察，最后持久化。旧输入消息只代表进入本轮之前的上下文。回归测试覆盖两次连续写入和一次 JSON 持久化恢复；Pi 假 Provider 测试覆盖可见文本与私有思考分离及签名恢复。

后续若要把结果改成结构化提交，提交格式应至少包含结论、证据定位、已执行动作、待确认动作、缺失信息和下一次唤醒条件。当前 `extractProductFinalAnswer` 仍是对无结构文本的兼容与防泄漏兜底，不能替代业务完成判定。
