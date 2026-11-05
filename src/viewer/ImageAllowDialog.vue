<script setup lang="ts">
/**
 * 「允许显示笔记外的图片」确认框（桌面端，File System Access 那套在浏览器端）。
 *
 * ## 这是安全模型的一部分，不是普通的确认框
 * 绝对路径图片的路径来自**笔记内容**（不可信输入），所以放行必须让用户：
 *   ① **亲眼看到完整路径清单**（所以列表不省略、不截断，超出滚动）；
 *   ② 亲手点"允许" —— Rust 侧只登记列表里的**这些文件**（精确匹配，不放开目录）；
 *   ③ 知道这是**仅本次运行有效**的（文案明说，重启即清空）。
 *
 * 为什么不做成"勾选框 + 永远记住"：记住 = 把笔记内容决定的路径持久化进白名单，
 * 等于绕过了"白名单只能由用户亲手选择的东西组成"这条设计。想长期用，
 * 正路是把图片挪进笔记文件夹用相对路径（文案里给出这个出路）。
 */
import { computed } from 'vue'
import Icon from './Icon.vue'

const props = defineProps<{
  fileName: string
  /** 将要授权的图片完整路径（来自笔记内容） */
  paths: string[]
}>()

const emit = defineEmits<{ allow: []; cancel: [] }>()

/** 折叠长清单：超过 8 条只展示前 8 条 + "等 N 张" —— 完整列表仍可滚动查看 */
const shown = computed(() => props.paths.slice(0, 8))
const rest = computed(() => props.paths.length - shown.value.length)
</script>

<template>
  <div class="scrim" data-tid="md-allow-dialog" @click.self="emit('cancel')">
    <div class="dlg" role="dialog" aria-modal="true" aria-labelledby="md-allow-title">
      <div class="head">
        <Icon name="file" />
        <h2 id="md-allow-title">这篇笔记引用了笔记文件夹之外的图片</h2>
      </div>

      <p class="lead">
        <code>{{ fileName }}</code>
        里引用了 <strong>{{ paths.length }}</strong> 张不在笔记文件夹里的图片
        （路径来自笔记内容，列在下面）。显示它们需要你逐条确认：
      </p>

      <div class="list" tabindex="0">
        <code v-for="p in shown" :key="p" class="path">{{ p }}</code>
        <p v-if="rest > 0" class="more">…还有 {{ rest }} 张（滚动查看全部）</p>
      </div>

      <p class="note">
        点「允许」后，<b>只允许显示清单里这些图片文件</b>，不放开任何文件夹；
        授权<b>仅本次运行有效</b>，重启后要重新确认。
        想一劳永逸：把图片挪进笔记文件夹、改成相对路径引用，就不需要再授权。
      </p>

      <p class="note warn">⚠️ 只认识你自己信任的来源生成的笔记 —— 别随手允许来路不明的 .md。</p>

      <div class="actions">
        <button class="btn" data-tid="md-allow-no" @click="emit('cancel')">不允许</button>
        <button class="btn primary" data-tid="md-allow-yes" @click="emit('allow')">
          允许显示（{{ paths.length }} 张）
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--scrim);
}

.dlg {
  width: min(600px, calc(100vw - 48px));
  max-height: calc(100vh - 80px);
  display: flex;
  flex-direction: column;
  padding: 18px 20px 16px;
  background: var(--surface-2);
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  box-shadow: 0 18px 48px var(--shadow-lg);
  color: var(--fg);
  font-size: 13px;
  line-height: 1.7;
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.head h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}
.head :deep(svg) {
  width: 18px;
  height: 18px;
  color: var(--accent);
}

.lead {
  margin: 0 0 10px;
  color: var(--fg-2);
}
.lead strong {
  color: var(--fg);
}

.list {
  margin: 0 0 10px;
  padding: 8px 10px;
  max-height: 180px;
  overflow: auto;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 8px;
}
.path {
  display: block;
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 11.5px;
  color: var(--fg-2);
  overflow-wrap: anywhere;
  padding: 1px 0;
}
.more {
  margin: 4px 0 0;
  font-size: 11.5px;
  color: var(--mute);
}

.note {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--dim);
}
.note b {
  color: var(--fg-2);
}
.note.warn {
  color: var(--warn);
  font-size: 11.5px;
}

.actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 6px;
}
.btn {
  padding: 6px 14px;
  background: var(--btn);
  color: var(--fg);
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}
.btn:hover {
  background: var(--btn-hover);
}
.btn.primary {
  background: var(--accent-solid);
  border-color: var(--accent-solid);
  color: var(--on-accent);
}
.btn.primary:hover {
  background: var(--accent-solid-hover);
}

code {
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 0.94em;
}
</style>
