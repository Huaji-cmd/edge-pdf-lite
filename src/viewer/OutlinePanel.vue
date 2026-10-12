<script setup lang="ts">
/**
 * 目录面板（PDF 书签）。
 *
 * ⚠️ **空状态必须写清楚**：很多 PDF 根本没有书签 —— 尤其是扫描件
 * （实体书扫出来的整页图片，没有目录结构可言）。那时候不是工具坏了，
 * 得直接告诉用户"这份 PDF 没有书签，可以用缩略图翻页"，
 * 否则他只会觉得这个功能是坏的。
 */
import type { OutlineNode } from './outline'
import OutlineItem from './OutlineItem.vue'

defineProps<{
  nodes: readonly OutlineNode[]
  currentPage: number
  loading: boolean
  /** 层级深于此的默认收起 */
  autoCollapseBelow?: number
}>()

const emit = defineEmits<{ go: [pageNumber: number, destTop: number | null] }>()
</script>

<template>
  <div class="outline-panel">
    <div v-if="loading" class="empty dim">正在解析目录…</div>

    <div v-else-if="!nodes.length" class="empty">
      <p>这份 PDF 没有书签目录</p>
      <p class="dim">
        扫描件通常都没有（整页图片，没有目录结构）。<br />
        翻页可以用右边的「缩略图」。
      </p>
    </div>

    <ul v-else class="root">
      <OutlineItem
        v-for="(n, i) in nodes"
        :key="i"
        :node="n"
        :current-page="currentPage"
        :auto-collapse-below="autoCollapseBelow ?? 2"
        @go="(p, t) => emit('go', p, t)"
      />
    </ul>
  </div>
</template>

<style scoped>
.outline-panel {
  padding: 6px 4px;
  /* ⚠️ 自己滚 —— 侧边栏的 .body 故意不滚，见 SidePanel.vue 的说明 */
  overflow: auto;
  height: 100%;
}

.root {
  margin: 0;
  padding: 0;
  list-style: none;
}

.empty {
  padding: 18px 12px;
  font-size: 12.5px;
  color: var(--dim);
  line-height: 1.7;
}
.empty p {
  margin: 0 0 6px;
}
.dim {
  color: var(--dim-2);
  font-size: 12px;
}
</style>
