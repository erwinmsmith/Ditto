import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, cp, rm, mkdtemp, stat } from 'node:fs/promises';
import { resolve, dirname, posix, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { sourceLocale, topicPath, pagePath, pageUrl, logoName } from './locales.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'site/.content');
const candidates = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'docs', 'examples', 'scripts', 'ditto.yaml', '.env.example', 'test/control-flow-boundary.test.ts', 'site/README.md', 'site/README.zh-CN.md', 'README.md', 'README.zh-CN.md'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const files = [...new Set(candidates)].filter(path =>
  !path.split('/').some(part => ['AGENTS.md','agents.md','node_modules','.venv','__pycache__'].includes(part)) &&
  !/(?:^|\/)\.env(?:$|\.(?!example$))/.test(path) &&
  !/\.(?:sqlite(?:-wal|-shm)?|log|pid|tgz|tmp|pyc)$/.test(path) &&
  !/live-results|architecture-review-2026|refactor-2026/.test(path));
const known = new Set(files);
const documents = files.filter(p => p.endsWith('.md'));
const sourcePages = new Set();
const routes = new Map();
for (const file of documents) {
  const topic = topicPath(file);
  const pair = routes.get(topic) || {};
  const lang = sourceLocale(file);
  if (pair[lang]) throw new Error('Duplicate translation: ' + file);
  pair[lang] = file; routes.set(topic, pair);
}
for (const [topic, pair] of routes) {
  if (!pair.en || !pair.zh) throw new Error('Missing translation: ' + topic);
}
const missing = [];
const downloadName = file => file.endsWith('.cjs') || file.endsWith('.env.example') ? file + '.txt' : file;
const sourceName = file => file.split('/').map(part => part.startsWith('.') ? part.slice(1) : part).join('/');
await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'public/downloads'), { recursive: true });
await writeFile(join(out,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022'}}));
await cp(join(root, 'logo_project.png'), join(out, 'public/logo.png'));
await cp(join(root, 'logo_project.png'), join(out, 'public', logoName));

function target(path, from, label = "") {
  if (/^(?:https?:|mailto:|tel:|data:)/.test(path)) {
    const local = /^https:\/\/github.com\/erwinmsmith\/Ditto\/(?:blob|tree)\/(?:main|dev)\/(.*)$/.exec(path);
    if (!local) return path;
    path = '/' + local[1];
  }
  if (path.startsWith('#') || path.startsWith('/downloads/')) return path;
  const [pathname, anchor] = path.split('#');
  let file = posix.normalize(pathname.startsWith('/') ? pathname.slice(1) : posix.join(posix.dirname(from), pathname));
  if (file === '.' || file === '') file = 'README.md';
  if (!known.has(file)) {
    const preferred = sourceLocale(from) === 'zh' ? 'README.zh-CN.md' : 'README.md';
    if (known.has(posix.join(file, preferred))) file = posix.join(file, preferred);
    else if (known.has(posix.join(file, 'README.md'))) file = posix.join(file, 'README.md');
  }
  if (file === 'logo_project.png' || file === 'logo.png') return '/' + logoName;
  if (!known.has(file)) { missing.push({ from, path, resolved: file }); return path; }
  if (file.endsWith('.md')) {
    const explicitLanguageLink = /English|中文|简体|source document|原文/.test(label);
    const preferred = routes.get(topicPath(file))?.[sourceLocale(from)];
    const selected = !explicitLanguageLink && preferred ? preferred : file;
    // A translated section has a different anchor; automatic locale correction
    // links to the same topic, while explicit language/source links keep theirs.
    return '/' + pagePath(selected) + (anchor && selected === file ? '#' + anchor : '');
  }
  if (['.ts','.mjs','.cjs','.js','.json','.yaml','.yml','.py','.txt','.lock','.sh'].includes(extname(file)) || file.endsWith('.env.example')) {
    sourcePages.add(file); return (sourceLocale(from) === 'zh' ? '/zh' : '') + '/code/' + sourceName(file) + '.md';
  }
  return '/downloads/' + file;
}
async function put(path, content) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); }
for (const file of files.filter(p => !p.endsWith('.md'))) {
  await mkdir(dirname(join(out, 'public/downloads', downloadName(file))), { recursive: true });
  await cp(join(root, file), join(out, 'public/downloads', downloadName(file)));
}
for (const file of documents) {
  let markdown = await readFile(join(root, file), 'utf8');
  markdown = markdown.replaceAll('src="./logo_project.png"', 'src="/' + logoName + '"');
  markdown = markdown.replace(/^<<<\s+([^\n]+)$/gm, (_all, relative) => {
    const path = posix.normalize(posix.join(posix.dirname(file), relative.trim()));
    if (!known.has(path)) throw new Error('Unknown snippet: ' + path);
    const content = execFileSync(process.execPath, ['-e', 'process.stdout.write(require("fs").readFileSync(process.argv[1],"utf8"))', join(root,path)], {encoding:'utf8'});
    return '```' + (extname(path) === '.ts' ? 'ts' : 'js') + '\n' + content + '\n```';
  });
  // Rewrite navigation outside code fences; source code and shell commands remain exact.
  const chunks = markdown.split(/(^```[^\n]*\n[\s\S]*?^```\s*$)/gm);
  markdown = chunks.map(chunk => chunk.startsWith('```') ? chunk : chunk.replace(/(!?\[[^\]\n]*\])\(([^\s)]+)\)/g, (_m, label, href) => `${label}(${target(href,file,label)})`)).join('');
  await put(join(out,pagePath(file)),markdown);
}
for (const file of sourcePages) {
  const content = await readFile(join(root,file),'utf8');
  const fence = '`'.repeat(Math.max(3, ...[...content.matchAll(/`+/g)].map(m => m[0].length + 1)));
  const lang = content.length < 12_000 ? ({'.ts':'ts','.mjs':'js','.js':'js','.json':'json','.yaml':'yaml','.py':'python'}[extname(file)] || 'text') : 'text';
  for (const locale of ['en','zh']) {
    const prefix = locale === 'zh' ? 'zh/' : '';
    const labels = locale === 'zh' ? ['源文件','下载原文件','示例使用说明'] : ['Source','Download source','Example guide'];
    await put(join(out,prefix,'code',sourceName(file)+'.md'), `---\noutline: false\nsearch: false\n---\n# ${posix.basename(file)}\n\n${labels[0]}: \`${file}\` · [${labels[1]}](/downloads/${downloadName(file)}) · [${labels[2]}](/${prefix}docs/handbook/examples)\n\n${fence}${lang}\n${content}\n${fence}\n`);
  }
}
for (const locale of ['en','zh']) {
  const prefix = locale === 'zh' ? '/zh' : '';
  const zh = locale === 'zh';
  await put(join(out,zh ? 'zh/index.md' : 'index.md'), `---
layout: home
hero:
  name: Ditto
  text: ${zh ? 'Agent 开发者文档' : 'Agent developer documentation'}
  tagline: ${zh ? '从第一个 Graph 到可恢复的完整 Agent。按需组合 Worker、Loop、工具、MCP、Skill 与数据库。' : 'From your first Graph to a recoverable Agent. Compose Workers, Loops, tools, MCP, skills and databases.'}
  actions:
    - theme: brand
      text: ${zh ? '开始搭建 Agent' : 'Build your first Agent'}
      link: ${prefix}/docs/handbook/
    - theme: alt
      text: Worker API
      link: ${prefix}/docs/worker-api/README
    - theme: alt
      text: ${zh ? '运行完整示例' : 'Run complete examples'}
      link: ${prefix}/docs/handbook/examples
features:
  - title: ${zh ? '从安装到交付' : 'From installation to delivery'}
    details: ${zh ? '项目结构、模型配置、Graph 与 Loop、错误处理与真实答案文件。' : 'Project layout, model configuration, Graphs and Loops, errors and actual answer files.'}
    link: ${prefix}/docs/handbook/agent
  - title: ${zh ? '连接工具与知识' : 'Connect tools and knowledge'}
    details: ${zh ? 'Tool、MCP、Skill、Redis Context、数据库 Memory 与检索算法。' : 'Tools, MCP, skills, Redis Context, database Memory and retrieval algorithms.'}
    link: ${prefix}/docs/handbook/tools
  - title: ${zh ? '深入与扩展' : 'Explore and extend'}
    details: ${zh ? '四类内置 Worker、可选检索包、自定义 Worker / Node 与部署生命周期。' : 'Four built-in Workers, optional retrieval, custom Workers and Nodes, and deployment lifecycle.'}
    link: ${prefix}/docs/handbook/workers
---

## ${zh ? '安装' : 'Installation'}

\`\`\`sh
npm install @codesoul-co/ditto
# ${zh ? '可选检索能力' : 'Optional retrieval'}
npm install @codesoul-co/ditto-retrieval
\`\`\`

${zh ? '需要 Node.js 24+、npm 11+，使用 ESM。完整目录与运行方法见' : 'Requires Node.js 24+, npm 11+ and ESM. Continue with the '}[${zh ? '开发者手册' : 'developer handbook'}](${prefix}/docs/handbook/).
`);
}
// Preserve previously published language-suffixed URLs without indexing duplicate content.
const redirects = [{from:'en/index.md',to:'/'}];
for (const file of documents) {
  if (file.endsWith('.zh-CN.md')) redirects.push({from:file,to:pageUrl(pagePath(file))});
}
for (const {from,to} of redirects) {
  await put(join(out,from), `---\nlayout: false\nsearch: false\nsidebar: false\nredirect: ${JSON.stringify(to)}\n---\n\n[Continue / 继续阅读](${to})\n`);
}
const localePairs = ['index.md', ...routes.keys(), ...[...sourcePages].map(file=>'code/'+sourceName(file)+'.md')];
await put(join(out,'locale-manifest.json'),JSON.stringify({pairs:localePairs,redirects},null,2));
const temp = await mkdtemp(join(tmpdir(),'ditto-docs-examples-'));
try {
  for (const file of files.filter(p => p.startsWith('examples/') || p.startsWith('docs/') || p === 'ditto.yaml')) {
    await mkdir(dirname(join(temp,file)),{recursive:true}); await cp(join(root,file),join(temp,file));
  }
  const pkg = JSON.parse(await readFile(join(root,'package.json'),'utf8'));
  const scripts = Object.fromEntries(Object.entries(pkg.scripts).filter(([k]) => k.startsWith('example:')).map(([k,v]) => [k,v.replace(/^npm run build && /,'')]));
  await put(join(temp,'package.json'),JSON.stringify({name:'ditto-consumer-examples',private:true,type:'module',scripts,
    dependencies:{'@codesoul-co/ditto':pkg.version,'@codesoul-co/ditto-retrieval':'0.1.0',redis:'6.2.1'},devDependencies:{typescript:pkg.devDependencies.typescript,'@types/node':pkg.devDependencies['@types/node']}},null,2)+'\n');
  await put(join(temp,'README.md'),'# Ditto consumer examples\n\nRun `npm install`, then `node examples/package-basics/context.ts`. For real-model examples, copy `examples/package-basics/.env.example` to `.env` and configure the provider and Redis. See each example README for optional application dependencies.\n\nThis archive installs published npm packages. Framework build and check:* scripts described in repository documentation belong to the source repository and are not required here. Keep relative paths when copying application adapters.\n');
  await put(join(temp,'.gitignore'),'.env\nnode_modules/\n.examples-*-tasks/\n*.sqlite*\n');
  execFileSync('zip',['-q','-r',join(out,'public/downloads/ditto-examples.zip'),'.'],{cwd:temp});
} finally { await rm(temp,{recursive:true,force:true}); }
await put(join(out,'site-manifest.json'),JSON.stringify({documents:documents.length,sourcePages:sourcePages.size,files:files.length,missing},null,2));
console.log(`Prepared ${documents.length} Markdown pages and ${sourcePages.size} source pages.`);
if(missing.length){console.error(JSON.stringify(missing,null,2));throw new Error(`${missing.length} unresolved source links`);}
