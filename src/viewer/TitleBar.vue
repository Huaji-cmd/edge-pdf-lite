<script setup lang="ts">
/**
 * 自定义标题栏（无边框窗口用）。
 *
 * 只在打包成 exe（Tauri）时才完整显示：浏览器里没有"窗口"这个概念，
 * 最小化/最大化/关闭由浏览器自己管，我们再画一套只会让人困惑
 * （而且点了也没反应 —— 那是比不做更糟的体验）。
 *
 * ⚠️ `-webkit-app-region: drag` 让这一整条能拖动窗口，但**按钮必须
 *    no-drag**，否则点了按钮还会顺带拖窗口。这是 Tauri 专有 CSS，
 *    在浏览器里被忽略，所以不用做条件判断。
 */
import { computed } from 'vue'
import Icon from './Icon.vue'
import { IS_TAURI } from '@/platform'
import type { SidePanelKind } from './types'

const props = defineProps<{
  fileName: string
  sideOpen: boolean
  panel: SidePanelKind | null
  /** 窗口是否最大化（决定显示「最大化」还是「还原」图标） */
  maximized?: boolean
}>()

const emit = defineEmits<{
  'toggle-side': []
  'set-panel': [panel: SidePanelKind]
  win: [action: 'min' | 'max' | 'close']
}>()

/** 左部 5 个面板入口。顺序即屏幕上的顺序（与原型一致） */
const ENTRIES = [
  { kind: 'files' as const, icon: 'file' as const, tip: '文件列表', tid: 'side-file' },
  { kind: 'search' as const, icon: 'search' as const, tip: '搜索文件（只匹配文件名）', tid: 'side-search' },
  { kind: 'outline' as const, icon: 'list' as const, tip: '目录（PDF 书签）', tid: 'side-outline' },
  { kind: 'thumbs' as const, icon: 'grid' as const, tip: '缩略图（每页小图）', tid: 'side-thumbs' },
]

const title = computed(() =>
  props.fileName ? `${props.fileName} — edge-pdf-lite` : 'edge-pdf-lite',
)

/** 只有「侧边栏开着且正是这个面板」时图标才点亮 */
function isOn(kind: SidePanelKind): boolean {
  return props.sideOpen && props.panel === kind
}
</script>

<template>
  <div class="titlebar">
    <div class="group left">
      <button
        class="tb"
        :class="{ on: sideOpen }"
        data-tid="sidebar-toggle"
        title="打开 / 收起左侧边栏"
        @click="emit('toggle-side')"
      >
        <Icon name="sidebar" />
      </button>

      <button
        v-for="e in ENTRIES"
        :key="e.kind"
        class="tb"
        :class="{ on: isOn(e.kind) }"
        :data-tid="e.tid"
        :title="e.tip"
        @click="emit('set-panel', e.kind)"
      >
        <Icon :name="e.icon" />
      </button>
    </div>

    <div class="title" data-tid="file-name">{{ title }}</div>

    <!-- 窗口控制：只有打包成 exe 才有意义，浏览器里整组隐藏 -->
    <div v-if="IS_TAURI" class="group right">
      <button class="tb win" data-tid="win-min" title="最小化" @click="emit('win', 'min')">
        <Icon name="min" />
      </button>
      <button class="tb win" data-tid="win-max" :title="maximized ? '还原' : '最大化'" @click="emit('win', 'max')">
        <Icon :name="maximized ? 'restore' : 'max'" />
      </button>
      <button class="tb win close" data-tid="win-close" title="关闭" @click="emit('win', 'close')">
        <Icon name="close" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.titlebar {
  flex: 0 0 38px;
  height: 38px;
  display: flex;
  align-items: center;
  background: #14161b;
  border-bottom: 1px solid #2e333d;
  user-select: none;
  -webkit-app-region: drag;
}

.group {
  display: flex;
  align-items: center;
  gap: 2px;
  /* ⚠️ 按钮区域不能参与拖窗口，否则点击会带上拖动 */
  -webkit-app-region: no-drag;
}
.group.left {
  padding-left: 4px;
}
.group.right {
  margin-left: auto;
}

.title {
  flex: 1 1 auto;
  min-width: 0;
  text-align: center;
  font-size: 12px;
  color: #9aa3b2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 0 12px;
}

.tb {
  height: 30px;
  min-width: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 7px;
  background: transparent;
  color: #9aa3b2;
  border: 0;
  border-radius: 5px;
  cursor: pointer;
}
.tb:hover {
  background: #262b33;
  color: #e6e8ec;
}
.tb.on {
  background: #2b3d57;
  color: #9ecbff;
}

.tb.win {
  height: 38px;
  min-width: 44px;
  border-radius: 0;
}
.tb.win.close:hover {
  background: #c0392b;
  color: #fff;
}
</style>
