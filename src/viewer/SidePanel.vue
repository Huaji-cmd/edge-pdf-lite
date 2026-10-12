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
import SettingsPanel from './SettingsPanel.vue'
import Icon from './Icon.vue'

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
  /** 切到某个面板（底部齿轮用） */
  'set-panel': [panel: SidePanelKind]
  /** 设置面板要弹提示 */
  toast: [msg: string]
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

      <SettingsPanel v-else-if="panel === 'settings'" @toast="(m) => emit('toast', m)" />
    </div>

    <!--
      底部：设置入口。
      ⚠️ 它**不属于**任何一个面板，所以放在 .body 外面 ——
         否则切到别的面板它就消失了，而"设置"应该随时能进。
    -->
    <div class="foot">
      <button
        class="gear"
        :class="{ on: panel === 'settings' }"
        data-tid="side-settings"
        title="设置"
        @click="emit('set-panel', 'settings')"
      >
        <Icon name="gear" />
        <span>设置</span>
      </button>
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
  background: var(--panel);
  border-right: 1px solid var(--line);
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

/* 底部常驻：跟着侧边栏一起收起，但不受面板切换影响 */
.foot {
  flex: 0 0 auto;
  border-top: 1px solid var(--line);
  padding: 6px;
}
.gear {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 9px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dim);
  font-size: 12px;
  cursor: pointer;
}
.gear:hover {
  background: var(--hover);
  color: var(--fg);
}
.gear.on {
  background: var(--sel-bg);
  color: var(--sel-fg);
}
.gear :deep(svg) {
  width: 16px;
  height: 16px;
}

</style>
