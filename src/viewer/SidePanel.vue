<script setup lang="ts">
/**
 * 左侧边栏：文件 / 搜索 / 目录 / 缩略图 四个面板，由顶栏的图标切换。
 *
 * ⚠️ 两个"重量级"面板（目录、缩略图）**各自滚动**，外层 `.body` 不滚。
 *    缩略图要靠 IntersectionObserver 做懒渲染，而 IO 的 `root` 必须是真正的
 *    滚动容器；如果 root 是外层不滚动的 div，可见性判定就退化成"相对视口"，
 *    滚出面板的项仍会被判成可见 —— 等于没做懒渲染。
 */
import type { PdfDocument } from './pdfDocument'
import type { OutlineNode } from './outline'
import type { PageSize, SidePanelKind } from './types'
import type { FileNode } from './fileList'
import FilesPanel from './FilesPanel.vue'
import SearchPanel from './SearchPanel.vue'
import OutlinePanel from './OutlinePanel.vue'
import Thumbnails from './Thumbnails.vue'

defineProps<{
  /** 当前显示哪个面板 */
  panel: SidePanelKind
  doc: PdfDocument | null
  outline: readonly OutlineNode[]
  outlineLoading: boolean
  sizes: PageSize[] | null
  currentPage: number
  /** 文件列表（文件 / 搜索两个面板共用） */
  fileNodes: readonly FileNode[]
  currentFileId: string | null
  busy: boolean
}>()

const emit = defineEmits<{
  /** 跳到书签位置（带页内纵向坐标） */
  'go-dest': [pageNumber: number, destTop: number | null]
  /** 跳到某一页 */
  'go-page': [pageNumber: number]
  /** 点文件列表 / 搜索结果里的一个文件（桌面端有真实路径，浏览器端只有 File） */
  'open-file': [node: FileNode]
  /** 文件列表内容变了 */
  'files-change': []
}>()
</script>

<template>
  <aside class="side">
    <div class="body">
      <FilesPanel
        v-if="panel === 'files'"
        :nodes="fileNodes"
        :current-id="currentFileId"
        :busy="busy"
        @open="(n) => emit('open-file', n)"
        @change="emit('files-change')"
      />
      <SearchPanel
        v-else-if="panel === 'search'"
        :nodes="fileNodes"
        :current-id="currentFileId"
        @open="(n) => emit('open-file', n)"
      />

      <OutlinePanel
        v-else-if="panel === 'outline'"
        :nodes="outline"
        :current-page="currentPage"
        :loading="outlineLoading"
        @go="(p, t) => emit('go-dest', p, t)"
      />
      <Thumbnails
        v-else-if="panel === 'thumbs' && doc"
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
  width: 260px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: #171a20;
  border-right: 1px solid #2b313a;
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
