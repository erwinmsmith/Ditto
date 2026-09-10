# 独立实验仓库接入

该目录故意使用独立 package.json 和 tsconfig，检验真正的包入口及声明，而不是源码 paths。

从 Ditto 根目录执行：

```bash
npm ci
npm --prefix examples/experimental-consumer ci
npm --prefix examples/experimental-consumer run check
```

复制为外部实验仓库时，将 `@ditto/core` 的 `file:../..` 改为 Ditto 检出的实际相对路径。保持 `type: module`，使用 Node.js 24+。示例导入的是编译后的 ESM 与声明；修改 Ditto 源码后重新 build。

示例包括 MEMORY 到 REASONING 的 Graph、Worker 副本注册/移除以及 SEARCH.QUERY 自定义语义。handler 是无外部依赖的演示实现，不代表实际检索或模型能力。
