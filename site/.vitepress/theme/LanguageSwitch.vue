<script setup lang="ts">
import { computed } from 'vue';
import { useData, withBase } from 'vitepress';

const { page, lang } = useData();
const topic = computed(() => page.value.isNotFound ? '' : page.value.relativePath
  .replace(/^zh\//, '')
  .replace(/(^|\/)index\.md$/, '$1')
  .replace(/\.md$/, '.html'));
const english = computed(() => withBase('/' + topic.value));
const chinese = computed(() => withBase('/zh/' + topic.value));
</script>

<template>
  <nav class="site-language" :aria-label="lang === 'zh-CN' ? '网站语言' : 'Website language'">
    <!-- A document navigation reloads the complete localized shell and resets
         transient menus/search state. target=_self bypasses VitePress SPA routing. -->
    <a :href="english" target="_self" lang="en" hreflang="en"
      :aria-current="lang === 'en' ? 'true' : undefined">English</a>
    <span aria-hidden="true">/</span>
    <a :href="chinese" target="_self" lang="zh-CN" hreflang="zh-CN"
      :aria-current="lang === 'zh-CN' ? 'true' : undefined">简体中文</a>
  </nav>
</template>
