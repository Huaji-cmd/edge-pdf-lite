<script setup lang="ts">
/**
 * Markdown 的「目录」面板 —— 标题大纲。
 *
 * ⚠️ 与 PDF 的 `OutlinePanel` **不是同一套东西**，所以没有复用：
 *    PDF 的节点带着页码和页内纵坐标（`page` + `destTop`），跳转是"到第 N 页的某个位置"；
 *    这里只有标题 id，跳转是"在同一个滚动容器里滚到某个元素"。
 *    硬把两者塞进一个组件，最后一定会在某一侧留下"看起来能用、其实跳错"的分支。
 *
 * ⚠️ 空状态要写清原因：Markdown 可以**一个标题都没有**（纯流水笔记）。
 *    那时候不是功能坏了 —— 告诉用户"用标题（#）才会有目录"。
 */
import type { MdHeading } from './markdownDocument'

defineProps<{
  headings: readonly MdHeading[]
  /** 当前所在标题（滚动时高亮） */
  activeId: string | null
}>()

const emit = defineEmits<{ go: [id: string] }>()
</script>

<template>
  <div class="md-outline" data-tid="md-outline">
    <div v-if="!headings.length" class="empty">
      <p>这份 Markdown 没有标题</p>
      <p class="dim">
        用 <code># 标题</code> 写出来的行才会进目录。<br />
        没有标题也能正常阅读和缩放。
      </p>
    </div>

    <ul v-else class="root">
      <li v-for="h in headings" :key="h.id">
        <button
          class="item"
          :class="{ on: h.id === activeId }"
          :style="{ paddingLeft: `${8 + (h.level - 1) * 12}px` }"
          :data-heading-id="h.id"
          :title="h.text"
          @click="emit('go', h.id)"
        >
          <span class="txt">{{ h.text || '（无标题文字）' }}</span>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.md-outline {
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

.item {
  display: flex;
  width: 100%;
  padding: 5px 8px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--fg-2);
  font: inherit;
  font-size: 12.5px;
  line-height: 1.45;
  text-align: left;
  cursor: pointer;
}
.item:hover {
  background: var(--hover);
  color: var(--fg);
}
.item.on {
  background: var(--sel-bg);
  color: var(--sel-fg);
}
.txt {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
.empty code {
  background: var(--btn);
  border-radius: 3px;
  padding: 0 3px;
  font-size: 11.5px;
}
.dim {
  color: var(--dim-2);
  font-size: 12px;
}
</style>
