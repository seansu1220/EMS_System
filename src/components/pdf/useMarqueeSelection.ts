/**
 * 頁面清單的框選（v1.31）：在清單空白處按住滑鼠拖曳拉出一個框，框到的頁就勾選起來。
 * 按著 Ctrl／Shift 開始拉框＝加選（保留原本的勾選）；只點一下空白處＝取消全部勾選。
 * 只處理滑鼠（觸控在清單上滑動是捲動）。從縮圖或勾選框上開始的拖曳交給排序／勾選，不在這裡處理；
 * 卡片的邊框、頁碼文字等其他地方可以起手拉框（v1.31.1：空隙太窄很難點中）。
 * 框的座標以清單內容為準（含捲動量），拉到上下緣會自動捲動。
 */
import { useRef, useState, type PointerEvent } from 'react';
import { PDF_WORKSPACE_CONFIG } from '../../config/pdfTools';
import { boxesOverlap, type LayoutBox } from '../../lib/pdfWorkspace';

const CARD_SELECTOR = '[data-ws=page-card]';
/** 按在這些元素上不起手拉框：縮圖（拖曳排序、點開大圖）、勾選框。 */
const NO_MARQUEE_SELECTOR = `${CARD_SELECTOR} button, ${CARD_SELECTOR} input`;

interface MarqueeDrag {
  startX: number;
  startY: number;
  /** 開始拉框時要保留的勾選（加選時＝原本的勾選，否則空）。 */
  baseIds: string[];
  moved: boolean;
  /** 從卡片上（非縮圖處）起手：只點一下不取消勾選。 */
  startedOnCard: boolean;
}

/** 滑鼠位置 → 清單內容座標（含捲動量）。 */
function toContentPoint(list: HTMLElement, event: PointerEvent<HTMLElement>) {
  const rect = list.getBoundingClientRect();
  return { x: event.clientX - rect.left + list.scrollLeft, y: event.clientY - rect.top + list.scrollTop };
}

/** 框到的頁 id（依清單順序；卡片的 offset 以清單為基準，清單須為 position: relative）。 */
function pageIdsInBox(list: HTMLElement, box: LayoutBox): string[] {
  return [...list.querySelectorAll<HTMLElement>(CARD_SELECTOR)]
    .filter((card) => boxesOverlap(box, { left: card.offsetLeft, top: card.offsetTop, width: card.offsetWidth, height: card.offsetHeight }))
    .map((card) => card.dataset.pageId ?? '')
    .filter(Boolean);
}

/** 拉到清單上下緣時往該方向捲一點。 */
function autoScroll(list: HTMLElement, clientY: number) {
  const { marqueeAutoScrollEdge: edge, marqueeAutoScrollStep: step } = PDF_WORKSPACE_CONFIG;
  const rect = list.getBoundingClientRect();
  if (clientY > rect.bottom - edge) list.scrollTop += step;
  else if (clientY < rect.top + edge) list.scrollTop -= step;
}

export function useMarqueeSelection({
  selectedIds,
  onSelect,
  onClear,
}: {
  selectedIds: readonly string[];
  onSelect: (pageIds: string[]) => void;
  onClear: () => void;
}) {
  const drag = useRef<MarqueeDrag | null>(null);
  const [box, setBox] = useState<LayoutBox | null>(null);

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest(NO_MARQUEE_SELECTOR)) return;
    event.preventDefault(); // 避免拖曳時反白文字
    event.currentTarget.setPointerCapture(event.pointerId);
    const start = toContentPoint(event.currentTarget, event);
    const additive = event.ctrlKey || event.metaKey || event.shiftKey;
    drag.current = { startX: start.x, startY: start.y, baseIds: additive ? [...selectedIds] : [], moved: false, startedOnCard: !!target.closest(CARD_SELECTOR) };
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current) return;
    const list = event.currentTarget;
    autoScroll(list, event.clientY);
    const point = toContentPoint(list, event);
    if (!current.moved && Math.hypot(point.x - current.startX, point.y - current.startY) < PDF_WORKSPACE_CONFIG.marqueeMinDrag) return;
    current.moved = true;
    const next: LayoutBox = {
      left: Math.min(current.startX, point.x),
      top: Math.min(current.startY, point.y),
      width: Math.abs(point.x - current.startX),
      height: Math.abs(point.y - current.startY),
    };
    setBox(next);
    onSelect([...new Set([...current.baseIds, ...pageIdsInBox(list, next)])]);
  }

  function handlePointerEnd() {
    const current = drag.current;
    drag.current = null;
    setBox(null);
    if (current && !current.moved && !current.startedOnCard && current.baseIds.length === 0) onClear();
  }

  return {
    box,
    marqueeHandlers: {
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerEnd,
      onPointerCancel: handlePointerEnd,
    },
  };
}
