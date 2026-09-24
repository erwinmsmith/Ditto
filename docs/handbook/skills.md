# Skill：加载、选择与组合指令

Skill 是应用维护的指令和参考资料，不是一个自动安装工具权限的 Worker。Ditto 提供 Context 载入、选择、更新和 `runSkillFlow`；技能目录发现、文件读取、版本选择及授权由应用控制。

## 1. 目录结构

```text
skills/
  review/
    SKILL.md
    references/
      checklist.md
    scripts/
      verify.mjs
```

只有 `SKILL.md` 或当前任务真正需要的资料进入 Context。附属脚本通过受控工具执行，不能因为指令里写了命令就自动获得执行权限。

可信技能目录可以来自应用代码、管理员维护的配置或签名包。用户任意上传的同名文件不应直接作为 system 指令载入。

## 2. 运行本章示例

```sh
node examples/handbook/skills.ts '审核这个技术答案'
```

示例只验证加载与上下文组装，使用显式 Context，不是完整模型 Agent。它实际读取 `skills/review/SKILL.md`，检查 skills 和 tools 两层权限，并用一个 Loop 组合读取图与组装图：

<<< ../../examples/handbook/skills.ts

示例技能正文见 [SKILL.md](../../examples/handbook/skills/review/SKILL.md)。在完整会话 Agent 中，将 assemble 阶段改为带可信 scope 的 Redis Context，并把已选择内容映射给 INFER。

## 3. 两种接入方式

| 方式 | 适用 | 需要做的事情 |
| --- | --- | --- |
| 应用已加载内容 → runSkillFlow | 简单集成、已有技能系统 | 传 sources 和可选 context；保留 metadata/source |
| 工具读取 → Graph/Loop → Context | 希望读取过程也受调度和验证 | 注册读取工具、限制目录、显式权限、结果检查 |

`runSkillFlow(runtime,{sources,context?})` 接收已解析内容；它不是 Skill 文件解析器，也不下载技能包。传入 context 时在 LOAD 后 UPDATE；不传时返回新 Context。它不自动保存 Redis session，需要缓存时使用带 scope 的 CONTEXT 节点。

## 4. 技能选择与版本

先使用任务领域、用户许可和租户策略从允许目录中筛选，再加载必要技能。模型可以建议技能 ID，可信控制器负责确认它属于允许集。目录内容使用固定版本或内容 digest，任务记录保留版本，恢复时避免无意切换指令。

每个条目使用稳定 Context ID，例如 `skill:review:v2`。更新技能时明确替换或移除旧条目；不要堆叠多个互相冲突的版本。

## 5. 预算和信任

关键指令可标记 metadata.role=system、protected=true；仍要给足 Context 的条数与 token 预算。默认压缩保护 system/currentGoal/pending 等条目，保护内容本身超预算会失败。不要通过静默删除安全要求来“修复”预算。

外部网页或用户资料中出现“忽略系统规则”等文字时，将其作为资料而非技能指令。Skill 的参考资料可以带 source 引用，方便结果核验与更新追踪。

## 6. 工具权限不会继承自 Skill

Skill 声明需要网络、MCP、数据库或写入，不等于这些动作已被授权。Runtime Sandbox、工具参数校验、外部系统身份和人工审批各自生效。将“技能能做什么”和“当前请求允许做什么”分别配置。

[Context 的选择与压缩](../worker-api/context.zh-CN.md) · [预定义 Skill 流程](../worker-api/flows.zh-CN.md) · [工具接入](tools.md)
