/**
 * 內建的國定假日清單（配置驅動）。
 *
 * 資料來源：行政院人事行政總處「中華民國政府行政機關辦公日曆表」開放資料
 * （政府資料開放平臺 dataset 14718），下方兩年皆由官方 CSV 轉出，未經人工修改。
 * 只列出「與預設不同的例外日」：平日放假、週末上班（補班）。
 *
 * ⚠️ 政府通常在每年年中才公布次年的日曆表，所以內建清單天生只涵蓋到近一兩年。
 * 未涵蓋年份的日期一律退回預設規則（只扣週六日），不會亂算；
 * 新年度公布後，管理員可在「假日設定」頁匯入官方 CSV，不需重新部署程式。
 */
import type { HolidayCalendar } from '../types/holiday';

export const BUILTIN_HOLIDAY_CALENDARS: readonly HolidayCalendar[] = [
  {
    year: 2026,
    offDayCount: 120,
    source: 'builtin',
    updatedAt: '',
    holidays: [
      { date: '2026-01-01', name: '開國紀念日' },
      { date: '2026-02-16', name: '農曆除夕' },
      { date: '2026-02-17', name: '春節' },
      { date: '2026-02-18', name: '春節' },
      { date: '2026-02-19', name: '春節' },
      { date: '2026-02-20', name: '補假' },
      { date: '2026-02-27', name: '補假' },
      { date: '2026-04-03', name: '補假' },
      { date: '2026-04-06', name: '補假' },
      { date: '2026-05-01', name: '勞動節' },
      { date: '2026-06-19', name: '端午節' },
      { date: '2026-09-25', name: '中秋節' },
      { date: '2026-09-28', name: '孔子誕辰紀念日/教師節' },
      { date: '2026-10-09', name: '補假' },
      { date: '2026-10-26', name: '補假' },
      { date: '2026-12-25', name: '行憲紀念日' },
    ],
    workdays: [],
  },
  {
    year: 2027,
    offDayCount: 121,
    source: 'builtin',
    updatedAt: '',
    holidays: [
      { date: '2027-01-01', name: '開國紀念日' },
      { date: '2027-02-04', name: '小年夜' },
      { date: '2027-02-05', name: '農曆除夕' },
      { date: '2027-02-08', name: '春節' },
      { date: '2027-02-09', name: '補假' },
      { date: '2027-02-10', name: '補假' },
      { date: '2027-03-01', name: '補假' },
      { date: '2027-04-05', name: '清明節' },
      { date: '2027-04-06', name: '補假' },
      { date: '2027-04-30', name: '補假' },
      { date: '2027-06-09', name: '端午節' },
      { date: '2027-09-15', name: '中秋節' },
      { date: '2027-09-28', name: '孔子誕辰紀念日/教師節' },
      { date: '2027-10-11', name: '補假' },
      { date: '2027-10-25', name: '臺灣光復暨金門古寧頭大捷紀念日' },
      { date: '2027-12-24', name: '補假' },
      { date: '2027-12-31', name: '補假' },
    ],
    workdays: [],
  },
];

/** 官方辦公日曆表的下載頁（假日設定頁顯示給管理員）。 */
export const HOLIDAY_SOURCE_LINKS: readonly { label: string; url: string }[] = [
  { label: '政府資料開放平臺（辦公日曆表 CSV）', url: 'https://data.gov.tw/dataset/14718' },
  { label: '行政院人事行政總處（辦公日曆表）', url: 'https://www.dgpa.gov.tw/informationlist?uid=30' },
];
