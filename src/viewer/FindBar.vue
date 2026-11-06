<script setup lang="ts">
/**
 * 页内查找条 —— Markdown 与 PDF **共用**的 UI。
 *
 * 只管"输入 + 计数 + 上/下/关闭"这套交互外壳；怎么搜、怎么画高亮是各阅读器
 * 自己的事（Markdown 用 CSS Custom Highlight API，PDF 在文本层包 <mark>）——
 * 两边的差异全在引擎里，UI 不允许漂移（样式/快捷键/占位文案都收在这里）。
 *
 * 键盘：Enter 下一个、Shift+Enter 上一个、Esc 关闭（输入框自己吃掉，
 * 不漏给全局快捷键）。
 */
import { nextTick, ref, watch } from 'vue'
import Icon from './Icon.vue'

const props = defineProps<{
  /** v-model:query —— 查询词 */
  query: string
  /** 计数文案（如 "3 / 20" 或 "无匹配"；空串 = 还没输入） */
  count: string
  /** tid 前缀（'md' / 'pdf'），测试判据靠它分流 */
  scope: 'md' | 'pdf'
  /** 搜索中（PDF 全文搜有进度；true 时计数位显示"搜索中…"） */
  searching?: boolean
}>()

const emit = defineEmits<{
  'update:query': [value: string]
  next: []
  prev: []
  close: []
}>()

const input = ref<HTMLInputElement | null>(null)

/** 打开时聚焦并全选（方便直接覆盖输入） */
async function focus(): Promise<void> {
  await nextTick()
  input.value?.focus()
  input.value?.select()
}
defineExpose({ focus })

/** 上一个/下一个由 Enter 触发，Shift 反向 —— 与浏览器习惯一致 */
function onEnter(e: KeyboardEvent): void {
  if (e.shiftKey) emit('prev')
  else emit('next')
}

watch(
  () => props.query,
  (v) => {
    if (v === '') emit('update:query', '')
  },
)
</script>

<template>
  <div class="findbar" :data-tid="`${scope}-find`">
    <input
      ref="input"
      :value="query"
      class="find-input"
      :data-tid="`${scope}-find-input`"
      type="text"
      placeholder="在本文中查找"
      spellcheck="false"
      autocomplete="off"
      @input="emit('update:query', ($event.target as HTMLInputElement).value)"
      @keydown.enter.prevent="onEnter"
      @keydown.esc.prevent.stop="emit('close')"
    />
    <span class="find-count" :data-tid="`${scope}-find-count`">
      {{ searching ? '搜索中…' : (query.trim() ? (count || '无匹配') : '') }}
    </span>
    <button
      class="find-btn"
      :data-tid="`${scope}-find-prev`"
      :disabled="!count"
      title="上一个 (Shift+Enter)"
      @click="emit('prev')"
    >
      <Icon name="prev" />
    </button>
    <button
      class="find-btn"
      :data-tid="`${scope}-find-next`"
      :disabled="!count"
      title="下一个 (Enter)"
      @click="emit('next')"
    >
      <Icon name="next" />
    </button>
    <button class="find-btn" :data-tid="`${scope}-find-close`" title="关闭 (Esc)" @click="emit('close')">
      <Icon name="close" />
    </button>
  </div>
</template>

<!--
  ⚠️ 样式曾经是 MarkdownViewer 的 scoped 样式，抽组件时一起搬过来。
  两边类名一致（findbar/find-input/…），测试与视觉都零漂移。
-->
<style scoped>
.findbar {
  position: absolute;
  top: 10px;
  right: 18px;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px;
  background: var(--surface-2);
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  box-shadow: 0 6px 20px var(--shadow);
}

.find-input {
  width: 180px;
  height: 26px;
  padding: 0 8px;
  background: var(--btn);
  color: var(--fg);
  border: 1px solid var(--line-strong);
  border-radius: 5px;
  font: inherit;
  font-size: 12.5px;
  outline: none;
}
.find-input:focus {
  border-color: var(--accent-solid);
}
.find-input::placeholder {
  color: var(--mute);
}

.find-count {
  min-width: 54px;
  text-align: center;
  font-size: 11.5px;
  color: var(--dim);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.find-btn {
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  background: transparent;
  color: var(--dim);
  border: 0;
  border-radius: 5px;
  cursor: pointer;
}
.find-btn:hover:not(:disabled) {
  background: var(--btn-hover);
  color: var(--fg);
}
.find-btn:disabled {
  opacity: 0.35;
  cursor: default;
}
.find-btn :deep(svg) {
  width: 15px;
  height: 15px;
}
</style>
