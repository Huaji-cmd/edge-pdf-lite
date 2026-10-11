<script setup lang="ts">
/**
 * 单个书签条目（**递归组件** —— 它自己渲染自己的子项）。
 *
 * 为什么要单独抽一个"单节点"组件而不是在父组件里递归 v-for：
 * 折叠状态天然是每个节点自己的局部状态，抽出来就不用在父组件维护一整套
 * "哪些展开了"的 Map。
 */
import { ref } from 'vue'
import type { OutlineNode } from './outline'

const props = defineProps<{
  node: OutlineNode
  currentPage: number
  /** 层级深于此的**默认收起**，避免一打开就是几百行 */
  autoCollapseBelow: number
}>()

const emit = defineEmits<{ go: [pageNumber: number, destTop: number | null] }>()

const open = ref(props.node.level < props.autoCollapseBelow)
</script>

<template>
  <li class="oi">
    <div class="row" :class="{ current: node.pageNumber !== null && node.pageNumber === currentPage }">
      <button
        v-if="node.children.length"
        class="twisty"
        :aria-label="open ? '收起' : '展开'"
        @click="open = !open"
      >
        {{ open ? '▾' : '▸' }}
      </button>
      <span v-else class="twisty placeholder" />

      <button
        class="title"
        :disabled="node.pageNumber === null"
        :title="
          node.pageNumber === null
            ? '这条没有可跳转的目标（通常只是章节分组）'
            : `跳到第 ${node.pageNumber} 页`
        "
        @click="node.pageNumber !== null && emit('go', node.pageNumber, node.destTop)"
      >
        {{ node.title }}
      </button>
    </div>

    <ul v-if="open && node.children.length" class="kids">
      <OutlineItem
        v-for="(kid, i) in node.children"
        :key="i"
        :node="kid"
        :current-page="currentPage"
        :auto-collapse-below="autoCollapseBelow"
        @go="(p, t) => emit('go', p, t)"
      />
    </ul>
  </li>
</template>

<style scoped>
.oi {
  list-style: none;
}

.row {
  display: flex;
  align-items: flex-start;
  gap: 2px;
  border-radius: 4px;
}

.row:hover {
  background: #262b33;
}

.row.current {
  background: #2b3d57;
}

.twisty {
  flex: 0 0 auto;
  width: 16px;
  height: 20px;
  padding: 0;
  border: 0;
  background: none;
  color: #8b93a1;
  font-size: 11px;
  line-height: 20px;
  cursor: pointer;
}
.twisty.placeholder {
  cursor: default;
}

.title {
  flex: 1 1 auto;
  min-width: 0;
  display: block;
  padding: 2px 4px;
  border: 0;
  background: none;
  color: #d7dce4;
  font: inherit;
  font-size: 12.5px;
  line-height: 1.45;
  text-align: left;
  cursor: pointer;
  /* 长标题不换行 —— 目录是拿来扫的，行高一致才好扫 */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.title:disabled {
  color: #7a828f;
  cursor: default;
}
.row.current .title {
  color: #cfe4ff;
  font-weight: 600;
}

.kids {
  margin: 0;
  padding: 0 0 0 12px;
  list-style: none;
}
</style>
