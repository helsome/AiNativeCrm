# Pi 运行中方向调整：端口映射与安全边界

真实任务：给定正在执行的商机 Mission 和负责人补充的方向，负责人希望智能体在下一次可安全决策时改变计划；只有新方向被纳入模型上下文、旧计划的业务动作不再被误执行，才算生效。

此文档锚定仓库锁定的 `@earendil-works/pi-agent-core@0.86.1`。`pi-coding-agent` 技能中的 `AgentSession.steer()` 示例基于 `0.84.2` 的另一个包，不作为本项目的 API 依据。实际签名和时序来自本地 `node_modules/@earendil-works/pi-agent-core/dist/agent.d.ts`、`dist/agent.js` 与 `dist/agent-loop.js`。

## 产品端口与 Pi 映射

| CRM 语义 | 当前 Pi 落点 | 约束 |
| --- | --- | --- |
| 负责人方向 ID 与正文 | `AgentTurnInput.steering.poll()` 返回产品自有消息 | 首次模型请求前、此后每个可继续的 `turn_end` 轮询；ID 用于本次模型调用去重，源数据不得在轮询时破坏性消费。 |
| 运行中插话 | 调用 `Agent.steer(userMessage)` | Pi 在本轮工具结果之后、下轮模型请求之前读取队列；不能撤销已执行工具。 |
| 模型上下文 | Pi 把带稳定方向 ID 标记的 steering user message 写入 transcript | `steering_queued` 只证明入队；`steering_consumed` 要求消息通过 `transformContext`、进入模型请求且下一轮有非错误响应，事件不含正文。业务层仍须将 transcript 与确认原子持久化，才可声称指令生效。 |
| 工具调用 | 仍由 CRM `beforeToolCall`、工具效果策略和数据库发送闸门控制 | `crm_update_lead` 自动执行时取得 Mission 方向事务锁，核对 Run 保存的修订；负责人方向提交也先取得同一把锁。新方向不是批准外发或提升工具权限。 |
| 停止、预算、取消 | `shouldStopAfterTurn`、`maxTurns`、`abortSignal` 仍优先 | Pi 在 `shouldStopAfterTurn` 请求停止时不读取 steer；调用方必须把未消费命令保留为待处理。 |

适配层不持有 Mission 业务状态，不从模型文本推断负责人身份，也不对方向作成功确认。运行中方向的产品闭环仍须：可信负责人命令原子暂停旧客户发送、持久化方向修订；每个 CRM 写入前检查修订；在 Pi 下一轮注入；将带方向的 transcript 与消费修订原子保存；进程退出后重放尚未被持久化消费的命令。若运行在边界前结束或预算耗尽，命令应保持待处理并由 Mission 恢复机制接管，不能标记为已生效。

当前完成了产品端口、模型网关转发、Pi 适配和确定性测试。Mission 新建、客户回复唤醒、负责人安全边界续跑都会把 `directionRevision` 固定在 Run 的 `runtime_state` 中；自动写入后递归续跑也保留该修订及 Agent/会话修订。自动执行的可逆商机更新现在通过 `withMissionDirectionWriteFence` 串行化：方向提交与写入共享事务锁，写入前核对 Mission 和 Run 修订，锁持有至 CRM 工具返回。版本缺失、旧版本或失活 Run 均阻止工具执行；活动 Run 遇到方向栅栏错误时不会重试模型，而是原子进入 `partial`、撤销待执行提案、使待审草稿失效并写入 `run_partial` 事件，让 Mission 转入人工复核。真实 PostgreSQL 不变量测试覆盖锁竞争、旧修订被拒绝、跨组织隔离、终态幂等与提案撤销。锁只覆盖自动 `crm_update_lead`，不等于所有 CRM 动作都已具备在线转向保障。

Mission 在线指令接口、其他待确认动作的修订栅栏、transcript 与消费确认的原子持久化、以及运行在边界前结束时的待处理指令接管仍未接入。负责人界面暂不宣称支持运行中即时转向。
