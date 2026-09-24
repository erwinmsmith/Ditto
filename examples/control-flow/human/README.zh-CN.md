# 2.6 人工介入控制

[English](README.md) · [上一级](../README.zh-CN.md) · [公开 API 调用](../../../docs/worker-api/human.zh-CN.md)

五个示例使用公开 Graph、Context、推理和交互 API，完成版本发布通知的生成、人工审核、修改、继续执行和异常交接。应用把审核单、版本、决策与执行记录保存到 SQLite，并通过 `INTERACTION.OUTPUT` 把完整候选内容交付到文件收件箱。

## 流程与结果

| 流程 | 入口 / 导出函数 | 人工介入后的实际任务结果 |
| --- | --- | --- |
| 人工确认后执行 | [approval.ts](approval.ts) / `runApproval` | 确认发布内容及目标初始状态后，激活本地发布配置 |
| 中间结果确认 | [intermediate.ts](intermediate.ts) / `runIntermediate` | 展示通知草稿，确认后由模型生成日历记录，再写出 `.ics` |
| 人工编辑后继续 | [edit-and-continue.ts](edit-and-continue.ts) / `runEditContinue` | 保存人工修改版本，重新确认后用新日期、标题和内容继续任务 |
| 人工审核后发布 | [review-publish.ts](review-publish.ts) / `runReviewPublish` | 将准确的已审核版本写为发布 JSON 和 Markdown |
| 异常升级人工 | [escalation.ts](escalation.ts) / `runEscalation` | 将冲突来源、候选结果、Context 和事件交接给人工，并记录认领人 |

激活、发布和日历交付使用应用目录中的真实文件；它们是本地参考业务，不会部署云服务、公开发布网页或提交外部日历。工具适配器 [human-review-store.ts](../../_shared/tools/human-review-store.ts) 属于应用，独立于 Ditto Core。接入外部系统时，应用负责身份认证、访问控制、幂等键及目标状态的原子校验。

## 运行

使用 Node.js 24+，在仓库根目录配置 `ditto.yaml` 和 `.env` 中的模型 Provider，然后执行：

```sh
npm run build
npm run example:human:approval
npm run example:human:intermediate
npm run example:human:edit
npm run example:human:publish
npm run example:human:escalation
```

每条命令创建独立任务目录，输出 `{ directory, result }`。前四类停在 `awaiting-review`；异常示例包含相互冲突的日期，停在 `escalated`。模型调用不会批准任务。打开目录中 `inbox/<request-id>.md` 查看完整提案、版本、摘要和操作目标。

命令可追加 `--provider <configured-provider>`。后续调用使用输出中的 `directory`、`result.request.id` 和 `result.request.token`，不会重新生成已有草稿。

### 确认、拒绝与恢复

```sh
npm run example:human:approval -- --directory /path/to/task \
  --request <request-id> --token <token> \
  --decision approve --actor example-operator --note "Reviewed release and target"

npm run example:human:approval -- --directory /path/to/task
```

第二条命令重新读取任务；完成后重入不会重复业务效果。把 `approve` 改为 `reject` 可拒绝尚未决定的审核单，任务进入 `rejected`，不执行对应效果。一次审核只能决定一次。

| 命令 | 示例审核身份 | 允许用途 |
| --- | --- | --- |
| `example:human:approval` | `example-operator` | `activate` |
| `example:human:intermediate` | `example-editor` | `intermediate` |
| `example:human:edit` | `example-editor` | `edit` |
| `example:human:publish` | `example-publisher` | `publish` |
| `example:human:escalation` | `example-triager` | `handoff`，仅认领 |

CLI 的 `--actor` 演示可信应用控制器传入的身份，不能作为面向不可信调用者的登录机制。`application.json` 中的审核策略由应用管理；审核 token 用于绑定内容与操作范围，不是认证凭据。

### 人工编辑后继续

把 `result.artifact.draft` 的完整副本写入 JSON 文件，保留 `releaseId`，修改日期、标题或正文：

```json
{
  "releaseId": "REL-copy-from-task",
  "date": "2027-01-15",
  "title": "人工修订的发布标题",
  "body": "人工修订的发布说明。"
}
```

```sh
npm run example:human:edit -- --directory /path/to/task \
  --request <original-request-id> --token <original-token> \
  --edit /path/to/replacement.json --actor example-editor --note "修订日期和内容"

npm run example:human:edit -- --directory /path/to/task \
  --request <new-request-id> --token <new-token> \
  --decision approve --actor example-editor
```

编辑会创建新版本、废弃旧审核并展示新审核单。第二条命令必须使用编辑命令输出的新 request 和 token。已批准但尚未进入效果执行的发布版本也可以编辑，仍须重新审核。`executing` 阶段禁止编辑；下游模型执行期间若版本改变，旧输出不能落地。

### 审核发布与异常认领

发布使用 `example:human:publish`、`--decision approve` 和 `--actor example-publisher`，参数形式与确认相同。发布直接使用已审核正文，不在审核后重新生成内容。

```sh
npm run example:human:escalation -- --directory /path/to/task \
  --request <request-id> --token <token> \
  --claim --actor example-triager --note "已认领，核实两个来源中的日期"
```

认领后 `request.status` 为 `assigned`，`job.assignee` 保存认领人。任务仍为 `escalated`，业务处理结果由人工处置流程决定。交接单不可使用 `--decision approve` 绕过异常。

## 持久化与恢复

```text
<task-directory>/
  application.json           # CLI 模式与审核角色策略
  task.source.json           # 真实输入资料
  task.deployment.json       # 本地激活目标
  reviews.sqlite             # 任务、版本、审核、效果与事件
  inbox/<request-id>.json     # 不可变审核快照
  inbox/<request-id>.md       # 完整可读审核内容
  results/task.json          # 最近一次任务输出
  private/task.json          # 确认/编辑后的私有交付
  private/task.ics            # 日历文件
  published/task.json        # 审核版本与正文
  published/task.md          # 发布文档
```

仅对应流程会生成相应输出。SQLite 是状态依据；等待人工时调用正常返回，关闭 Runtime 后可在新进程重新打开同一目录。输出交付成功只表示审核内容已送达，不表示批准。

执行工具独立校验审核状态、用途、版本及摘要，在写文件前持久化待执行效果。中断后重试使用同一审核快照；已有同内容文件可复用，冲突文件拒绝覆盖。激活目标变化会阻止执行并保留 `executing` 状态，供应用核对；取消或失败不等于回滚已经写入的文件。文件参考适配器适用于受应用控制的本地目录，不能替代外部系统的事务或条件写入。

## 验证

```sh
npm run check
npm run check:examples:human:tasks
npm run check:examples:human:tasks:package
```

任务实验覆盖 18 个场景：五类流程、拒绝、错误角色、失效 token、编辑使旧批准失效、交付失败恢复、进程强制中断后继续、跨进程编辑、下游推理期间编辑、幂等重入、目标变化、调用方取消和输入变化。模型使用真实 HTTP Provider；人工决定由测试控制器显式提交。实验检查实际 SQLite、收件箱、激活文件、发布正文和日历文件，并记录模型调用轨迹。

包实验先构建并 `npm pack`，在仓库外安装产物，以无路径别名的严格 TypeScript 配置检查示例和静默导入，再运行上述任务。报告写入 `.examples-human-tasks-live-results.json` 或 `.examples-human-package-live-results.json`，任务文件保存在 `.examples-human-tasks/`。离线回归另外覆盖模型失败、无效结果、截断结果和待执行效果的恢复。
