/**
 * 小工具頁「逐倉強平價計算機」的參數（配置驅動）。
 * 只有管理員看得到（見 ToolsPage）；計算邏輯在 lib/liquidationCalc.ts。
 */

export const LIQUIDATION_CALC_CONFIG = {
  /** 維持保證金率預設值（%）：幣安 U 本位最低一級常見為 0.5%。 */
  defaultMmrPercent: '0.5',
  /** 維持保證金速算額預設值（USDT）：小倉位為 0。 */
  defaultCumUsdt: '0',
  /** 對照表列出的槓桿倍數。 */
  leverageTable: [1, 2, 3, 4, 5, 10, 20],
  /** 畫面上數字顯示的小數位數。 */
  displayDecimals: 2,
  /** 「依槓桿帶入」填入保證金欄時保留的小數位數（多留幾位，避免四捨五入後強平價跑掉）。 */
  marginFillDecimals: 4,
  /** 記住上次輸入值的 localStorage 鍵名（只存在這台電腦的瀏覽器）。 */
  storageKey: 'ems.tools.liquidationCalc.v1',
  /** 頁面底部的提醒文字。 */
  disclaimer: '估算值，未計入手續費與資金費率；MMR 依倉位名目價值分級，實際以幣安顯示為準',
} as const;
