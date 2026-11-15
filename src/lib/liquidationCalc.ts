/**
 * 幣安 USDⓈ-M 永續合約「逐倉、單向持倉、單一倉位」的強平價計算（純函式，不依賴 React）。
 *
 * 公式（N＝q×EP，MMR 為比例，例如 0.5% → 0.005）：
 * - 強平價：做多 LP＝(N − M − cum) ÷ (q×(1 − MMR))；做空 LP＝(N + M + cum) ÷ (q×(1 + MMR))
 *   做多算出 LP ≤ 0＝不會被強平。
 * - 反推保證金：做多 M＝N − LP×q×(1 − MMR) − cum；做空 M＝LP×q×(1 + MMR) − N − cum
 *
 * 估算值：未計入手續費與資金費率；MMR 依倉位名目價值分級，實際以幣安顯示為準。
 */

/** 持倉方向。 */
export type PositionSide = 'long' | 'short';

/** 畫面上的原始輸入（全部是字串，空字串＝沒填）。 */
export interface LiquidationFormState {
  side: PositionSide;
  /** 開倉價 EP（USDT）。 */
  entryPrice: string;
  /** 數量 q（幣的顆數）。 */
  quantity: string;
  /** 逐倉保證金 M（USDT）。 */
  margin: string;
  /** 「依槓桿帶入」小工具的槓桿倍數（只用來填保證金，不參與計算）。 */
  leverage: string;
  /** 目標強平價（選填）。 */
  targetPrice: string;
  /** 維持保證金率（%）。 */
  mmrPercent: string;
  /** 維持保證金速算額（USDT）。 */
  cumUsdt: string;
}

/** 計算用的倉位參數（已驗證過的數字）。 */
export interface PositionParams {
  side: PositionSide;
  entryPrice: number;
  quantity: number;
  /** 維持保證金率（比例，0.005＝0.5%）。 */
  mmr: number;
  /** 維持保證金速算額（USDT）。 */
  cum: number;
}

/** 強平價：有一個價位，或做多時保證金夠多、價格歸零也不會被強平。 */
export type LiquidationPrice = { kind: 'price'; value: number } | { kind: 'never' };

/** 有填目標強平價時的分析。 */
export interface TargetAnalysis {
  targetPrice: number;
  /** 公式直接算出的所需保證金（可能 ≤ 0）。 */
  requiredMargin: number;
  /** 所需保證金 ≤ 0：不放保證金也不會在這個價位被強平。 */
  noMarginNeeded: boolean;
  /** 目前保證金 − 所需保證金（所需 ≤ 0 時以 0 計）；沒填保證金為 null。負數＝保證金不足。 */
  reducibleMargin: number | null;
  /** 目標價在開倉價的另一側（做多卻 ≥ EP、做空卻 ≤ EP），通常是填錯。 */
  wrongSide: boolean;
}

/** 槓桿對照表的一列。 */
export interface LeverageRow {
  leverage: number;
  margin: number;
  liquidation: LiquidationPrice;
  /** 有目標價時：這個槓桿的強平價是否不會比目標價先到；沒有目標價為 null。 */
  meetsTarget: boolean | null;
}

/** 整體計算結果。 */
export interface LiquidationResult {
  /** 名目價值 N＝q×EP。 */
  notional: number;
  /** 依目前保證金算出的強平價；沒填保證金為 null。 */
  liquidation: LiquidationPrice | null;
  /** 實際槓桿＝N ÷ M；沒填保證金為 null。 */
  actualLeverage: number | null;
  /** 強平距離＝|EP − LP| ÷ EP（比例）；不會被強平或沒填保證金為 null。 */
  distanceRatio: number | null;
  /** 沒填目標強平價為 null。 */
  target: TargetAnalysis | null;
  table: LeverageRow[];
}

/** 驗證＋計算的輸出：有錯誤時 result 為 null。 */
export interface LiquidationEvaluation {
  errors: string[];
  result: LiquidationResult | null;
}

/** 把輸入字串轉成數字（容許千分位逗號與前後空白）；空白回傳 null，不是數字回傳 NaN。 */
export function parseNumberInput(text: string): number | null {
  const cleaned = text.replace(/[,\s]/g, '');
  if (cleaned === '') return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : Number.NaN;
}

/** 依保證金算強平價。 */
export function calcLiquidationPrice(params: PositionParams, margin: number): LiquidationPrice {
  const { side, entryPrice, quantity, mmr, cum } = params;
  const notional = quantity * entryPrice;
  if (side === 'long') {
    const price = (notional - margin - cum) / (quantity * (1 - mmr));
    return price > 0 ? { kind: 'price', value: price } : { kind: 'never' };
  }
  return { kind: 'price', value: (notional + margin + cum) / (quantity * (1 + mmr)) };
}

/** 依目標強平價反推所需保證金（公式原值，可能 ≤ 0）。 */
export function calcRequiredMargin(params: PositionParams, targetPrice: number): number {
  const { side, entryPrice, quantity, mmr, cum } = params;
  const notional = quantity * entryPrice;
  if (side === 'long') return notional - targetPrice * quantity * (1 - mmr) - cum;
  return targetPrice * quantity * (1 + mmr) - notional - cum;
}

/** 強平價是否不會比目標價先到（做多：LP ≤ 目標；做空：LP ≥ 目標）。 */
export function meetsTargetPrice(side: PositionSide, liquidation: LiquidationPrice, targetPrice: number): boolean {
  if (liquidation.kind === 'never') return true;
  return side === 'long' ? liquidation.value <= targetPrice : liquidation.value >= targetPrice;
}

/** 強平距離（比例）；不會被強平回傳 null。 */
export function calcDistanceRatio(entryPrice: number, liquidation: LiquidationPrice): number | null {
  if (liquidation.kind === 'never') return null;
  return Math.abs(entryPrice - liquidation.value) / entryPrice;
}

/** 槓桿對照表：每個倍數的保證金（N ÷ L）與強平價。 */
export function buildLeverageTable(
  params: PositionParams,
  leverages: readonly number[],
  targetPrice: number | null,
): LeverageRow[] {
  const notional = params.quantity * params.entryPrice;
  return leverages.map((leverage) => {
    const margin = notional / leverage;
    const liquidation = calcLiquidationPrice(params, margin);
    const meetsTarget = targetPrice === null ? null : meetsTargetPrice(params.side, liquidation, targetPrice);
    return { leverage, margin, liquidation, meetsTarget };
  });
}

/** 依槓桿算出要填的保證金（M＝q×EP÷L）；任一值不合法回傳 null。 */
export function calcMarginFromLeverage(form: LiquidationFormState): number | null {
  const entryPrice = parseNumberInput(form.entryPrice);
  const quantity = parseNumberInput(form.quantity);
  const leverage = parseNumberInput(form.leverage);
  if (entryPrice === null || quantity === null || leverage === null) return null;
  if (!(entryPrice > 0 && quantity > 0 && leverage > 0)) return null;
  return (quantity * entryPrice) / leverage;
}

/** 驗證後的輸入數字。 */
interface ParsedInputs {
  params: PositionParams;
  margin: number | null;
  targetPrice: number | null;
}

/** 驗證輸入；有問題就把中文說明放進 errors。 */
function parseInputs(form: LiquidationFormState): { errors: string[]; parsed: ParsedInputs | null } {
  const errors: string[] = [];
  const entryPrice = parseNumberInput(form.entryPrice);
  const quantity = parseNumberInput(form.quantity);
  const margin = parseNumberInput(form.margin);
  const targetPrice = parseNumberInput(form.targetPrice);
  const mmrPercent = parseNumberInput(form.mmrPercent);
  const cum = parseNumberInput(form.cumUsdt);

  if (entryPrice === null || !(entryPrice > 0)) errors.push('請輸入開倉價（需大於 0）');
  if (quantity === null || !(quantity > 0)) errors.push('請輸入數量（需大於 0）');
  if (margin !== null && !(margin > 0)) errors.push('逐倉保證金需大於 0');
  if (targetPrice !== null && !(targetPrice > 0)) errors.push('目標強平價需大於 0');
  if (mmrPercent === null || !(mmrPercent >= 0 && mmrPercent < 100)) errors.push('維持保證金率需介於 0 與 100% 之間（不含 100）');
  if (cum === null || !(cum >= 0)) errors.push('維持保證金速算額需大於或等於 0');
  if (errors.length > 0) return { errors, parsed: null };

  return {
    errors,
    parsed: {
      params: {
        side: form.side,
        entryPrice: entryPrice as number,
        quantity: quantity as number,
        mmr: (mmrPercent as number) / 100,
        cum: cum as number,
      },
      margin,
      targetPrice,
    },
  };
}

/** 目標強平價的分析。 */
function analyzeTarget(params: PositionParams, margin: number | null, targetPrice: number): TargetAnalysis {
  const requiredMargin = calcRequiredMargin(params, targetPrice);
  const noMarginNeeded = requiredMargin <= 0;
  const effectiveRequired = noMarginNeeded ? 0 : requiredMargin;
  const wrongSide = params.side === 'long' ? targetPrice >= params.entryPrice : targetPrice <= params.entryPrice;
  return {
    targetPrice,
    requiredMargin,
    noMarginNeeded,
    reducibleMargin: margin === null ? null : margin - effectiveRequired,
    wrongSide,
  };
}

/** 驗證輸入並算出所有結果（畫面唯一的計算入口）。 */
export function evaluateLiquidation(form: LiquidationFormState, leverages: readonly number[]): LiquidationEvaluation {
  const { errors, parsed } = parseInputs(form);
  if (parsed === null) return { errors, result: null };

  const { params, margin, targetPrice } = parsed;
  const notional = params.quantity * params.entryPrice;
  const liquidation = margin === null ? null : calcLiquidationPrice(params, margin);
  return {
    errors,
    result: {
      notional,
      liquidation,
      actualLeverage: margin === null ? null : notional / margin,
      distanceRatio: liquidation === null ? null : calcDistanceRatio(params.entryPrice, liquidation),
      target: targetPrice === null ? null : analyzeTarget(params, margin, targetPrice),
      table: buildLeverageTable(params, leverages, targetPrice),
    },
  };
}
