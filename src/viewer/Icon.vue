<script lang="ts">
/**
 * 可用的图标名 —— 对应 index.html 里 sprite 的 `#i-<name>`。
 *
 * ⚠️ 这里做成联合类型是有意的：如果哪个组件写了 sprite 里不存在的名字，
 *    **编译期就会报错**，而不是运行时画出一个空白（那类 bug 极难查）。
 *    新增图标时：先在 index.html 加 symbol，再在这里加名字。
 */
export type IconName =
  | 'sidebar'
  | 'file'
  | 'folder'
  | 'search'
  | 'list'
  | 'grid'
  | 'min'
  | 'max'
  | 'restore'
  | 'close'
  | 'prev'
  | 'next'
  | 'minus'
  | 'plus'
  | 'fitw'
  | 'fitp'
  | 'single'
  | 'dual'
  | 'cursor'
  | 'hand'
  | 'grab'
  | 'highlight'
  | 'underline'
  | 'strike'
  | 'pen'
  | 'area'
  | 'rect'
  | 'text'
  | 'eraser'
  | 'undo'
  | 'redo'
  | 'trash'
  | 'save'
  | 'chevron-left'
  | 'chevron-right'
  | 'chevron-down'
  | 'gear'
  | 'folder-open'
  | 'sun'
  | 'moon'
  | 'auto'
</script>

<script setup lang="ts">
defineProps<{ name: IconName }>()
</script>

<template>
  <svg
    class="ic"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <use :href="`#i-${name}`" />
  </svg>
</template>

<style scoped>
.ic {
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
  /* 图标继承按钮的 color，点亮状态跟着变，不用额外写样式 */
  color: inherit;
}
</style>
