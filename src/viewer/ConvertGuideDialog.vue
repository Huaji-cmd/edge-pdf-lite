<script setup lang="ts">
/**
 * 「转 PDF 后批注」说明框。
 *
 * ## 为什么要一个弹窗，而不是在工具栏上写一行字
 * Markdown 是只读的，**不能批注** —— 这是这一期最重要的产品边界。
 * 但用户真正的诉求是"我要在这段话上画线"，光说"不支持"是把问题丢回去。
 * 所以这里给出**能走通的路**：先用外部工具转成 PDF，再把 PDF 拖回来批注。
 *
 * ## 为什么不做内置转换
 * 内置转换要么引排版引擎（体积、中文字体、分页全是坑），要么调 WebView2 的打印
 * （分页/页边距不可控，还没法自动化验证）。这两条都会把"lite"吃掉。
 * 这一期只做**说明 + 路径辅助**，一次也不上传文件、不联网。
 */
import { ref } from 'vue'
import Icon from './Icon.vue'
import { revealInFolder } from './settings'

const props = defineProps<{
  fileName: string
  /** 真实路径（桌面端）。浏览器版是空串 —— 那时复制/打开文件夹都做不了 */
  filePath: string
}>()

const emit = defineEmits<{ close: []; toast: [msg: string] }>()

const copyState = ref<'idle' | 'ok' | 'no-response' | 'denied'>('idle')

/**
 * 复制路径。
 *
 * ⚠️ 同 `fileList.copyPath`：WebView2 里 `clipboard.writeText` 有可能
 *    **既不 resolve 也不 reject**（剪贴板被别的进程占着时实测三次全悬停）。
 *    所以给一个超时，并把"没回音"当成**一种独立结果**说出来 ——
 *    静默失败是这里最不能接受的表现（用户会以为复制成功了，去粘贴才发现是空的）。
 */
const COPY_TIMEOUT = 2000

async function copyPath(): Promise<void> {
  if (!props.filePath) {
    copyState.value = 'denied'
    return
  }
  try {
    copyState.value = await Promise.race([
      navigator.clipboard.writeText(props.filePath).then(() => 'ok' as const),
      new Promise<'no-response'>((r) => window.setTimeout(() => r('no-response'), COPY_TIMEOUT)),
    ])
  } catch {
    copyState.value = 'denied'
  }
}

async function openDir(): Promise<void> {
  if (!props.filePath) {
    emit('toast', '浏览器版没有真实路径，请在桌面版里操作')
    return
  }
  if (await revealInFolder(props.filePath)) emit('close')
  else emit('toast', `打不开：${props.filePath}`)
}
</script>

<template>
  <div class="scrim" data-tid="md-convert-dialog" @click.self="emit('close')">
    <div class="dlg" role="dialog" aria-modal="true" aria-labelledby="md-convert-title">
      <div class="head">
        <Icon name="file" />
        <h2 id="md-convert-title">想批注？先转成 PDF</h2>
      </div>

      <p class="lead">
        Markdown 在本应用里是<strong>只读</strong>的：能看、能缩放、能做目录跳转，
        但不能高亮、不能写字。要批注，需要先把
        <code>{{ fileName }}</code>
        转成 PDF，再把转出来的 PDF 拖回这里。
      </p>

      <div class="ways">
        <div class="way">
          <b>Typora</b>
          <span>文件 → 导出 → PDF</span>
        </div>
        <div class="way">
          <b>VS Code</b>
          <span>安装「Markdown PDF」扩展后右键导出</span>
        </div>
        <div class="way">
          <b>Pandoc</b>
          <span><code>pandoc in.md -o out.pdf</code></span>
        </div>
      </div>

      <div class="path">
        <span class="label">当前文件</span>
        <code class="val">{{ filePath || '（浏览器版没有真实路径）' }}</code>
      </div>

      <p v-if="copyState === 'ok'" class="ok">已复制路径</p>
      <p v-else-if="copyState === 'no-response'" class="warn">
        剪贴板没有回音（可能已经被占用）。多半其实复制上了，粘贴试一下
      </p>
      <p v-else-if="copyState === 'denied'" class="warn">这个环境不允许复制路径</p>

      <p class="foot-note">
        转换完全由你本机的工具完成 —— 本应用不上传、不联网、也不生成 PDF。
      </p>

      <div class="actions">
        <button class="btn" data-tid="md-convert-copy" @click="copyPath">
          <Icon name="file" /> 复制文件路径
        </button>
        <button class="btn" data-tid="md-convert-reveal" @click="openDir">
          <Icon name="folder-open" /> 打开所在文件夹
        </button>
        <button class="btn primary" data-tid="md-convert-close" @click="emit('close')">
          知道了
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
  width: min(560px, calc(100vw - 48px));
  max-height: calc(100vh - 80px);
  overflow: auto;
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
  margin: 0 0 12px;
  color: var(--fg-2);
}
.lead strong {
  color: var(--fg);
}

.ways {
  display: grid;
  gap: 6px;
  margin: 0 0 12px;
  padding: 10px 12px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 8px;
}
.way {
  display: flex;
  gap: 10px;
  align-items: baseline;
  font-size: 12.5px;
}
.way b {
  flex: 0 0 72px;
  color: var(--fg);
  font-weight: 600;
}
.way span {
  color: var(--dim);
}

.path {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 10px;
}
.label {
  font-size: 11.5px;
  color: var(--mute);
}
.val {
  display: block;
  padding: 6px 8px;
  background: var(--btn);
  border-radius: 6px;
  font-size: 11.5px;
  /* 路径可能很长：折行比横向滚动好读 */
  overflow-wrap: anywhere;
  color: var(--fg-2);
}

code {
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 0.94em;
}

.ok {
  margin: 0 0 8px;
  color: var(--ok);
  font-size: 12px;
}
.warn {
  margin: 0 0 8px;
  color: var(--warn);
  font-size: 12px;
}
.foot-note {
  margin: 0 0 14px;
  color: var(--mute);
  font-size: 11.5px;
}

.actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  flex-wrap: wrap;
}
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
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
.btn :deep(svg) {
  width: 14px;
  height: 14px;
}
</style>
