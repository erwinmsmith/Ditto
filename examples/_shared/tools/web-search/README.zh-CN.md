# 联网搜索应用工具

[English](README.md)

这些适配器独立于 @codesoul-co/ditto。providers.ts 提供公开 WebSearchProvider；http.ts 负责有界 HTTP 读取；adapters.ts 注册授权、网页阅读、快照核验和发布工具；domain.ts 定义请求与结果契约。引用及依据校验复用 ../evidence.ts 中与 RAG 共用的纯函数。

安装 storage / retrieval 依赖清单中的 redis、linkedom。Core 不增加这些第三方依赖。

| 环境变量 | 含义 |
| --- | --- |
| DITTO_WORKER_CONTEXT_REDIS_URL | 必需的 Redis Context 地址 |
| DITTO_EXAMPLE_WEB_SEARCH_ENGINE | mediawiki（演示默认）或 brave（通用网页搜索） |
| DITTO_EXAMPLE_WEB_SEARCH_ENDPOINT | MediaWiki API，默认 https://en.wikipedia.org/w/api.php |
| DITTO_WORKER_INTERACTION_BRAVE_SEARCH_API_KEY | Brave 密钥；不会保存到任务产物 |
| DITTO_EXAMPLE_WEB_TRUST_BENCHMARK_PROXY=1 | 仅在可信本机 VPN/代理使用 198.18.0.0/15 假 DNS 时显式启用；其他私网范围仍被阻止 |

MediaWiki 只搜索该 Wiki 的索引，不代表覆盖整个互联网。通用搜索使用 Brave；也可在 providers.ts 中实现公开 WebSearchProvider，再交给 createWebSearchTool 注册。Brave 使用已有公开 Provider 的超时和响应限制；MediaWiki 与网页阅读使用本目录的有界传输。没有自动换源或离线替代。

生产阅读要求 HTTPS 和明确的来源 origin。DNS 必须解析为公网地址，连接固定使用核验后的地址，并保留 TLS 主机名验证；拒绝 URL 凭据和 IP 字面量。每次跳转重新核对来源，最多三次。HTML / JSON 响应最多 1 MiB；单次请求超时为 20 秒；429、502、503、504 最多重试两次。遵守 Retry-After 秒数或日期，每次等待上限 60 秒；更长等待交由调用方重新安排。任务取消会中止请求和退避等待，不绕过登录、验证码或站点限制。

allowLoopbackTest 仅供显式创建的受控 HTTP 测试适配器，不能来自 Agent 请求或模型输出，CLI 不开启它。代理假 DNS 选项同样属于宿主配置，不是用户能够扩大的网络权限。

HTML 解码器去掉脚本、导航和表单，只提取可读段落，不运行网页脚本。动态渲染页面、PDF、音频、付费墙及登录流程不属于本工具；空正文或非 HTML 响应读取失败。规范化正文最多 120 个段落块和 100000 字符，每页最多四个按查询排序的片段进入筛选。段落位置属于规范化快照，并非原始 HTML 行号。抓取时间不是发布时间，快照也不能保证抓取后的实时有效性。

request.json 和 policy.json 由可信宿主创建。将 policy.enabled 设为 false 或移除 principal，可阻止后续执行及报告重放交付。任务目录和策略文件只允许宿主写入。搜索、网页快照与结果采用不可变写入；交付中断后核对已有内容再继续。产物可能包含来源正文，由宿主管理保留期限。
