<script setup lang="ts">
import DefaultTheme from 'vitepress/theme';
import { useData } from 'vitepress';
import LanguageSwitch from './LanguageSwitch.vue';
const { lang } = useData();
</script>

<template>
  <DefaultTheme.Layout :key="lang">
    <template #nav-bar-content-after><LanguageSwitch /></template>
  </DefaultTheme.Layout>
</template>
