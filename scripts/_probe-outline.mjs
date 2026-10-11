/** 一次性探针：现有测试样本里到底有没有 /Outlines（PDF 书签） */
import { readFile } from 'node:fs/promises'
import { PDFDocument, PDFName } from '@cantoo/pdf-lib'

const files = ['real-1706.03762.pdf', 'scan-like.pdf', 'annot-fixture.pdf', 'hl-variants.pdf']
for (const f of files) {
  try {
    const b = await readFile(`public/testdata/${f}`)
    const pdf = await PDFDocument.load(b)
    const o = pdf.catalog.get(PDFName.of('Outlines'))
    console.log(`${f.padEnd(24)} ${o ? '✅ 有 outline' : '❌ 无 outline'}`)
  } catch (e) {
    console.log(`${f.padEnd(24)} ERR ${String(e.message).slice(0, 60)}`)
  }
}
