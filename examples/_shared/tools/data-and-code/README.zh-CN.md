# 数据与代码工具

[English](README.md) · [十二项流程](../../../capabilities/data-and-code/README.zh-CN.md)

应用通过 `dataCodeTools(directory, request, { python })` 提供 `RegisteredTool[]`，注入 `createInteractionWorker`。目录内的脚本、数据库规则、测试文件和图表模板属于应用，不加入 Core 的运行依赖或配置模型。

## 安装

```sh
npm ci --prefix examples/_shared/tools/storage/dependencies
uv venv examples/_shared/tools/.venv
uv pip install --python examples/_shared/tools/.venv/bin/python \
  -r examples/_shared/tools/data-and-code/requirements.txt
brew install ripgrep  # 其他系统使用对应包管理器
# 启动 Docker 后预先拉取镜像；执行器不会自动拉取。
docker pull node:24-bookworm-slim
export DITTO_EXAMPLE_DATA_PYTHON="$PWD/examples/_shared/tools/.venv/bin/python"
```

Python 标准库负责 CSV 与 SQLite，Matplotlib 只用于绘图。`DITTO_EXAMPLE_CODE_IMAGE` 可由部署者指定预先拉取的 Node.js 24+ 镜像；生产部署可固定镜像摘要。Python 和 Docker 子进程不继承模型 API 密钥；容器没有应用环境变量、宿主文件挂载或网络连接。

## 工具职责

| 工具 | 行为 |
| --- | --- |
| `data_code_sources` | 验证输入 SHA-256、保存快照、读取 CSV 和真实数据库表结构 |
| `data_query` | 在固定业务库快照上执行受限只读 SQL |
| `data_clean` | 在 Docker 中执行模型生成的清洗程序，独立核对规范化记录 |
| `data_profile` | 计算缺失统计、数值分布、状态计数和相关系数 |
| `data_calculate` | 在 Docker 中执行统计程序，并核对业务口径 |
| `data_chart` | 计算真实分组总额，生成 PNG/SVG 和配套数据 |
| `data_metrics` | 提供可解释的已付款订单指标 |
| `repository_search` | 对允许的源码文件运行字面量 ripgrep 检索 |
| `code_patch` | 校验目标路径和基线哈希，在容器内测试候选模块后交付新文件 |
| `repository_tests` | 实际运行基线测试，保留退出码、TAP 和结构化测试摘要 |
| `data_code_publish` | 核对执行产物与证据，写入报告 |

每个 Runtime 只注册当前任务可用的操作、资料工具和报告工具。`effects` 是副作用声明；允许列表和业务校验由可信控制器负责。

## 数据与 SQL 边界

仅开放 `sales` 表的六个订单字段。SQLite 使用 `mode=ro&immutable=1`、`query_only`、授权回调、禁用扩展加载和 VM 指令预算。写入、附加数据库、未授权表/列与函数都被拒绝；一次执行只允许一条语句，最多返回 100 行。参数通过独立数组绑定。参考：[SQLite Python 接口](https://docs.python.org/3/library/sqlite3.html)。

CSV 最多 256 条记录；每个输入文件最多 256000 字节，进入 Context 的组合资料最多 48000 UTF-8 字节。源目录、输出目录和请求文件由可信应用管理；不能把这个文件布局当作面对恶意本地用户的操作系统权限边界。

## 代码执行边界

[共用 Docker 执行器](../execution/docker.ts) 复用工具操作示例的隔离方式：非 root、无网络、无宿主挂载、只读根文件系统、移除 capabilities、禁止提权，限制 128 MiB 内存、1 CPU、32 个进程、16 MiB 临时目录、64 KiB 输出和 12 秒执行时间。超时、取消和异常后清理容器，不回退到宿主 `eval`。

`isolatedCode` 在容器中执行函数体；`isolatedTests` 在容器临时目录写入应用提供的模块和测试，然后运行真正的 `node --test`。测试进程启用 Node Permission Model，只读测试目录，不授予写入、子进程或 Worker 权限。Docker 是主要隔离边界；测试通过不意味着代码可无条件部署。参考：[Node 权限](https://nodejs.org/download/release/v24.7.0/docs/api/permissions.html)。

代码样本只开放 `invoice.mjs` 的修改，原始测试及输入保持不变。基线和候选测试日志保留实际执行证据；模型只引用结构化摘要中的短值，不重复生成整段日志。副作用回执用于工具完成后的恢复；磁盘错误或中途冲突会显式失败，不将不完整执行标记为成功。

## 绘图来源

`plot.py` 与 `chart-style.json` 基于 `data-viz` 技能的 Figure 07 分组柱状图及 `grouped_bars` 实现调整，保留画布、坐标区域、布局和三色配色。业务数据映射为地区 × 状态，柱高为订单金额总和；不使用原模板样例数据，移除样本散点、误差条、显著性标注和生物学标签。没有样本方差就不展示误差线。

图表数据由实际订单计算，`chart-data.json` 可独立核对数值。渲染采用 Agg，无桌面依赖；SVG 保留文字与矢量元素，PNG 用于视觉核对。
