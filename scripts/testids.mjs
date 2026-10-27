/**
 * 界面控件的稳定标识。
 *
 * ⚠️ 测试**只认这里**，绝不认按钮文字。
 *
 * 原因：按钮文字会随 UI 改版而变 —— 这次把工具栏图标化之后，按钮上的
 * 「高亮」「手写」这些字全没了，靠 `textContent` 找按钮的测试会**静默失效**
 * （找不到就返回 false，看起来像"功能坏了"而不是"选择器错了"）。
 *
 * 约定：
 * - 每个可点控件在模板里带 `data-tid="…"`，值取自下面的 TID
 * - 新增控件时在这里加一项；改名要同步改所有用到它的测试
 */

export const TID = {
  // 顶栏（新界面）
  open: 'open',
  sidebarToggle: 'sidebar-toggle',
  sideFile: 'side-file',
  sideSearch: 'side-search',
  sideOutline: 'side-outline',
  sideThumbs: 'side-thumbs',
  // 侧边栏底部的设置入口
  sideSettings: 'side-settings',
  // 设置面板
  saveModeCopy: 'save-mode-copy',
  saveModeOverwrite: 'save-mode-overwrite',
  saveChangeDir: 'save-change-dir',
  saveOpenDir: 'save-open-dir',
  themeSystem: 'theme-system',
  themeLight: 'theme-light',
  themeDark: 'theme-dark',
  toastOpenDir: 'toast-open-dir',
  winMin: 'win-min',
  winMax: 'win-max',
  winClose: 'win-close',

  // 阅读导航
  prev: 'prev',
  next: 'next',
  pageInput: 'page-input',
  zoomOut: 'zoom-out',
  zoomIn: 'zoom-in',
  fitWidth: 'fit-width',
  fitPage: 'fit-page',

  // 视图
  modeSingle: 'mode-single',
  modeDual: 'mode-dual',
  spreadOffset: 'spread-offset',

  // 指针模式
  pmSelect: 'pm-select',
  pmScroll: 'pm-scroll',
  pmPan: 'pm-pan',

  // 批注
  annotToggle: 'annot-toggle',
  colorCaret: 'color-caret',
  toolHighlight: 'tool-highlight',
  toolUnderline: 'tool-underline',
  toolStrikeout: 'tool-strikeout',
  toolInk: 'tool-ink',
  toolArea: 'tool-area',
  toolRect: 'tool-rect',
  toolFreetext: 'tool-freetext',
  toolEraser: 'tool-eraser',
  // 手写笔尖粗细（三档；**只在手写工具激活时**才出现在 DOM 里）
  inkWidthThin: 'ink-width-0',
  inkWidthMid: 'ink-width-1',
  inkWidthThick: 'ink-width-2',

  // 历史与保存
  undo: 'undo',
  redo: 'redo',
  deleteSelected: 'delete-selected',
  unsaved: 'unsaved',
  save: 'save',
}

/**
 * 旧按钮文字 → 新 tid。
 * 过渡期用：测试脚本还写着 `toolbarBtn('高亮')`，先按这张表翻译成 tid；
 * 找不到 tid 时再回退到按文字找，所以**改 UI 前后这套测试都能跑**。
 */
export const LABEL_TO_TID = {
  保存批注: TID.save,
  区域高亮: TID.toolArea,
  单页: TID.modeSingle,
  双页: TID.modeDual,
  手写: TID.toolInk,
  拖动: TID.pmPan,
  擦除: TID.toolEraser,
  文字: TID.toolFreetext,
  滚动: TID.pmScroll,
  目录: TID.sideOutline,
  文件: TID.sideFile,
  // 设置入口在**侧边栏底部**（左下角齿轮），不在顶栏
  设置: TID.sideSettings,
  搜索: TID.sideSearch,
  // ⚠️ 「目录」在新界面里是**切到目录面板**，不再负责收起侧边栏
  //    （收起是顶栏最左边那个开关图标）。要收起用下面这个。
  侧边栏: TID.sidebarToggle,
  选择: TID.pmSelect,
  高亮: TID.toolHighlight,
  // 「批注」是右侧那个开合按钮（点开才露出 8 个工具）
  批注: TID.annotToggle,
  缩略图: TID.sideThumbs,
  下划线: TID.toolUnderline,
  删除线: TID.toolStrikeout,
  方框: TID.toolRect,
  文本框: TID.toolFreetext,
  撤销: TID.undo,
  重做: TID.redo,
  适宽: TID.fitWidth,
  整页: TID.fitPage,
  打开: TID.open,
}

/** 生成按 tid 查找并点击的表达式（给 CDP evaluate 用） */
export function clickByTidExpr(label) {
  const tid = LABEL_TO_TID[label] ?? ''
  return `(() => {
    const tid = ${JSON.stringify(tid)};
    let b = tid ? document.querySelector('[data-tid="' + tid + '"]') : null;
    if (!b) {
      b = [...document.querySelectorAll('.toolbar .btn, [data-tid]')]
        .find(x => x.textContent.trim() === ${JSON.stringify(label)});
    }
    if (!b) return false;
    b.click();
    return true;
  })()`
}
