// VitePress 1.6.4 exposes most UI translations in themeConfig, but these
// accessibility labels are literals in its standard theme. Translate them at
// compilation, retaining the upstream components and SSR/client parity.
const labels = {
  'VPNavBarHamburger.vue': [['aria-label="mobile navigation"', ':aria-label="dittoLang === \'zh-CN\' ? \'移动导航\' : \'Mobile navigation\'"']],
  'VPNavBarExtra.vue': [['label="extra navigation"', ':label="dittoLang === \'zh-CN\' ? \'更多导航\' : \'More navigation\'"']],
  'VPSidebarItem.vue': [['aria-label="toggle section"', ':aria-label="dittoLang === \'zh-CN\' ? \'展开或收起章节\' : \'Toggle section\'"']],
  'VPNavBarMenu.vue': [['Main Navigation', "{{ dittoLang === 'zh-CN' ? '主导航' : 'Main navigation' }}"]],
  'VPSidebar.vue': [['Sidebar Navigation', "{{ dittoLang === 'zh-CN' ? '侧栏导航' : 'Sidebar navigation' }}"]],
  'VPDocFooter.vue': [['>Pager<', ">{{ dittoLang === 'zh-CN' ? '翻页导航' : 'Page navigation' }}<"]],
};
export function themeI18n() {
  return {
    name: 'ditto-standard-theme-i18n', enforce: 'pre',
    transform(source, id) {
      if (!id.includes('/vitepress/dist/client/theme-default/components/') || id.includes('?')) return;
      const replacements = labels[id.split('/').pop()];
      if (!replacements) return;
      let code=source;
      for (const [before,after] of replacements) {
        if (code.split(before).length !== 2) throw new Error(`Review VitePress translation after upgrade: ${id}: ${before}`);
        code=code.replace(before,after);
      }
      code=code.replace(/(<script[^>]*>)/, "$1\nimport { useData as useDittoLocale } from 'vitepress';\nconst { lang: dittoLang } = useDittoLocale();");
      return {code,map:null};
    },
  };
}

export function markdownI18n(md) {
  const render=md.renderer.render.bind(md.renderer);
  md.renderer.render=(tokens,options,env)=> {
    const html=render(tokens,options,env);
    if (!env.relativePath?.startsWith('zh/')) return html;
    return html
      .replace(/title="Copy Code"/g,'title="复制代码"')
      .replace(/aria-label="Permalink to /g,'aria-label="链接到章节：');
  };
}
