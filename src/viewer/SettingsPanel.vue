<script setup lang="ts">
/**
 * 设置面板：保存方式 / 保存位置 / 主题。
 *
 * 两条硬约束：
 *
 * 1. **网页版能改的只有主题。** 保存路径和"覆盖原文件"都需要真实文件系统，
 *    浏览器里做不到 —— 这类选项要**禁用并写清原因**，而不是让它点了没反应。
 *    "为什么这个不能选"必须当场可见，否则用户只会以为程序坏了。
 *
 * 2. **保存位置要显示实际生效的路径。** 用户提的第一个问题就是"我存到哪去了"，
 *    所以这里永远显示一个真实路径（没指定就显示默认目录），
 *    并且旁边给「打开文件夹」按钮 —— 看见了还能直接跳过去。
 */
import { onMounted, ref, watch } from 'vue'
import Icon from './Icon.vue'
import { IS_TAURI } from '@/platform'
import { pickSaveDir, revealInFolder, resolveSaveDir, settings, setTheme } from './settings'
import type { SaveMode, ThemeMode } from './settings'

const emit = defineEmits<{
  /** 让上层弹提示（保存位置改动这类反馈统一走 toast） */
  toast: [msg: string]
}>()

/** 实际会用到的保存目录（没指定就显示默认目录） */
const effectiveDir = ref('')

async function refreshDir(): Promise<void> {
  effectiveDir.value = await resolveSaveDir()
}

onMounted(refreshDir)
// 用户在别处（比如第一次保存时）改了设置，这里要跟着显示
watch(() => settings.value.saveDir, refreshDir)

async function changeDir(): Promise<void> {
  const picked = await pickSaveDir()
  if (!picked) return
  settings.value = { ...settings.value, saveDir: picked }
  effectiveDir.value = picked
  emit('toast', `保存位置已改为 ${picked}`)
}

async function openDir(): Promise<void> {
  const dir = effectiveDir.value || (await resolveSaveDir())
  if (!dir) {
    emit('toast', '网页版没有"文件夹"这个概念，文件会进浏览器的下载目录')
    return
  }
  if (!(await revealInFolder(dir))) emit('toast', `打不开：${dir}`)
}

function setSaveMode(m: SaveMode): void {
  settings.value = { ...settings.value, saveMode: m }
}

const THEMES: { mode: ThemeMode; icon: 'auto' | 'sun' | 'moon'; label: string }[] = [
  { mode: 'system', icon: 'auto', label: '跟随系统' },
  { mode: 'light', icon: 'sun', label: '日间' },
  { mode: 'dark', icon: 'moon', label: '夜间' },
]
</script>

<template>
  <div class="settings">
    <section>
      <h3>保存</h3>

      <label class="opt" :class="{ disabled: !IS_TAURI && false }">
        <input
          type="radio"
          name="savemode"
          data-tid="save-mode-copy"
          :checked="settings.saveMode === 'copy'"
          @change="setSaveMode('copy')"
        />
        <span class="opt-body">
          <span class="opt-title">另存一份</span>
          <span class="opt-desc">原文件不动，带批注的副本存到下面的目录</span>
        </span>
      </label>

      <label class="opt" :class="{ disabled: !IS_TAURI }">
        <input
          type="radio"
          name="savemode"
          data-tid="save-mode-overwrite"
          :checked="settings.saveMode === 'overwrite'"
          :disabled="!IS_TAURI"
          @change="setSaveMode('overwrite')"
        />
        <span class="opt-body">
          <span class="opt-title">
            直接覆盖原文件
            <span v-if="IS_TAURI" class="tag">会自动留一份 .bak</span>
          </span>
          <span class="opt-desc">
            {{ IS_TAURI ? '省事，但原文件会被替换' : '网页版改不了原文件，只能用「另存一份」' }}
          </span>
        </span>
      </label>

      <div class="dir">
        <div class="dir-label">
          保存位置
          <button
            v-if="IS_TAURI"
            class="mini"
            data-tid="save-open-dir"
            title="在文件管理器里打开这个目录"
            @click="openDir"
          >
            <Icon name="folder-open" /> 打开文件夹
          </button>
        </div>
        <div class="dir-row">
          <div class="dir-path" :title="effectiveDir">{{ effectiveDir || '（浏览器的下载目录）' }}</div>
          <button
            v-if="IS_TAURI"
            class="mini"
            data-tid="save-change-dir"
            title="换一个目录"
            @click="changeDir"
          >
            更改…
          </button>
        </div>
        <p v-if="!IS_TAURI" class="note">
          网页版只能下载到浏览器的默认下载目录，换不了位置。
        </p>
      </div>
    </section>

    <section>
      <h3>外观</h3>
      <div class="theme-row">
        <button
          v-for="t in THEMES"
          :key="t.mode"
          class="theme"
          :class="{ on: settings.theme === t.mode }"
          :data-tid="`theme-${t.mode}`"
          @click="setTheme(t.mode)"
        >
          <Icon :name="t.icon" />
          <span>{{ t.label }}</span>
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.settings {
  padding: 12px 12px 24px;
}

h3 {
  margin: 14px 0 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--dim);
  letter-spacing: 0.04em;
}
h3:first-child {
  margin-top: 0;
}

section + section {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--line);
}

/* ---- 单选 ---- */
.opt {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 8px;
  border-radius: 8px;
  cursor: pointer;
}
.opt:hover {
  background: var(--hover);
}
.opt.disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.opt input {
  margin-top: 3px;
  accent-color: var(--accent-solid);
}
.opt-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.opt-title {
  color: var(--fg);
  font-size: 13px;
}
.opt-desc {
  color: var(--mute);
  font-size: 11px;
  line-height: 1.5;
}
.tag {
  margin-left: 4px;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--sel-bg);
  color: var(--sel-fg);
  font-size: 10px;
}

/* ---- 目录 ---- */
.dir {
  margin-top: 10px;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface-2);
}
.dir-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  color: var(--dim);
  margin-bottom: 6px;
}
.dir-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.dir-path {
  flex: 1 1 auto;
  min-width: 0;
  padding: 5px 7px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--bg);
  color: var(--fg);
  font-size: 11px;
  /* 路径很长，从右边开始看才有意义（文件名在哪） */
  direction: ltr;
  overflow-x: auto;
  white-space: nowrap;
  scrollbar-width: thin;
}
.note {
  margin: 8px 0 0;
  color: var(--mute);
  font-size: 11px;
}

.mini {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: 0 0 auto;
  padding: 5px 9px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--btn);
  color: var(--fg-2);
  font-size: 11px;
  cursor: pointer;
}
.mini:hover {
  background: var(--btn-hover);
  color: var(--fg);
}
.mini :deep(svg) {
  width: 13px;
  height: 13px;
}

/* ---- 主题 ---- */
.theme-row {
  display: flex;
  gap: 6px;
}
.theme {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  padding: 9px 4px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--btn);
  color: var(--dim);
  font-size: 11px;
  cursor: pointer;
}
.theme:hover {
  background: var(--btn-hover);
}
.theme.on {
  background: var(--sel-bg);
  border-color: var(--accent);
  color: var(--sel-fg);
}
.theme :deep(svg) {
  width: 18px;
  height: 18px;
}
</style>
