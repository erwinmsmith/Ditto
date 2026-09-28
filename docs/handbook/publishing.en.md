# Maintain Markdown and publish documentation

The site uses the standard VitePress theme. English is the default at `/`; Simplified Chinese lives under `/zh/`. Each topic has matching routes so the always-visible website language selector keeps the current topic. No page-specific frontend components are required.

## 1. Build locally

Use Node.js 24+:

```sh
npm ci --prefix site
npm run build --prefix site
npm run preview --prefix site
```

For development use `npm run dev --prefix site`. The build stages allowed Markdown and examples in `site/.content` and writes `site/.vitepress/dist`. Generated content, dependencies and output are ignored by Git.

Rebuild after editing source Markdown. The build does not mutate source documents, load model credentials, connect Redis/databases or execute example business actions.

## 2. Add a bilingual page

1. In the handbook, keep Chinese in `name.md` and English in `name.en.md`. Existing API/example pairs use `name.md` for English and `name.zh-CN.md` for Chinese.
2. Link to the actual source Markdown using relative links. Use standard second/third-level headings.
3. Add the same topic to both navigation trees in `site/.vitepress/config.mts`.
4. Keep runnable code in example files and include it with `<<< ../../examples/...`.
5. Build and validate links, locale pairs and rendered language controls. Check desktop/mobile navigation and search.

The preparation step derives language routes from source pairs. Code viewers keep original executable code but translate their surrounding labels. Old `.zh-CN.html` addresses redirect to the corresponding `/zh/` page. `/en/` remains an alias for the English home. The header shows English and Simplified Chinese on desktop and mobile. Selecting a language loads the entire localized page, including navigation, search and interface labels, without carrying incompatible heading fragments. A fresh visit to the root opens English; internal navigation retains the language selected in the URL.

Download archives retain original source paths. Credentials, node_modules, local agent instructions, databases and run reports are excluded.

## 3. Pages configuration

In GitHub Settings → Pages choose GitHub Actions. The `Documentation` workflow builds by default; select deploy when manually running it on main to publish. A local build does not enable Pages or change repository visibility.

The default base derives from the repository name in `GITHUB_REPOSITORY`; override it with `DOCS_BASE`. Use `/` for an organization/user site or custom root domain, and `/<repository>/` for project sites. Rebuild after repository transfer or base changes instead of editing generated HTML.

Follow the repository workflow: develop and validate on dev, merge the validated branch into main, then deploy main. Return the local checkout to dev afterward.

## 4. Keep Markdown, code and downloads aligned

`site/prepare.mjs` generates staged pages and the consumer zip. `site/check.mjs` validates local pages, sections, assets, downloads and language pairs. VitePress also validates Markdown links.

The archive installs published npm versions without framework src/dist or tsconfig paths. Keep its package dependency and documentation version aligned during releases, then rerun package-consumer validation.

## 5. Logo and npm README

The site copies `logo_project.png` to the public `logo.png` asset. Repository README images use the repository file. Published npm versions retain the README from publication time; a Git change alone does not update them. Verify public image/documentation URLs and include README changes in a new package release when needed.

## 6. Routine maintenance

Update both languages, API references and examples with contract changes. Rerun affected integrations after SDK upgrades and the documentation build after path changes. Describe published behavior; local test success is not a guarantee for every provider/database.

See [VitePress deployment](https://vitepress.dev/guide/deploy) and [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site).
