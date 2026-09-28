# 维护 Markdown 与发布文档站

文档站使用 VitePress 标准主题，不需要为每篇文档编写页面组件。站点默认英文，中文位于 `/zh/`，两种语言使用对应主题路径。双语手册在 `docs/handbook`，既有中英文 API 在 `docs/worker-api`，完整场景说明保留在 `examples` 各目录。

## 1. 本地编译

使用 Node.js 24+：

```sh
npm ci --prefix site
npm run build --prefix site
npm run preview --prefix site
```

开发时执行 `npm run dev --prefix site`。站点构建会从允许的 Markdown 和示例文件生成临时目录，编译后输出 `site/.vitepress/dist`。临时内容、依赖与输出都在 Git 忽略规则内。

文档编辑后重新执行 build；不会修改源 Markdown。站点构建不需要模型密钥、Redis、数据库连接，也不会运行示例里的业务动作。

## 2. 添加页面

1. 手册保留 `name.md` 为中文，新增 `name.en.md` 英文；其他 API/示例采用 `name.md` 英文与 `name.zh-CN.md` 中文配对。构建会拒绝缺少翻译的页面。
2. 用相对 Markdown 链接连接同类文档；章节使用标准二三级标题。
3. 在 `site/.vitepress/config.mts` 的两种语言导航中加入同一主题入口。
4. 代码放在可运行的 example 文件，用 `<<< ../../examples/...` 引入到教程；构建器从源文件读入代码。
5. 执行构建和链接检查，预览桌面/手机宽度及搜索。

源码链接会在站点中生成可阅读代码页，既有示例也进入下载 archive。下载内容来自受控目录与 Git 可见文件，不复制 node_modules、私有 .env、本地指令、数据库或运行报告。

## 3. Pages 配置

在 GitHub 仓库 Settings → Pages 选择 GitHub Actions；仓库转移后重新构建并部署。Pages 必须受该仓库可见性与组织套餐支持；不要为了文档部署擅自改变源码仓库可见性。

准备好的 `Documentation` workflow 默认为只构建验收；手动触发时勾选 deploy 才发布。尚未启用 Pages 时只运行构建，不会创建网站或修改仓库权限。

站点默认 base 根据 `GITHUB_REPOSITORY` 的仓库名生成，或由 `DOCS_BASE` 显式覆盖。组织站点、用户站点或自定义域名可以设为 `/`；普通项目站点为 `/<仓库名>/`。变更后重新构建，不能只修改已生成 HTML 的路径。

## 4. Markdown、代码与下载的一致性

`site/prepare.mjs` 从源文档生成站点中间目录和示例 zip；`site/check.mjs` 校验生成的本地页面、静态资源、源文件页与下载链接。VitePress 的构建也检查 Markdown 目标页。

示例 archive 是消费者项目，依赖已发布的 npm 版本；它不依赖框架 src/dist 或 tsconfig paths。发布新框架版本时同步 archive 的 package dependency 与文档适用版本，然后重跑包外验收。

## 5. logo 与 npm README

站点把仓库 `logo_project.png` 复制为公共静态资源 `logo.png`，不从私有仓库的 raw 地址读取。仓库 README 使用仓库内图片路径，登录用户可以正常查看。

npm 上已经发布的版本保留发布时的 README。等 Pages 上线后，将 npm README 中的 logo 与文档链接改为实际公开站点地址，验证匿名访问，再随新的包版本发布；只改 Git 仓库不会更新已发布版本。

## 6. 日常维护

对 API 更改同步更新逐节点参考与示例；对第三方 SDK 升级重跑相关集成；对路径/文件名变更执行站点构建。文档描述已发布契约，示例中的本地测试结果不要写成所有供应商或所有数据库的普遍保证。

部署流程参考 [VitePress 官方部署文档](https://vitepress.dev/guide/deploy) 和 [GitHub Pages 文档](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)。

页头在桌面和手机始终显示 English / 简体中文。切换会加载当前主题的完整语言页面，统一更新首页、导航、侧栏、搜索和界面提示，不携带不同语言的标题锚点。首次进入根路径为英文，后续页面跳转保持 URL 中选择的语言。旧 `.zh-CN.html` 页面会跳转到 `/zh/` 对应页面；`/en/` 保留为英文首页别名。开发和验证先在 dev 完成，再合并 main 发布，结束后回到 dev。
