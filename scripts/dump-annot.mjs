/**
 * 一次性排查工具：在 Node 里 dump pdf.js 读到的注释对象全部字段。
 *
 * 起因：`annot-check` 断言「getAnnotations().id === /NM」失败，
 * 实际拿到的是对象引用（`8R`）。需要看清 /NM 到底有没有被暴露、
 * 以及有没有别的字段可以拿来识别「这条批注是我写的」。
 *
 * 用法：node scripts/dump-annot.mjs [页码范围]
 */
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')

const data = new Uint8Array(await readFile(join(ROOT, 'public/testdata/annot-fixture.pdf')))
const task = pdfjs.getDocument({ data, useSystemFonts: false, standardFontDataUrl: undefined })
const doc = await task.promise

for (const p of [1, 4, 5, 6]) {
  const page = await doc.getPage(p)
  const annots = await page.getAnnotations()
  for (const a of annots) {
    console.log(`\n===== P${p}  ${a.subtype} =====`)
    // 只需要这几项就够下判断了
    console.log('  id           :', JSON.stringify(a.id))
    console.log('  titleObj     :', JSON.stringify(a.titleObj))
    console.log('  contentsObj  :', JSON.stringify(a.contentsObj))
    console.log('  color        :', JSON.stringify(a.color))
    console.log('  hasAppearance:', a.hasAppearance)
    console.log('  opacity      :', a.opacity)
    console.log('  quadPoints   :', Array.isArray(a.quadPoints) || a.quadPoints ? JSON.stringify(a.quadPoints).slice(0, 160) : '—')
    console.log('  inkLists     :', a.inkLists ? JSON.stringify(a.inkLists).slice(0, 200) : '—')
    console.log('  textContent  :', a.textContent ? JSON.stringify(a.textContent).slice(0, 120) : '—')
  }
}

await task.destroy()
