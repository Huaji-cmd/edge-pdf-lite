<script setup lang="ts">
/**
 * 侧边栏：目录 / 缩略图。
 *
 * ⚠️ 两个面板**各自滚动**（`.body` 不滚）—— 缩略图要用 IntersectionObserver
 *    做懒渲染，而 IO 的 `root` 必须是真正的滚动容器；如果 root 是外层不滚动的
 *    div，可见性判定就会退化成"相对视口"，滚出面板的项仍会被判成可见，
 *    等于没做懒渲染。
 */
import { ref } from 'vue'
import type { PdfDocument } from './pdfDocument'
import type { OutlineNode } from './outline'
import type { PageSize } from './types'
import OutlinePanel from './OutlinePanel.vue'
import Thumbnails from './Thumbnails.vue'

defineProps<{
  doc: PdfDocument | null
  outline: readonly OutlineNode[]
  outlineLoading: boolean
  sizes: PageSize[] | null
  currentPage: number
}>()

const emit = defineEmits<{
  /** 跳到书签位置（带页内纵向坐标） */
  'go-dest': [pageNumber: number, destTop: number | null]
  /** 跳到某一页 */
  'go-page': [pageNumber: number]
}>()

type Tab = 'outline' | 'thumbs'
const tab = ref<Tab>('outline')
</script>

<template>
  <aside class="side">
    <div class="tabs">
      <button
        :class="['tab', tab === 'outline' ? 'on' : '']"
        title="PDF 自带的书签目录"
        @click="tab = 'outline'"
      >
        目录
      </button>
      <button
        :class="['tab', tab === 'thumbs' ? 'on' : '']"
        title="每页的缩略图"
        @click="tab = 'thumbs'"
      >
        缩略图
      </button>
    </div>

    <div class="body">
      <OutlinePanel
        v-if="tab === 'outline'"
        :nodes="outline"
        :current-page="currentPage"
        :loading="outlineLoading"
        @go="(p, t) => emit('go-dest', p, t)"
      />
      <Thumbnails
        v-else-if="doc"
        :doc="doc"
        :sizes="sizes"
        :current-page="currentPage"
        @go="(p) => emit('go-page', p)"
      />
    </div>
  </aside>
</template>

<style scoped>
.side {
  flex: 0 0 auto;
  width: 200px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: #171a20;
  border-right: 1px solid #2b313a;
}

.tabs {
  flex: 0 0 auto;
  display: flex;
  gap: 2px;
  padding: 6px 6px 0;
}

.tab {
  flex: 1 1 0;
  padding: 4px 0;
  border: 1px solid transparent;
  border-radius: 5px 5px 0 0;
  background: none;
  color: #8b93a1;
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}
.tab:hover {
  color: #d7dce4;
}
.tab.on {
  background: #1f242c;
  border-color: #2b313a;
  border-bottom-color: transparent;
  color: #cfe4ff;
  font-weight: 600;
}

/* ⚠️ 这里**不滚动** —— 滚动交给里面的面板自己，理由见文件头 */
.body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  display: flex;
}
.body > * {
  flex: 1 1 auto;
  min-width: 0;
}
</style>
