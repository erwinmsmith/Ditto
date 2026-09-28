import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// The source tree keeps its existing Markdown conventions; the website uses
// matching English and Chinese routes so VitePress can switch the current page.
const chineseSources = new Set(['examples/patterns/rag-qa/fixtures/handbook.md']);
export function sourceLocale(file) {
  return file.endsWith('.zh-CN.md') ||
    (file.startsWith('docs/handbook/') && !file.endsWith('.en.md')) ||
    chineseSources.has(file) ? 'zh' : 'en';
}
export function topicPath(file) {
  return file.replace(/\.(?:zh-CN|en)\.md$/, '.md');
}
export function pagePath(file) {
  return (sourceLocale(file) === 'zh' ? 'zh/' : '') + topicPath(file);
}
export function pageUrl(path) {
  return '/' + path.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '.html');
}
export const logoName = 'logo-' + createHash('sha256')
  .update(readFileSync(new URL('../logo_project.png', import.meta.url)))
  .digest('hex').slice(0, 12) + '.png';
