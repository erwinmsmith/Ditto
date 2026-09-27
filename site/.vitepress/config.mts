import { defineConfig } from 'vitepress';
import { slug } from 'github-slugger';

const item = (text: string, path: string) => ({ text, link: '/' + path });
const guide = (text: string, name: string) => item(text, 'docs/handbook/' + (name === 'index' ? '' : name));
const api = (text: string, name: string) => item(text, 'docs/worker-api/' + name + '.zh-CN');
const zh = [
  { text: '开始使用', items: [guide('阅读路线', 'index'), item('安装与第一次调用', 'docs/package-guide.zh-CN'), guide('项目结构与完整 Agent', 'agent'), guide('Graph 与 Loop', 'graph-loop'), guide('返回值、错误与恢复', 'reliability')] },
  { text: '连接应用能力', items: [guide('模型配置与推理', 'models'), guide('Tool：定义、选择与执行', 'tools'), guide('MCP：连接外部工具服务', 'mcp'), guide('Skill：加载与组合指令', 'skills'), guide('数据库与 Memory 算法', 'memory')] },
  { text: '深入 Worker', items: [guide('Worker 职责与数据流', 'workers'), api('CONTEXT · 工作上下文', 'context'), api('INFER · 推理与缓存', 'infer'), api('MEMORY · 长期记忆', 'memory'), api('INTERACTION · 动作与交付', 'interaction')] },
  { text: '可选检索包', collapsed: false, items: [guide('安装、接线与 RAG', 'retrieval'), api('RETRIEVAL · SEARCH', 'retrieval'), api('检索 Provider 与数据库', 'retrieval-providers')] },
  { text: '扩展与部署', items: [guide('自定义 Worker 与 Node', 'extensions'), guide('部署、资源与生命周期', 'deployment'), api('组合、事件与 Artifact', 'composition'), api('Runtime 与 Sandbox', 'runtime'), api('检查点与 token 预算', 'checkpoints'), api('全部配置项', 'configuration'), api('模型 Provider', 'providers')] },
  { text: '场景与示例', collapsed: false, items: [guide('选择并运行示例', 'examples'), item('入门示例', 'examples/package-basics/README.zh-CN'), item('7 类控制流程', 'examples/control-flow/README.zh-CN'), item('12 类基础能力', 'examples/capabilities/README.zh-CN'), item('16 类执行模式', 'examples/patterns/README.zh-CN'), item('应用工具与数据库适配器', 'examples/_shared/README.zh-CN')] },
  { text: '参考', collapsed: true, items: [item('所有 Node 契约', 'docs/13-node-api-contract.zh-CN'), api('API 文档地图', 'README'), item('架构', 'docs/architecture.zh-CN'), guide('维护 Markdown 与发布文档', 'publishing')] },
];
const en = [
  { text: 'Getting started', items: [item('Reading guide', 'en/index'), item('Package guide', 'docs/package-guide'), item('Runnable basics', 'examples/package-basics/README')] },
  { text: 'Runtime and integrations', items: ['runtime','graph-loops','checkpoints','configuration','flows','providers','composition'].map(x => item(x, 'docs/worker-api/' + x)) },
  { text: 'Workers', items: ['context','infer','memory','interaction','retrieval','retrieval-providers'].map(x => item(x.toUpperCase(), 'docs/worker-api/' + x)) },
  { text: 'Examples', items: [item('Overview', 'examples/README'), item('Control flow', 'examples/control-flow/README'), item('Agent capabilities', 'examples/capabilities/README'), item('Execution patterns', 'examples/patterns/README')] },
];
const repository = process.env.GITHUB_REPOSITORY || 'erwinmsmith/Ditto';
const repositoryName = repository.split('/')[1]!;
const base = process.env.DOCS_BASE || (repositoryName.endsWith('.github.io') ? '/' : `/${repositoryName}/`);
export default defineConfig({
  title: 'Ditto', description: '用 Node、Worker、Graph 与 Loop 构建 Agent 的开发者文档',
  lang: 'zh-CN', base,
  srcDir: '.content', cleanUrls: false,
  sitemap: { hostname: `https://${repository.split('/')[0]!.toLowerCase()}.github.io${base}` },
  markdown: { lineNumbers: true, anchor: { slugify: slug } },
  themeConfig: {
    logo: '/logo.png', siteTitle: 'Ditto 文档',
    nav: [{text:'使用指南',link:'/docs/handbook/'},{text:'Worker API',link:'/docs/worker-api/README.zh-CN'},{text:'示例',link:'/docs/handbook/examples'},{text:'English',link:'/en/'}],
    sidebar: { '/': zh, '/en/': en },
    outline: { level: [2,3], label: '本页目录' },
    search: { provider: 'local' },
    socialLinks: [{icon:'github',link:`https://github.com/${repository}`}],
    docFooter: { prev: '上一页', next: '下一页' },
    footer: { message: 'Ditto · @codesoul-co/ditto · Node.js 24+' },
  },
});
