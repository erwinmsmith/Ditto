# 产品文案资料与核验工具

[多候选示例](../../../patterns/candidate-selection/README.zh-CN.md)的应用层 `RegisteredTool`。`createTask` 接受可信请求及产品资料，建立哈希绑定的本地任务；`createDemo` 提供示例资料。`CandidateAdapters` 注册读取、候选保存、评分依据保存及发布工具，模块导入不执行任务。

工具核对指定 CTA、正文事实原文、引用 ID、字数与文件哈希。选择按合格分数排序；融合复制已批准字段，保留父候选关系并复评。评分属于模型判断，不能覆盖硬性限制。

替换产品资料或接入其他候选评价时，在应用层实现加载器、契约及核验器，保持 Core 无业务依赖。真实输出是本地 JSON/Markdown，不会发送或发布到外部平台。见[完整契约](../../../../docs/worker-api/candidate-workflows.zh-CN.md)。
