import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, cp, rm, mkdtemp, stat } from 'node:fs/promises';
import { resolve, dirname, posix, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'site/.content');
const candidates = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'docs', 'examples', 'scripts', 'ditto.yaml', '.env.example', 'test/control-flow-boundary.test.ts', 'site/README.md', 'README.md', 'README.zh-CN.md'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const files = [...new Set(candidates)].filter(path =>
  !path.split('/').some(part => ['AGENTS.md','agents.md','node_modules','.venv','__pycache__'].includes(part)) &&
  !/(?:^|\/)\.env(?:$|\.(?!example$))/.test(path) &&
  !/\.(?:sqlite(?:-wal|-shm)?|log|pid|tgz|tmp|pyc)$/.test(path) &&
  !/live-results|architecture-review-2026|refactor-2026/.test(path));
const known = new Set(files);
const documents = files.filter(p => p.endsWith('.md'));
const sourcePages = new Set();
const missing = [];
const downloadName = file => file.endsWith('.cjs') || file.endsWith('.env.example') ? file + '.txt' : file;
const sourceName = file => file.split('/').map(part => part.startsWith('.') ? part.slice(1) : part).join('/');
await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'public/downloads'), { recursive: true });
await writeFile(join(out,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022'}}));
await cp(join(root, 'logo_project.png'), join(out, 'public/logo.png'));

function target(path, from) {
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
    const preferred = from.includes('.zh-CN') || from.startsWith('docs/handbook/') ? 'README.zh-CN.md' : 'README.md';
    if (known.has(posix.join(file, preferred))) file = posix.join(file, preferred);
    else if (known.has(posix.join(file, 'README.md'))) file = posix.join(file, 'README.md');
  }
  if (file === 'logo_project.png' || file === 'logo.png') return '/logo.png';
  if (!known.has(file)) { missing.push({ from, path, resolved: file }); return path; }
  if (file.endsWith('.md')) return '/' + file + (anchor ? '#' + anchor : '');
  if (['.ts','.mjs','.cjs','.js','.json','.yaml','.yml','.py','.txt','.lock','.sh'].includes(extname(file)) || file.endsWith('.env.example')) {
    sourcePages.add(file); return '/code/' + sourceName(file) + '.md';
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
  markdown = markdown.replaceAll('src="./logo_project.png"', 'src="/logo.png"');
  markdown = markdown.replace(/^<<<\s+([^\n]+)$/gm, (_all, relative) => {
    const path = posix.normalize(posix.join(posix.dirname(file), relative.trim()));
    if (!known.has(path)) throw new Error('Unknown snippet: ' + path);
    const content = execFileSync(process.execPath, ['-e', 'process.stdout.write(require("fs").readFileSync(process.argv[1],"utf8"))', join(root,path)], {encoding:'utf8'});
    return '```' + (extname(path) === '.ts' ? 'ts' : 'js') + '\n' + content + '\n```';
  });
  // Rewrite navigation outside code fences; source code and shell commands remain exact.
  const chunks = markdown.split(/(^```[^\n]*\n[\s\S]*?^```\s*$)/gm);
  markdown = chunks.map(chunk => chunk.startsWith('```') ? chunk : chunk.replace(/(!?\[[^\]\n]*\])\(([^\s)]+)\)/g, (_m, label, href) => `${label}(${target(href,file)})`)).join('');
  await put(join(out,file),markdown);
}
for (const file of sourcePages) {
  const content = await readFile(join(root,file),'utf8');
  const fence = '`'.repeat(Math.max(3, ...[...content.matchAll(/`+/g)].map(m => m[0].length + 1)));
  // Large source files use plain text to keep static-site compilation bounded.
  const lang = content.length < 12_000 ? ({'.ts':'ts','.mjs':'js','.js':'js','.json':'json','.yaml':'yaml','.py':'python'}[extname(file)] || 'text') : 'text';
  await put(join(out,'code',sourceName(file)+'.md'), `---\noutline: false\nsearch: false\n---\n# ${posix.basename(file)}\n\n源文件：\`${file}\` · [下载原文件](/downloads/${downloadName(file)}) · [示例使用说明](/docs/handbook/examples)\n\n${fence}${lang}\n${content}\n${fence}\n`);
}
await put(join(out,'index.md'),`---
layout: home
hero:
  name: Ditto
  text: Agent 开发者文档
  tagline: 从第一个 Graph 到可恢复的完整 Agent。按需组合 Worker、Loop、工具、MCP、Skill 与数据库。
  actions:
    - theme: brand
      text: 开始搭建 Agent
      link: /docs/handbook/index
    - theme: alt
      text: Worker API
      link: /docs/worker-api/README.zh-CN
    - theme: alt
      text: 运行完整示例
      link: /docs/handbook/examples
features:
  - title: 从安装到交付
    details: 项目结构、模型配置、Graph 与 Loop、错误处理与真实答案文件。
    link: /docs/handbook/agent
  - title: 连接工具与知识
    details: Tool、MCP、Skill、Redis Context、数据库 Memory 与检索算法。
    link: /docs/handbook/tools
  - title: 深入与扩展
    details: 四类内置 Worker、可选检索包、自定义 Worker / Node 与部署生命周期。
    link: /docs/handbook/workers
---

## 安装

\`\`\`sh
npm install @codesoul-co/ditto
# 可选检索能力
npm install @codesoul-co/ditto-retrieval
\`\`\`

需要 Node.js 24+、npm 11+，使用 ESM。完整目录与运行方法见[开发者手册](/docs/handbook/index)。
`);
await put(join(out,'en/index.md'),`# Ditto documentation\n\nBuild Agents with explicit Nodes, Workers, Graphs and Loops. Install \`@codesoul-co/ditto\`; add \`@codesoul-co/ditto-retrieval\` when you need the optional search Worker.\n\n## Start here\n\n1. [Install and run a Graph](/docs/package-guide.md).\n2. [Run the persistent Agent](/examples/package-basics/README.md): real model, Redis Context, file SQLite Memory, process recovery and answer delivery.\n3. [Understand Graph and Loop composition](/docs/worker-api/graph-loops.md).\n4. [Browse every Worker API](/docs/worker-api/README.md).\n5. [Run the application patterns](/examples/patterns/README.md).\n\n## Integrations and extensions\n\n[Tools and MCP](/docs/worker-api/interaction.md) · [Skill and predefined flows](/docs/worker-api/flows.md) · [Database Memory](/docs/worker-api/memory.md) · [Optional retrieval](/docs/worker-api/retrieval.md) · [Custom Worker / Node](/docs/worker-api/composition.md)\n\n## Download\n\n[Download consumer examples](/downloads/ditto-examples.zip). Extract, run \`npm install\`, then follow each README for application dependencies. The archive contains public-API examples and application adapters; no framework source, credentials or installed dependencies.\n`);
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
