/**
 * 假日設定區塊（嵌在屬性管理頁右欄；v1.12.2 前為獨立的 /holidays 頁）。
 *
 * 首頁提醒卡的「剩 N 個工作日」會扣掉週末與國定假日，這裡就是那份假日清單的來源。
 * 程式已內建 2026、2027；政府每年年中公布次年辦公日曆表後，
 * 管理員可在此匯入官方 CSV，全裝置立即生效，不需重新部署程式。
 *
 * 所有人都可以查看清單（因為它影響每個人看到的天數），但只有管理員能匯入或刪除。
 * 自行管理狀態與錯誤訊息，不與屬性管理的狀態混在一起。
 */
import { useState, type ChangeEvent } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useHolidays } from '../hooks/useHolidays';
import { parseOfficeCalendarCsv, type HolidayCsvParseResult } from '../lib/holidayCsv';
import { deleteHolidayCalendar, saveHolidayCalendars } from '../services/holidayService';
import { HOLIDAY_SOURCE_LINKS } from '../config/holidays';
import type { HolidayCalendar } from '../types/holiday';
import { Badge, Button, Card, ErrorBanner, TEXTAREA_CLASS } from './ui';

export function HolidaySettings() {
  const { user, isAdmin } = useAuth();
  const { calendars, loading, error } = useHolidays();
  const [preview, setPreview] = useState<HolidayCsvParseResult | null>(null);
  const [sourceLabel, setSourceLabel] = useState('');
  const [pastedText, setPastedText] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /** 解析 CSV 內容並進入預覽（尚未寫入資料庫）。 */
  function runParse(text: string, label: string) {
    setActionError(null);
    setNotice(null);
    setSourceLabel(label);
    setPreview(parseOfficeCalendarCsv(text, new Date().toISOString()));
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      runParse(await file.text(), file.name);
    } catch (err) {
      setActionError(`讀取檔案失敗：${(err as Error).message}`);
    } finally {
      // 清空 input，讓同一個檔案可以重新選取觸發。
      event.target.value = '';
    }
  }

  /** 將預覽中的年度清單寫入資料庫。 */
  async function handleConfirmImport() {
    if (!user || !preview || preview.calendars.length === 0) return;
    setBusy(true);
    setActionError(null);
    try {
      await saveHolidayCalendars(preview.calendars, user.uid);
      const years = preview.calendars.map((calendar) => calendar.year).join('、');
      setNotice(`已匯入 ${years} 年的假日清單，首頁天數已同步更新。`);
      setPreview(null);
      setPastedText('');
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(year: number) {
    if (
      !window.confirm(
        `確定刪除 ${year} 年已匯入的假日清單？\n刪除後該年度會回到程式內建版本（若無內建則只扣週末）。`,
      )
    ) {
      return;
    }
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await deleteHolidayCalendar(year);
      setNotice(`已刪除 ${year} 年的匯入清單。`);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <ErrorBanner message={actionError ?? error} />
      {notice && (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-700">
          {notice}
        </div>
      )}

      <Card>
        <h2 className="mb-1 text-base font-bold text-slate-700">假日設定</h2>
        <p className="mb-3 text-xs text-slate-400">
          首頁提醒的「剩 N 個工作日」會扣掉週末與這裡的國定假日。
          沒有列出的年份只扣週六日（不會憑空猜假日）。
        </p>
        {loading ? (
          <p className="py-6 text-center text-sm text-slate-400">載入中…</p>
        ) : calendars.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-400">目前沒有任何年度的假日清單。</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {calendars.map((calendar) => (
              <CalendarRow
                key={calendar.year}
                calendar={calendar}
                canDelete={isAdmin && calendar.source === 'imported'}
                busy={busy}
                onDelete={() => handleDelete(calendar.year)}
              />
            ))}
          </ul>
        )}
      </Card>

      {isAdmin && (
        <ImportCard
          preview={preview}
          sourceLabel={sourceLabel}
          pastedText={pastedText}
          busy={busy}
          onPastedTextChange={setPastedText}
          onFileChange={handleFileChange}
          onParsePasted={() => runParse(pastedText, '貼上的內容')}
          onCancel={() => setPreview(null)}
          onConfirm={handleConfirmImport}
        />
      )}
    </div>
  );
}

/** 匯入區塊（僅管理員可見）：選檔或貼上 → 預覽 → 確認寫入。 */
function ImportCard({
  preview,
  sourceLabel,
  pastedText,
  busy,
  onPastedTextChange,
  onFileChange,
  onParsePasted,
  onCancel,
  onConfirm,
}: {
  preview: HolidayCsvParseResult | null;
  sourceLabel: string;
  pastedText: string;
  busy: boolean;
  onPastedTextChange: (value: string) => void;
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onParsePasted: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Card>
      <h2 className="mb-2 text-base font-bold text-slate-700">匯入新年度</h2>
      <p className="mb-2 text-xs text-slate-400">
        政府通常每年年中才公布次年的辦公日曆表，公布後在這裡匯入即可，不需要改程式。
      </p>
      <ol className="mb-4 list-decimal space-y-1 pl-5 text-sm text-slate-600">
        <li>
          到下列任一處下載「政府行政機關辦公日曆表」的
          <strong>數字版 CSV</strong>（不是 Google 行事曆專用版、也不是 PDF）：
          <ul className="mt-1 space-y-0.5">
            {HOLIDAY_SOURCE_LINKS.map((link) => (
              <li key={link.url}>
                <a
                  href={link.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-slate-700 underline hover:text-slate-900"
                >
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </li>
        <li>在下面選擇那個檔案（或用記事本打開、全選複製後貼到下方欄位）。</li>
        <li>系統會先顯示讀到的內容，確認無誤後再按「確認匯入」。</li>
      </ol>

      <input
        type="file"
        accept=".csv,text/csv"
        onChange={onFileChange}
        className="w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-800 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-slate-700"
      />

      <details className="mt-3">
        <summary className="cursor-pointer text-sm text-slate-600">或直接貼上檔案內容</summary>
        <textarea
          value={pastedText}
          onChange={(event) => onPastedTextChange(event.target.value)}
          rows={5}
          placeholder="西元日期,星期,是否放假,備註&#10;20270101,五,2,開國紀念日&#10;…"
          className={`${TEXTAREA_CLASS} mt-2 font-mono text-xs`}
        />
        <Button
          variant="secondary"
          className="mt-2"
          disabled={!pastedText.trim()}
          onClick={onParsePasted}
        >
          讀取貼上的內容
        </Button>
      </details>

      {preview && (
        <ImportPreview
          preview={preview}
          sourceLabel={sourceLabel}
          busy={busy}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      )}
    </Card>
  );
}

/** 匯入前的確認畫面：列出每年讀到的假日，避免匯錯檔案。 */
function ImportPreview({
  preview,
  sourceLabel,
  busy,
  onCancel,
  onConfirm,
}: {
  preview: HolidayCsvParseResult;
  sourceLabel: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
      <p className="mb-2 text-sm font-medium text-slate-700">
        讀取結果（{sourceLabel}）——尚未儲存
      </p>

      {preview.errors.map((message) => (
        <p
          key={message}
          className="mb-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {message}
        </p>
      ))}

      {preview.calendars.map((calendar) => (
        <div key={calendar.year} className="mb-3">
          <p className="text-sm text-slate-700">
            <strong>{calendar.year} 年</strong>：全年放假 {calendar.offDayCount} 天，
            其中平日放假 {calendar.holidays.length} 天、需補班的週末 {calendar.workdays.length} 天。
          </p>
          <EntryList calendar={calendar} />
        </div>
      ))}

      {preview.calendars.length > 0 && (
        <div className="mt-3 flex gap-2">
          <Button onClick={onConfirm} disabled={busy}>
            {busy ? '匯入中…' : '確認匯入'}
          </Button>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            取消
          </Button>
        </div>
      )}
    </div>
  );
}

/** 單一年度列：來源、統計、明細展開、刪除。 */
function CalendarRow({
  calendar,
  canDelete,
  busy,
  onDelete,
}: {
  calendar: HolidayCalendar;
  canDelete: boolean;
  busy: boolean;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium text-slate-800">{calendar.year} 年</span>
        <Badge tone={calendar.source === 'imported' ? 'blue' : 'slate'}>
          {calendar.source === 'imported' ? '已匯入' : '程式內建'}
        </Badge>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            className="rounded-lg px-2 py-1 text-sm text-slate-600 hover:bg-slate-100"
          >
            {expanded ? '收合' : '看明細'}
          </button>
          {canDelete && (
            <button
              type="button"
              onClick={onDelete}
              disabled={busy}
              className="rounded-lg px-2 py-1 text-sm text-red-500 hover:bg-red-50 disabled:opacity-50"
            >
              刪除
            </button>
          )}
        </div>
      </div>
      <p className="mt-0.5 text-xs text-slate-400">
        平日放假 {calendar.holidays.length} 天 · 補班 {calendar.workdays.length} 天
        {calendar.offDayCount > 0 && ` · 全年放假 ${calendar.offDayCount} 天`}
        {calendar.updatedAt && ` · 更新於 ${calendar.updatedAt.slice(0, 10)}`}
      </p>
      {expanded && <EntryList calendar={calendar} />}
    </li>
  );
}

/** 假日/補班明細（匯入預覽與年度列共用）。 */
function EntryList({ calendar }: { calendar: HolidayCalendar }) {
  return (
    <div className="mt-2 space-y-2 text-xs">
      <div className="flex flex-wrap gap-1">
        {calendar.holidays.map((entry) => (
          <span key={entry.date} className="rounded bg-red-50 px-2 py-0.5 text-red-700">
            {entry.date.slice(5)} {entry.name}
          </span>
        ))}
      </div>
      {calendar.workdays.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {calendar.workdays.map((entry) => (
            <span key={entry.date} className="rounded bg-amber-50 px-2 py-0.5 text-amber-700">
              {entry.date.slice(5)} 補班
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
