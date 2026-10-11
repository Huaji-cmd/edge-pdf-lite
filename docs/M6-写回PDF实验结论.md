---
title: M6 批注写回 PDF · 实验结论与铁律
aliases: [edge-pdf-lite M6, 批注写回, writer.ts 结论]
tags: [edge-pdf-lite, pdf, annotation, pdf-lib]
created: 2026-10-11
---

# M6 批注写回 PDF —— 结论与铁律

> 这是**结论索引**，不是教程。每条都对应一次实测（含翻车）。
> 复现路径：`npm run build && npm run serve:dist` → `npm run test:writer`（26 项断言）

## 一、一句话结论

`src/annot/writer.ts` 走 **pdf-lib 增量更新（`forIncrementalUpdate` + `commit()`）** 往页面的
`/Annots` 里追加注释对象，自己构造 `/AP` 外观流。**pdf.js 与 Edge(PDFium) 两个查看器都验证通过**，
包括高亮透字、手写、方框、下划线/删除线、ASCII 文本框。

## 二、必须这么写（写错在自家实现里往往看不出来）

| 项 | 正确写法 | 写错的后果 |
|---|---|---|
| **写回方式** | `PDFDocument.load(bytes, { forIncrementalUpdate: true })` → `commit()` | 全量重写：20–50MB 文件的峰值内存与耗时都翻几倍；失败时自动退回 `save()` |
| **挂注释** | `page.node.addAnnot(ref)` | 自己 `lookup('Annots') + push` 会漏掉「/Annots 是间接引用」的情况 |
| **`/AP` 的 Matrix** | **单位矩阵** `[1,0,0,1,0,0]`，内容用**注释空间坐标**（原点 = /Rect 左下角） | 自己用 Matrix 平移 → **双重偏移**（查看器还会做一次 bbox→Rect 映射）。实测 I3 变体：整条笔迹被推出画面，只剩一个小点 |
| **`/AP` 的 BBox** | `[0,0,w,h]`（w/h 来自 /Rect） | 尺寸不对 → 外观被裁 / 缩放错 |
| **`/Rect`** | 重算：高亮取 **QuadPoints 包围盒**、手写取**点位包围盒 + 线宽/2** | 写小了 → 部分查看器**按 Rect 裁剪 /AP**，高亮被截断 |
| **`/T` `/Contents` `/NM` `/M` `/DA`** | `PDFString.of()`（ASCII）/ `PDFHexString.fromText()`（非 ASCII） | 直接传 JS 字符串 → `obj()` 写成语义为「名字」的 `/xxx`；非 ASCII 走 `PDFString` → latin-1 截断成乱码 |
| **`InkList`** | **页面坐标**（default user space） | 写成相对 /Rect 的坐标 → 忽略 /AP 的查看器里整条错位 |
| **`QuadPoints` 顺序** | Z 序：左上 → 右上 → 左下 → 右下 | 逆时针序在部分查看器里错位（P3 实测） |
| **高亮 `/AP`** | **必须带 `ExtGState /BM /Multiply`** | 只填色块 → **把文字盖住**，高亮反而让内容不可读（下方截图对照） |
| **字体资源** | `/AP` 里用 `/Helv` 就必须给 `/Resources /Font`，且要用**真实的字体 ref**（`embedFont` 后拿 `.ref`） | 占位键改不到（`context.register()` 返回的是 PDFRef 不是 stream）→ 查看器解析 /AP 时找不到字体 |
| **字体按需嵌入** | 只有存在「ASCII 的文本框」时才 `embedFont` | 每个文件都白白多一个字体对象 |

## 三、Edge(PDFium) 对照实验（这一步不能省）

pdf.js 是 JS 实现，Edge 用的是 C++ PDFium —— **两套实现**。所以做了
`scripts/make-highlight-variants.mjs` 对照样本，用 `scripts/edge-pdf-shot.mjs`
在 Edge 内置查看器里逐页截图：

| 变体 | 写法 | Edge 里的表现 |
|---|---|---|
| V1 | `/AP` + `BM /Multiply` | ✅ **文字透出来**（我们的做法） |
| V2 | `/AP` 普通填充 | ❌ 实心色块，文字看不见 |
| V3 | 不给 `/AP` | ✅ 文字可见（查看器自己画，颜色略浅） |
| I1 | Ink + `/AP`（注释空间坐标） | ✅ 正确 |
| I2 | Ink 不给 `/AP` | ✅ 正确 |
| I3 | Ink + `/AP` 自己用 Matrix 平移 | ❌ 笔迹几乎完全跑出画面 |

**结论**：高亮的 Multiply 是「文字可读」的关键，且**两个查看器都吃这一套**；
`/AP` 必须给（否则颜色/线宽由查看器自由发挥，跨设备不一致）。

## 四、还没解决 / 已知限制

| 限制 | 说明 |
|---|---|
| **中文文本框** | `/AP` 里画不了中文（标准 14 字体无中文字形）→ 只画一个空框。文字本身在 `/Contents` 里没丢（注释面板/弹窗能看到）。要真画出来必须子集化嵌入 CJK 字体（pdf-lib 需要 fontkit，当前未引入） |
| **已有批注的擦除** | 打开别人写好的 PDF 时，文件里已有的注释只由 pdf.js 画出来、不进我们的 store，所以**擦不掉**（符合"只擦自己画的"，但要在 UI 上说明） |
| **大文件** | writer 跑在主线程，20–50MB 文件应该搬到 Web Worker（方案里已定，尚未做） |
| **脚本的局限** | `test-writer` 的 Edge 截图只能证明「PDFium 也画了」，最终仍建议人工在 Edge/Acrobat 里各看一遍 |

## 五、复现与命令

```bash
npm run testdata:annot          # 生成 9 条注释的对照样本
npm run build && npm run serve:dist
npm run test:writer             # 写回自检：17 项页面内断言 + 9 项端到端（真下载文件）
npm run test:annot              # 样本自检 12 项
npm run test:viewer             # 阅读器回归 43 项
npm run variants                # 生成高亮/手写对照样本 hl-variants.pdf
npm run edge:shot public/testdata/written.pdf 4   # Edge 内置查看器截图（PDFium 视角）
```

产物：`public/testdata/written.pdf`（写回结果）、`writer-shots/`（差分图 + 端到端下载件）、
`viewer-shots/edge-*.png`（Edge 视角截图）。

## 六、性能实测（样本 15.0 KB / 7 页，含对照组）

测法：同一份原文件、同一批 7 条批注，**增量与全量各跑两次取较小值**
（首次调用含解析器预热，实测首次 21ms → 复跑 8ms，不取首次）。

| 写法 | 耗时 | 体积 | 产物性质 |
|---|---|---|---|
| 增量（`forIncrementalUpdate` + `commit()`） | **≈8–18 ms** | 21.5 KB | 以原文件字节开头，**只追加** |
| 全量（`save({useObjectStreams:true})`） | **≈2–4 ms** | 14.8 KB | 整档重新序列化 + 对象流压缩 |

**结论（反直觉但实测如此）**：在**小文件**上，增量既**不比**全量快、也**不比**全量小。
增量真正的价值在**大文件**：产物是「原字节 + 追加」，不需要把整个文档重新序列化一遍，
峰值内存明显更低（20–50MB 的文件才会体现出来）。

⚠️ 上面是 15 KB 文件的数字，**不能外推**。要对外承诺性能之前，必须拿
《现代操作系统教程》那种量级的文件再测一轮（本次未测）。

