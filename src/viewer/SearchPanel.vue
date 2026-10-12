<script setup lang="ts">
/**
 * 「搜索」面板：在**文件名**里找。
 *
 * ⚠️ 只搜文件名，不做全文检索。原因：
 *    全文得把每个 PDF 都打开抽一遍文本建索引（几十 MB 的教材很慢），
 *    而且**扫描件根本没有文本层** —— 那类书永远搜不到内容，
 *    用户会以为"搜索坏了"。文件名搜索对所有 PDF 都有效，且是瞬时的。
 *    （PDF 内部的查找另有 Ctrl+F，那是另一回事，不受这里影响。）
 */
import { computed, ref } from 'vue'
import Icon from './Icon.vue'
import type { FileNode } from './fileList'

const props = defineProps<{
  nodes: readonly FileNode[]
  currentId: string | null
}>()

const emit = defineEmits<{
  open: [node: FileNode]
}>()

const q = ref('')

/** 拍平出所有文件，顺便记下它所在的路径（显示用） */
const allFiles = computed(() => {
  const out: Array<{ node: FileNode; dir: string }> = []
  const walk = (list: readonly FileNode[], dir: string): void => {
    for (const n of list) {
      if (n.kind === 'file') out.push({ node: n, dir })
      else if (n.children) walk(n.children, dir ? `${dir}/${n.name}` : n.name)
    }
  }
  walk(props.nodes, '')
  return out
})

const hits = computed(() => {
  const key = q.value.trim().toLowerCase()
  if (!key) return []
  return allFiles.value.filter((f) => f.node.name.toLowerCase().includes(key))
})

/**
 * 点搜索结果。
 * ⚠️ 别在这里判 `node.file` —— 桌面端的文件是**真实路径**，没有 File 对象，
 *    那样判断会让整个搜索结果在 exe 里点不动。
 */
function pick(node: FileNode): void {
  emit('open', node)
}
</script>

<template>
  <div class="search" data-tid="search-panel">
    <div class="box">
      <Icon name="search" class="ic-in" />
      <input
        v-model="q"
        data-tid="search-input"
        type="search"
        placeholder="搜索文件名…"
        spellcheck="false"
      />
    </div>

    <!-- 只留一句"按文件名搜"。原来还解释了为什么不搜正文 —— 那是设计理由，
         不是用户要读的信息（用户要求删）。 -->
    <p v-if="!q.trim()" class="tip">输入关键词，按文件名搜索。</p>

    <p v-else-if="!hits.length" class="tip">没有匹配的文件</p>

    <template v-else>
      <p class="count">{{ hits.length }} 个结果</p>
      <button
        v-for="h in hits"
        :key="h.node.id"
        class="hit"
        :class="{ cur: h.node.id === currentId }"
        :data-node-id="h.node.id"
        :title="h.node.name"
        @click="pick(h.node)"
      >
        <Icon name="file" class="leaf" />
        <span class="col">
          <span class="nm">{{ h.node.name }}</span>
          <span v-if="h.dir" class="dir">{{ h.dir }}</span>
        </span>
      </button>
    </template>
  </div>
</template>

<style scoped>
.search {
  flex: 1 1 auto;
  min-width: 0;
  overflow: auto;
  padding: 8px;
}

.box {
  position: relative;
  display: flex;
  align-items: center;
}
.ic-in {
  position: absolute;
  left: 8px;
  width: 14px;
  height: 14px;
  color: var(--mute);
  pointer-events: none;
}
.box input {
  width: 100%;
  height: 30px;
  padding: 0 8px 0 27px;
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: 5px;
  color: var(--fg);
  font: inherit;
  font-size: 12.5px;
}
.box input:focus {
  outline: none;
  border-color: var(--accent);
}

.tip {
  margin: 14px 4px;
  font-size: 11.5px;
  line-height: 1.8;
  color: var(--mute);
}

.count {
  margin: 10px 4px 6px;
  font-size: 11px;
  color: var(--mute);
}

.hit {
  width: 100%;
  display: flex;
  align-items: flex-start;
  gap: 7px;
  padding: 6px 7px;
  background: none;
  border: 0;
  border-radius: 5px;
  color: var(--fg);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.hit:hover {
  background: var(--btn);
}
.hit.cur {
  background: var(--sel-bg);
  color: var(--sel-fg);
}
.leaf {
  width: 14px;
  height: 14px;
  margin-top: 2px;
  flex: 0 0 14px;
  color: var(--dim-2);
}
.col {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.nm {
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dir {
  font-size: 10.5px;
  color: var(--mute);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
