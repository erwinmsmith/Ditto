# 应用共用执行工具

`docker.ts` 为 JSON 函数体提供 `isolatedCode`，为可信控制器拥有的 Node 测试文件提供 `isolatedTests`。两者都调用 `isolatedNode`，其执行外壳属于可信应用代码。生成的程序通过标准输入传入，仅在配置的 Docker 容器内执行。不要把任意执行外壳选择开放为模型工具。

`files.ts` 通过临时文件和硬链接原子写入不可变文件，核验已有文件是否相同，并拒绝冲突内容。这些工具属于应用适配器，不属于 Ditto 主包。operations 适配器为兼容保留既有工具名称的重新导出。

资源限制、镜像配置和测试边界见[数据与代码配置](../data-and-code/README.zh-CN.md)。
