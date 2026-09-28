import { defineConfig, type DefaultTheme } from 'vitepress';
import { slug } from 'github-slugger';
import { logoName } from '../locales.mjs';
import { themeI18n, markdownI18n } from '../theme-i18n.mjs';

const repository = process.env.GITHUB_REPOSITORY || 'erwinmsmith/Ditto';
const repositoryName = repository.split('/')[1]!;
const base = process.env.DOCS_BASE || (repositoryName.endsWith('.github.io') ? '/' : `/${repositoryName}/`);
const origin = `https://${repository.split('/')[0]!.toLowerCase()}.github.io`;
function navigation(zh: boolean): DefaultTheme.Config {
  const prefix = zh ? '/zh/' : '/';
  const label = (en: string, cn: string) => zh ? cn : en;
  const item = (text: string, path: string) => ({text,link:prefix+path});
  const guide = (en: string, cn: string, name: string) => item(label(en,cn),'docs/handbook/'+(name==='index'?'':name));
  const api = (en: string, cn: string, name: string) => item(label(en,cn),'docs/worker-api/'+name);
  return {
    logo: {src:'/'+logoName,alt:'Ditto'},
    siteTitle: label('Ditto Docs','Ditto 文档'),
    nav: [item(label('Guide','使用指南'),'docs/handbook/'),item(label('Worker API','Worker API 参考'),'docs/worker-api/README'),item(label('Examples','示例'),'docs/handbook/examples')],
    sidebar: [
      {text:label('Getting started','开始使用'),items:[guide('Reading guide','阅读路线','index'),item(label('Install and make your first call','安装与第一次调用'),'docs/package-guide'),guide('Project structure and a complete Agent','项目结构与完整 Agent','agent'),guide('Graph and Loop','Graph 与 Loop','graph-loop'),guide('Results, errors and recovery','返回值、错误与恢复','reliability')]},
      {text:label('Connect application capabilities','连接应用能力'),items:[guide('Models and inference','模型配置与推理','models'),guide('Tools: define, select and execute','Tool：定义、选择与执行','tools'),guide('MCP: external tool services','MCP：连接外部工具服务','mcp'),guide('Skills: load and compose instructions','Skill：加载与组合指令','skills'),guide('Databases and Memory algorithms','数据库与 Memory 算法','memory')]},
      {text:label('Worker internals','深入 Worker'),items:[guide('Responsibilities and data flow','Worker 职责与数据流','workers'),api('CONTEXT · Working context','CONTEXT · 工作上下文','context'),api('INFER · Inference and cache','INFER · 推理与缓存','infer'),api('MEMORY · Long-term memory','MEMORY · 长期记忆','memory'),api('INTERACTION · Actions and delivery','INTERACTION · 动作与交付','interaction')]},
      {text:label('Optional retrieval','可选检索包'),items:[guide('Installation, wiring and RAG','安装、接线与 RAG','retrieval'),api('RETRIEVAL · SEARCH','RETRIEVAL · SEARCH','retrieval'),api('Retrieval providers and databases','检索 Provider 与数据库','retrieval-providers')]},
      {text:label('Extend and deploy','扩展与部署'),items:[guide('Custom Workers and Nodes','自定义 Worker 与 Node','extensions'),guide('Deployment, resources and lifecycle','部署、资源与生命周期','deployment'),api('Composition, events and artifacts','组合、事件与 Artifact','composition'),api('Runtime and Sandbox','Runtime 与 Sandbox','runtime'),api('Checkpoints and token budgets','检查点与 token 预算','checkpoints'),api('Configuration reference','全部配置项','configuration'),api('Model providers','模型 Provider','providers')]},
      {text:label('Scenarios and examples','场景与示例'),items:[guide('Choose and run examples','选择并运行示例','examples'),item(label('Package basics','入门示例'),'examples/package-basics/README'),item(label('7 control-flow groups','7 类控制流程'),'examples/control-flow/README'),item(label('12 Agent capability groups','12 类基础能力'),'examples/capabilities/README'),item(label('16 execution patterns','16 类执行模式'),'examples/patterns/README'),item(label('Application tools and storage adapters','应用工具与数据库适配器'),'examples/_shared/README')]},
      {text:label('Reference','参考'),collapsed:true,items:[item(label('All Node contracts','所有 Node 契约'),'docs/13-node-api-contract'),api('API documentation map','API 文档地图','README'),item(label('Architecture','架构'),'docs/architecture'),guide('Maintain and publish documentation','维护 Markdown 与发布文档','publishing')]},
    ],
    outline:{level:[2,3],label:label('On this page','本页目录')},
    docFooter:{prev:label('Previous page','上一页'),next:label('Next page','下一页')},
    lastUpdated:{text:label('Last updated','最后更新')},
    langMenuLabel:label('Change language','切换语言'),
    returnToTopLabel:label('Return to top','返回顶部'),
    sidebarMenuLabel:label('Menu','目录'),
    darkModeSwitchLabel:label('Appearance','外观'),
    lightModeSwitchTitle:label('Switch to light theme','切换为浅色主题'),
    darkModeSwitchTitle:label('Switch to dark theme','切换为深色主题'),
    skipToContentLabel:label('Skip to content','跳转到正文'),
    notFound: {code:'404',title:label('PAGE NOT FOUND','页面未找到'),quote:label('This page does not exist. Return to the documentation home to continue.','此页面不存在，请返回文档首页继续阅读。'),linkLabel:label('Go to home','返回首页'),linkText:label('Take me home','返回首页')},
    footer:{message:'Ditto · @codesoul-co/ditto · Node.js 24+'},
  };
}
export default defineConfig({
  title:'Ditto', description:'Build Agents with Nodes, Workers, Graphs and Loops',lang:'en',base,
  srcDir:'.content',cleanUrls:false,
  locales:{
    root:{label:'English',lang:'en',themeConfig:navigation(false)},
    zh:{label:'简体中文',lang:'zh-CN',description:'用 Node、Worker、Graph 与 Loop 构建 Agent 的开发者文档',themeConfig:navigation(true)},
  },
  sitemap:{hostname:origin+base,transformItems:items=>items.filter(item=>!item.url.includes('.zh-CN.html')&&!item.url.startsWith('en/'))},
  markdown:{lineNumbers:true,anchor:{slugify:slug},config:markdownI18n},
  vite:{plugins:[themeI18n()]},
  themeConfig:{
    i18nRouting:true,
    search:{provider:'local',options:{locales:{zh:{translations:{button:{buttonText:'搜索',buttonAriaLabel:'搜索文档'},modal:{displayDetails:'显示详细结果',resetButtonTitle:'清除搜索',backButtonTitle:'关闭搜索',noResultsText:'没有找到结果',footer:{selectText:'选择',selectKeyAriaLabel:'回车',navigateText:'切换',navigateUpKeyAriaLabel:'上方向键',navigateDownKeyAriaLabel:'下方向键',closeText:'关闭',closeKeyAriaLabel:'Esc'}}}}}}},
    socialLinks:[{icon:'github',link:`https://github.com/${repository}`}],
  },
  transformHead({pageData}) {
    const redirect = pageData.frontmatter.redirect;
    if (redirect) return [
      ['meta',{ 'http-equiv':'refresh',content:`0;url=${base}${redirect.slice(1)}`}],
      ['meta',{name:'robots',content:'noindex'}],
      ['link',{rel:'canonical',href:origin+base+redirect.slice(1)}],
    ];
    if (pageData.relativePath==='404.md') return [];
    const topic=pageData.relativePath.replace(/^zh\//,'').replace(/(^|\/)index\.md$/,'$1').replace(/\.md$/,'.html');
    return [
      ['link',{rel:'alternate',hreflang:'en',href:origin+base+topic}],
      ['link',{rel:'alternate',hreflang:'zh-CN',href:origin+base+'zh/'+topic}],
      ['link',{rel:'alternate',hreflang:'x-default',href:origin+base+topic}],
    ];
  },
});
