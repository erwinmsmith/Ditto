# 文档编译

使用 VitePress 标准主题。源 Markdown 在 `../docs` 和 `../examples`；英文为默认语言，中文位于 `/zh/`。本地编译不发布网站。配置与维护方式见[发布指南](../docs/handbook/publishing.md)。

```sh
npm ci --prefix site
npm run build --prefix site
npm run preview --prefix site
```

输出目录为 `site/.vitepress/dist`，临时 Markdown 为 `site/.content`，均不提交。`prepare.mjs` 配对双语文档、解析相对链接、引入可执行代码、生成代码页和消费者示例下载包。`check.mjs` 检查页面、锚点、资源、下载和语言对应关系。构建不会执行示例或加载 `.env`。

默认 base 根据 `GITHUB_REPOSITORY` 生成，本地回退为 `erwinmsmith/Ditto`。根域名站点可设 `DOCS_BASE=/`。工作流手动触发，默认仅构建，只有在 main 显式选择 deploy 才发布。

用 `npm run dev --prefix site` 预览。修改源文档后重新执行；不要编辑临时目录。手册采用 `name.md` 中文和 `name.en.md` 英文，其他文档采用 `name.md` 英文和 `name.zh-CN.md` 中文。新增页面必须提供对应翻译。
