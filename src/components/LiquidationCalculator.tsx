/**
 * 小工具頁「逐倉強平價計算機」分區（**只有管理員看得到**，見 ToolsPage；使用者 2026-11-15 指定）。
 *
 * 純顯示與輸入：計算全部在 lib/liquidationCalc.ts，本元件只負責欄位、即時顯示與記住上次輸入。
 * 不碰資料庫；上次輸入值只存在這台電腦瀏覽器的 localStorage（讀寫失敗不影響使用）。
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Card, FieldLabel, INPUT_CLASS } from './ui';
import { LIQUIDATION_CALC_CONFIG } from '../config/liquidationCalc';
import {
  calcMarginFromLeverage,
  evaluateLiquidation,
  type LeverageRow,
  type LiquidationFormState,
  type LiquidationPrice,
  type LiquidationResult,
  type PositionSide,
  type TargetAnalysis,
} from '../lib/liquidationCalc';

const DEFAULT_FORM: LiquidationFormState = {
  side: 'long',
  entryPrice: '',
  quantity: '',
  margin: '',
  leverage: '',
  targetPrice: '',
  mmrPercent: LIQUIDATION_CALC_CONFIG.defaultMmrPercent,
  cumUsdt: LIQUIDATION_CALC_CONFIG.defaultCumUsdt,
};

const SIDE_LABELS: Record<PositionSide, string> = { long: '做多', short: '做空' };

/** 讀回上次輸入；讀不到或格式不對就用預設值。 */
function loadSavedForm(): LiquidationFormState {
  try {
    const raw = window.localStorage.getItem(LIQUIDATION_CALC_CONFIG.storageKey);
    if (!raw) return DEFAULT_FORM;
    const saved = JSON.parse(raw) as Partial<Record<keyof LiquidationFormState, unknown>>;
    const form = { ...DEFAULT_FORM };
    for (const key of Object.keys(DEFAULT_FORM) as (keyof LiquidationFormState)[]) {
      if (typeof saved[key] === 'string') (form as Record<string, string>)[key] = saved[key] as string;
    }
    if (form.side !== 'long' && form.side !== 'short') form.side = 'long';
    return form;
  } catch (error) {
    console.warn('逐倉強平價計算機：讀取上次輸入失敗（localStorage），改用預設值。', error);
    return DEFAULT_FORM;
  }
}

/** 記住這次輸入；寫入失敗（無痕模式、空間滿）只記在主控台。 */
function saveForm(form: LiquidationFormState): void {
  try {
    window.localStorage.setItem(LIQUIDATION_CALC_CONFIG.storageKey, JSON.stringify(form));
  } catch (error) {
    console.warn('逐倉強平價計算機：記住輸入失敗（localStorage）。', error);
  }
}

const NUMBER_FORMAT = new Intl.NumberFormat('zh-TW', {
  minimumFractionDigits: LIQUIDATION_CALC_CONFIG.displayDecimals,
  maximumFractionDigits: LIQUIDATION_CALC_CONFIG.displayDecimals,
});
const formatNumber = (value: number): string => NUMBER_FORMAT.format(value);
const formatPrice = (price: LiquidationPrice): string => (price.kind === 'never' ? '不會被強平' : formatNumber(price.value));

/** 槓桿帶入的保證金：多留幾位小數，去掉尾端的 0。 */
const formatFilledMargin = (margin: number): string => String(Number(margin.toFixed(LIQUIDATION_CALC_CONFIG.marginFillDecimals)));

export function LiquidationCalculator() {
  const [form, setForm] = useState<LiquidationFormState>(loadSavedForm);

  useEffect(() => saveForm(form), [form]);

  const evaluation = useMemo(() => evaluateLiquidation(form, LIQUIDATION_CALC_CONFIG.leverageTable), [form]);

  /**
   * 更新欄位。槓桿欄有值＝保證金由槓桿帶入：改槓桿、開倉價或數量都會重新帶入；
   * 自己改保證金就清掉槓桿欄（槓桿已不代表目前的保證金）。
   */
  function updateField(key: keyof LiquidationFormState, value: string) {
    setForm((previous) => {
      const next = { ...previous, [key]: value } as LiquidationFormState;
      if (key === 'margin') return { ...next, leverage: '' };
      if ((key === 'leverage' || key === 'entryPrice' || key === 'quantity') && next.leverage.trim() !== '') {
        const filled = calcMarginFromLeverage(next);
        if (filled !== null) next.margin = formatFilledMargin(filled);
      }
      return next;
    });
  }

  const hasStarted = form.entryPrice.trim() !== '' || form.quantity.trim() !== '';

  return (
    <div className="space-y-4">
      <InputCard form={form} onSideChange={(side) => setForm((previous) => ({ ...previous, side }))} onFieldChange={updateField} />
      {!hasStarted ? (
        <Card>
          <p className="text-sm text-slate-500">輸入開倉價與數量後即時計算。</p>
        </Card>
      ) : evaluation.result === null ? (
        <Card className="border-amber-200 bg-amber-50">
          <ul className="list-disc space-y-1 pl-5 text-sm text-amber-800">
            {evaluation.errors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </Card>
      ) : (
        <ResultSection result={evaluation.result} side={form.side} />
      )}
      <p className="text-center text-xs text-slate-500">⚠️ {LIQUIDATION_CALC_CONFIG.disclaimer}</p>
    </div>
  );
}

/** 一個輸入欄位（文字框＋數字鍵盤，避免 type=number 的捲動誤改）。 */
function NumberField({
  label,
  hint,
  optional,
  value,
  onChange,
  suffix,
}: {
  label: string;
  hint?: string;
  optional?: boolean;
  value: string;
  onChange: (value: string) => void;
  suffix?: ReactNode;
}) {
  return (
    <div>
      <FieldLabel optional={optional} hint={hint}>
        {label}
      </FieldLabel>
      <div className="flex items-center gap-2">
        <input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={`${INPUT_CLASS} min-w-0`}
        />
        {suffix}
      </div>
    </div>
  );
}

/** 輸入區：方向、開倉價、數量、保證金（含依槓桿帶入）、目標強平價、進階設定。 */
function InputCard({
  form,
  onSideChange,
  onFieldChange,
}: {
  form: LiquidationFormState;
  onSideChange: (side: PositionSide) => void;
  onFieldChange: (key: keyof LiquidationFormState, value: string) => void;
}) {
  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium text-slate-700">方向</span>
        <div className="flex rounded-lg border border-slate-300 bg-white p-0.5" role="radiogroup" aria-label="持倉方向">
          {(Object.keys(SIDE_LABELS) as PositionSide[]).map((side) => {
            const selected = form.side === side;
            const selectedTone = side === 'long' ? 'bg-green-600 text-white' : 'bg-red-600 text-white';
            return (
              <button
                key={side}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onSideChange(side)}
                className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
                  selected ? selectedTone : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                {SIDE_LABELS[side]}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <NumberField label="開倉價 EP" hint="USDT" value={form.entryPrice} onChange={(value) => onFieldChange('entryPrice', value)} />
        <NumberField label="數量 q" hint="幣的顆數" value={form.quantity} onChange={(value) => onFieldChange('quantity', value)} />
        <NumberField
          label="逐倉保證金 M"
          hint="USDT"
          value={form.margin}
          onChange={(value) => onFieldChange('margin', value)}
          suffix={
            <label className="flex shrink-0 items-center gap-1 text-xs text-slate-500" title="輸入槓桿，自動填入 M＝q×EP÷L">
              依槓桿帶入
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                aria-label="依槓桿帶入保證金的槓桿倍數"
                placeholder="L"
                value={form.leverage}
                onChange={(event) => onFieldChange('leverage', event.target.value)}
                className="w-14 rounded-lg border border-slate-300 px-2 py-2 text-sm focus:border-slate-500 focus:outline-none"
              />
              倍
            </label>
          }
        />
        <NumberField
          label="目標強平價"
          hint="USDT，反推最少保證金"
          optional
          value={form.targetPrice}
          onChange={(value) => onFieldChange('targetPrice', value)}
        />
      </div>

      <details className="rounded-lg border border-slate-200 px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium text-slate-600">
          進階設定
          <span className="ml-2 text-xs font-normal text-slate-400">
            MMR {form.mmrPercent || '—'}%、速算額 {form.cumUsdt || '—'} USDT
          </span>
        </summary>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <NumberField label="維持保證金率 MMR" hint="%" value={form.mmrPercent} onChange={(value) => onFieldChange('mmrPercent', value)} />
          <NumberField
            label="維持保證金速算額 cum"
            hint="USDT，小倉位為 0"
            value={form.cumUsdt}
            onChange={(value) => onFieldChange('cumUsdt', value)}
          />
        </div>
      </details>
    </Card>
  );
}

/** 結果區：大字強平價與距離、目標價分析、槓桿對照表。 */
function ResultSection({ result, side }: { result: LiquidationResult; side: PositionSide }) {
  return (
    <>
      <Card>
        {result.liquidation === null ? (
          <p className="text-sm text-slate-500">填入逐倉保證金（或用「依槓桿帶入」）後顯示強平價。</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <BigStat label="強平價（USDT）" value={formatPrice(result.liquidation)} tone={result.liquidation.kind === 'never' ? 'green' : 'slate'} />
            <BigStat label="強平距離" value={result.distanceRatio === null ? '—' : `${formatNumber(result.distanceRatio * 100)}%`} tone="slate" />
          </div>
        )}
        <p className="mt-3 text-xs text-slate-500">
          名目價值 {formatNumber(result.notional)} USDT
          {result.actualLeverage !== null && <>　·　實際槓桿 {formatNumber(result.actualLeverage)} 倍</>}
        </p>
      </Card>
      {result.target !== null && <TargetCard target={result.target} side={side} />}
      <LeverageTable rows={result.table} hasTarget={result.target !== null} />
    </>
  );
}

function BigStat({ label, value, tone }: { label: string; value: string; tone: 'slate' | 'green' }) {
  return (
    <div>
      <p className="text-sm text-slate-500">{label}</p>
      <p className={`mt-1 text-3xl font-bold tabular-nums ${tone === 'green' ? 'text-green-700' : 'text-slate-800'}`}>{value}</p>
    </div>
  );
}

/** 有目標強平價時：最少保證金與可減少多少。 */
function TargetCard({ target, side }: { target: TargetAnalysis; side: PositionSide }) {
  const reducible = target.reducibleMargin;
  return (
    <Card className="space-y-3">
      <h2 className="text-sm font-bold text-slate-700">目標強平價 {formatNumber(target.targetPrice)} USDT</h2>
      {target.wrongSide && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {side === 'long' ? '做多的強平價在開倉價下方，目標強平價通常應低於開倉價。' : '做空的強平價在開倉價上方，目標強平價通常應高於開倉價。'}
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className="text-sm text-slate-500">最少保證金</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-slate-800">
            {target.noMarginNeeded ? '不需保證金也不會到這個價位' : `${formatNumber(target.requiredMargin)} USDT`}
          </p>
        </div>
        <div>
          <p className="text-sm text-slate-500">可減少保證金</p>
          {reducible === null ? (
            <p className="mt-1 text-sm text-slate-400">填入逐倉保證金後顯示</p>
          ) : reducible >= 0 ? (
            <p className="mt-1 text-2xl font-bold tabular-nums text-green-700">{formatNumber(reducible)} USDT</p>
          ) : (
            <p className="mt-1 text-lg font-bold text-red-600">保證金不足，需再增加 {formatNumber(-reducible)} USDT</p>
          )}
        </div>
      </div>
    </Card>
  );
}

/** 槓桿對照表；有目標價時符合的列綠色、不符合的列紅色。 */
function LeverageTable({ rows, hasTarget }: { rows: LeverageRow[]; hasTarget: boolean }) {
  const rowTone = (row: LeverageRow): string => {
    if (row.meetsTarget === null) return '';
    return row.meetsTarget ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-700';
  };
  return (
    <Card>
      <h2 className="text-sm font-bold text-slate-700">槓桿對照表</h2>
      {hasTarget && <p className="mt-1 text-xs text-slate-500">綠色＝強平價不會比目標價先到；紅色＝會先被強平。</p>}
      <div className="mt-3 overflow-x-auto">
        <table className="w-full whitespace-nowrap text-sm tabular-nums">
          <thead>
            <tr className="border-b border-slate-200 text-left text-slate-500">
              <th className="px-3 py-2 font-medium">槓桿</th>
              <th className="px-3 py-2 text-right font-medium">保證金（USDT）</th>
              <th className="px-3 py-2 text-right font-medium">強平價（USDT）</th>
              {hasTarget && <th className="px-3 py-2 text-right font-medium">符合目標</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.leverage} className={`border-b border-slate-100 ${rowTone(row)}`}>
                <td className="px-3 py-2">{row.leverage} 倍</td>
                <td className="px-3 py-2 text-right">{formatNumber(row.margin)}</td>
                <td className="px-3 py-2 text-right">{formatPrice(row.liquidation)}</td>
                {hasTarget && <td className="px-3 py-2 text-right">{row.meetsTarget ? '✓' : '✗'}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
