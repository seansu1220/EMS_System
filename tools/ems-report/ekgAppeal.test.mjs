/**
 * 分隊申訴表的測試（全部是純函式，不連網、不讀試算表）。
 *
 * 釘住的是使用者 2026-08-10 講定的規則，每一條錯了都會讓報表數字失真：
 *   - 第一列是範例，固定跳過
 *   - 只處理查詢期間內的
 *   - 本來就算進分子的**不重複加**（否則分子會超過分母）
 *   - TEMSIS 長度不對**不可以**當成「系統查無此案」而分母分子亂加
 *   - 後備比對要三個條件同時成立，且配對到兩件以上時不猜
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSheetDateTime,
  squadFromCarNumber,
  parseAppeals,
  matchAppeals,
  matchByPlaceAndTime,
  tallyAdjustments,
} from './ekgAppeal.mjs';
import { VERDICT } from './ekgVerify.mjs';

const MONTH = { start: '2026-07-01', end: '2026-07-31', label: '2026-07' };

const HEADERS = ['項次', 'TEMSIS ID', '案件日期', '救護車編號', '發生地點', '患者姓名'];
/** 22 碼，與匯出檔同格式。 */
const CODE_已計入 = '2026070610100312283701';
const CODE_到院後 = '2026071910100312131702';
const CODE_沒12導程 = '2026070210100322142501';

/** 分母裡的案件（只留比對用得到的欄）。 */
const case_ = (overrides) => ({
  temsis: '', squad: '平鎮分隊', caseDate: '', epochMs: null, place: '', arrival: '',
  hasProcedure: true, hasTwelveLead: true, outcome: null, counted: false, ...overrides,
});

const CASES = [
  case_({
    temsis: CODE_已計入, caseDate: '2026/07/06 12:28:37', epochMs: Date.parse('2026-07-06T12:28:37Z'),
    place: '平鎮區環南路二段100號', counted: true, outcome: { verdict: VERDICT.before },
  }),
  case_({
    temsis: CODE_到院後, caseDate: '2026/07/19 12:13:17', epochMs: Date.parse('2026-07-19T12:13:17Z'),
    place: '平鎮區中豐路山頂段50號', outcome: { verdict: VERDICT.after },
  }),
  case_({
    temsis: CODE_沒12導程, caseDate: '2026/07/02 22:14:25', epochMs: Date.parse('2026-07-02T22:14:25Z'),
    place: '平鎮區延平路三段8號', hasTwelveLead: false,
  }),
];

/** 組出一份試算表：第一列一定是範例（比照實際那張表）。 */
function sheet(...dataRows) {
  return [HEADERS, ['0', 'xxxx', '2020/01/01 00:00', 'xx91', '範例地點', '範例'], ...dataRows];
}

test('人手填的時間寫法要接得住，不然申訴會被默默漏掉', () => {
  // 這四種都是實測 2026-08-10 在表上真的出現過的寫法。
  assert.equal(normalizeSheetDateTime('2026/07/08 0620'), '2026/07/08 06:20');
  assert.equal(normalizeSheetDateTime('2026/03/18 0750'), '2026/03/18 07:50');
  assert.equal(normalizeSheetDateTime('2026/6/6 上午 7:03:00'), '2026/6/6 07:03:00');
  assert.equal(normalizeSheetDateTime('2026/6/6 下午 3:20'), '2026/6/6 15:20');
  // 本來就正常的不可以被改壞。
  assert.equal(normalizeSheetDateTime('2026/07/19 12:07'), '2026/07/19 12:07');
  assert.equal(normalizeSheetDateTime('2026-07-17 18:38:57'), '2026-07-17 18:38:57');
  assert.equal(normalizeSheetDateTime('2026/7/20 20:20'), '2026/7/20 20:20');
});

test('半日制的午夜與正午不可以換算錯', () => {
  assert.equal(normalizeSheetDateTime('2026/7/1 上午 12:30'), '2026/7/1 00:30');
  assert.equal(normalizeSheetDateTime('2026/7/1 下午 12:30'), '2026/7/1 12:30');
});

test('只填日期沒填時間的列不可以被丟掉——TEMSIS 本來就認得出是哪一件', () => {
  const { appeals, skipped } = parseAppeals(sheet(
    ['1', CODE_到院後, '2026/07/19', '平鎮91', '平鎮區中豐路山頂段50號', ''],
  ), MONTH);
  assert.deepEqual(skipped.noDate, []);
  assert.equal(appeals.length, 1);
  assert.equal(appeals[0].hasTime, false);

  const [result] = matchAppeals(appeals, CASES);
  assert.equal(result.outcome, '補進分子');
  assert.equal(result.matchedBy, 'TEMSIS');
});

test('只填日期時，後備比對改成比「同一天」', () => {
  const appeal = {
    temsis: '', squad: '平鎮分隊', caseDate: '2026/07/19', place: '平鎮區中豐路山頂段50號',
    epochMs: Date.parse('2026-07-19T00:00:00Z'), hasTime: false, lineNumber: 3,
  };
  // 案件是 12:13，跟 00:00 差 12 小時；若還照 10 分鐘容差比就永遠配不到。
  assert.equal(matchByPlaceAndTime(appeal, CASES)?.temsis, CODE_到院後);
});

test('只填日期時，不同天的還是不可以配對', () => {
  const appeal = {
    temsis: '', squad: '平鎮分隊', caseDate: '2026/07/18', place: '平鎮區中豐路山頂段50號',
    epochMs: Date.parse('2026-07-18T00:00:00Z'), hasTime: false, lineNumber: 3,
  };
  assert.equal(matchByPlaceAndTime(appeal, CASES), null);
});

test('日期看不懂的列要記下列號，讓人回表上修', () => {
  const { appeals, skipped } = parseAppeals(sheet(
    ['1', CODE_到院後, '看不懂的日期', '平鎮91', '某處', ''],
  ), MONTH);
  assert.equal(appeals.length, 0);
  assert.deepEqual(skipped.noDate, ['3']);
});

test('4 碼時間寫法的案件要被算進當月，不可以漏掉', () => {
  const { appeals, skipped } = parseAppeals(sheet(
    ['1', CODE_到院後, '2026/07/08 0620', '平鎮91', '某處', ''],
  ), MONTH);
  assert.equal(appeals.length, 1);
  assert.deepEqual(skipped.noDate, []);
});

test('救護車編號推分隊：平鎮91 → 平鎮分隊', () => {
  assert.equal(squadFromCarNumber('平鎮91'), '平鎮分隊');
  assert.equal(squadFromCarNumber('大園 92'), '大園分隊');
  assert.equal(squadFromCarNumber('平鎮分隊'), '平鎮分隊');
  assert.equal(squadFromCarNumber('91'), '', '只有數字推不出分隊，不可以亂猜');
  assert.equal(squadFromCarNumber(''), '');
});

test('第一列範例固定跳過，不會被當成真案件', () => {
  const { appeals, skipped } = parseAppeals(sheet(), MONTH);
  assert.equal(appeals.length, 0);
  assert.equal(skipped.example, 1);
});

test('只處理查詢期間內的列（那張表是累積的）', () => {
  const { appeals, skipped } = parseAppeals(sheet(
    ['1', CODE_到院後, '2026/07/19 12:13', '平鎮91', '平鎮區中豐路山頂段50號', ''],
    ['2', CODE_已計入, '2026/06/30 08:00', '平鎮91', '別的地方', ''],
    ['3', CODE_已計入, '2026/08/01 08:00', '平鎮91', '別的地方', ''],
  ), MONTH);
  assert.equal(appeals.length, 1);
  assert.equal(appeals[0].temsis, CODE_到院後);
  assert.equal(skipped.outOfRange, 2);
});

test('車號推不出分隊的列不處理，並記下列號供人回表上補', () => {
  const { appeals, skipped } = parseAppeals(sheet(
    ['1', CODE_到院後, '2026/07/19 12:13', '99', '某處', ''],
  ), MONTH);
  assert.equal(appeals.length, 0);
  assert.deepEqual(skipped.noSquad, ['3'], '標題列是第 1 列、範例是第 2 列，所以這筆是第 3 列');
});

test('本來就算進分子的，不重複加（否則分子會超過分母）', () => {
  const { appeals } = parseAppeals(sheet(
    ['1', CODE_已計入, '2026/07/06 12:28', '平鎮91', '平鎮區環南路二段100號', ''],
  ), MONTH);
  const [result] = matchAppeals(appeals, CASES);
  assert.equal(result.outcome, '已計入');

  const adjustments = tallyAdjustments([result]);
  assert.equal(adjustments.numerator.size, 0);
  assert.equal(adjustments.denominator.size, 0);
});

test('查核沒過的補進分子，分母不變', () => {
  const { appeals } = parseAppeals(sheet(
    ['1', CODE_到院後, '2026/07/19 12:13', '平鎮91', '平鎮區中豐路山頂段50號', ''],
  ), MONTH);
  const [result] = matchAppeals(appeals, CASES);
  assert.equal(result.outcome, '補進分子');
  assert.equal(result.matchedBy, 'TEMSIS');

  const adjustments = tallyAdjustments([result]);
  assert.equal(adjustments.numerator.get('平鎮分隊'), 1);
  assert.equal(adjustments.denominator.size, 0, '分母不可以動');
});

test('分母裡有、但沒有 12 導程可查的，一樣補進分子', () => {
  const { appeals } = parseAppeals(sheet(
    ['1', CODE_沒12導程, '2026/07/02 22:14', '平鎮91', '平鎮區延平路三段8號', ''],
  ), MONTH);
  const [result] = matchAppeals(appeals, CASES);
  assert.equal(result.outcome, '補進分子');
  assert.match(result.reason, /沒有 12 導程/);
});

test('系統查不到的：分母、分子、有處置未勾選都各 +1', () => {
  const { appeals } = parseAppeals(sheet(
    ['1', '2026072510100311111199', '2026/07/25 09:00', '龍岡91', '中壢區龍東路1號', ''],
  ), MONTH);
  const [result] = matchAppeals(appeals, CASES);
  assert.equal(result.outcome, '新增案件');

  const adjustments = tallyAdjustments([result]);
  assert.equal(adjustments.numerator.get('龍岡分隊'), 1);
  assert.equal(adjustments.denominator.get('龍岡分隊'), 1);
  assert.equal(adjustments.missingProcedure.get('龍岡分隊'), 1);
});

test('TEMSIS 長度不對時走後備比對，配對得到就當成同一件', () => {
  const { appeals } = parseAppeals(sheet(
    // 17 碼、且時間填成派遣時間（比案發早 6 分鐘），但分隊與地點對得上。
    ['1', '20260719101003121', '2026/07/19 12:07', '平鎮91', '平鎮區中豐路山頂段50號', ''],
  ), MONTH);
  const [result] = matchAppeals(appeals, CASES);
  assert.equal(result.outcome, '補進分子');
  assert.equal(result.matchedBy, '分隊＋發生地點＋時間相近');
});

test('TEMSIS 長度不對又配對不到時，是「無法處理」而不是「新增案件」', () => {
  const { appeals } = parseAppeals(sheet(
    ['1', '20260719101003121', '2026/07/25 09:00', '平鎮91', '對不上的地點', ''],
  ), MONTH);
  const [result] = matchAppeals(appeals, CASES);
  assert.equal(result.outcome, '無法處理', '長度不對就亂加分母分子會平白多算');

  const adjustments = tallyAdjustments([result]);
  assert.equal(adjustments.numerator.size, 0);
  assert.equal(adjustments.denominator.size, 0);
});

test('後備比對：時間超過容差就不算同一件', () => {
  const appeal = {
    temsis: '', squad: '平鎮分隊', caseDate: '', place: '平鎮區中豐路山頂段50號',
    epochMs: Date.parse('2026-07-19T11:50:00Z'), hasTime: true, lineNumber: 3,
  };
  assert.equal(matchByPlaceAndTime(appeal, CASES), null, '差 23 分鐘，超過 10 分鐘容差');
});

test('後備比對：地點的空白與標點不影響配對', () => {
  const appeal = {
    temsis: '', squad: '平鎮分隊', caseDate: '', place: '平鎮區 中豐路山頂段 50號',
    epochMs: Date.parse('2026-07-19T12:15:00Z'), hasTime: true, lineNumber: 3,
  };
  assert.equal(matchByPlaceAndTime(appeal, CASES)?.temsis, CODE_到院後);
});

test('後備比對：同分隊同地點在容差內有兩件時不猜', () => {
  const 雙胞胎 = [...CASES, case_({
    temsis: '2026071910100312131799', caseDate: '2026/07/19 12:15:00',
    epochMs: Date.parse('2026-07-19T12:15:00Z'), place: '平鎮區中豐路山頂段50號',
  })];
  const appeal = {
    temsis: '', squad: '平鎮分隊', caseDate: '', place: '平鎮區中豐路山頂段50號',
    epochMs: Date.parse('2026-07-19T12:14:00Z'), hasTime: true, lineNumber: 3,
  };
  assert.equal(matchByPlaceAndTime(appeal, 雙胞胎), null, '配對到兩件就該回報，不可以挑一件');
});

test('後備比對：分隊不同就不算同一件（地點與時間都對也一樣）', () => {
  const appeal = {
    temsis: '', squad: '龍岡分隊', caseDate: '', place: '平鎮區中豐路山頂段50號',
    epochMs: Date.parse('2026-07-19T12:15:00Z'), hasTime: true, lineNumber: 3,
  };
  assert.equal(matchByPlaceAndTime(appeal, CASES), null);
});

test('申訴指到已排除的 OHCA 案件時不補回去，排除才不會白做', () => {
  // ⚠ 2026-08-13 實跑踩到：那些案件不在分母裡，申訴比對就判成「新增案件」
  //   而把分母分子各補 1 回去，比沒排除還糟（還順便算進分子）。
  const appeal = {
    temsis: '2026071910100312131702', squad: '平鎮分隊', caseDate: '2026/07/19',
    epochMs: Date.parse('2026-07-19T12:13:17Z'), hasTime: true, place: '',
  };
  const excluded = [{
    temsis: '2026071910100312131702', squad: '平鎮分隊', caseDate: '2026/07/19 12:13:17',
    epochMs: Date.parse('2026-07-19T12:13:17Z'), place: '中山路一段', counted: false,
  }];

  const [result] = matchAppeals([appeal], [], excluded);
  assert.equal(result.outcome, '已排除');
  assert.equal(result.matchedBy, 'TEMSIS');
  assert.match(result.reason, /CPR|OHCA/);

  // 三項調整一件都不可以動。
  const adjustments = tallyAdjustments([result]);
  assert.equal(adjustments.numerator.size, 0);
  assert.equal(adjustments.denominator.size, 0);
  assert.equal(adjustments.missingProcedure.size, 0);
});

test('TEMSIS 長度不對時，也要能靠分隊＋地點＋時間認出已排除的案件', () => {
  // 龍岡那件申訴的 TEMSIS 只有 17 碼，只能靠地點時間配對。
  const appeal = {
    temsis: '20260717101000024', squad: '龍岡分隊', caseDate: '2026/07/17 11:07',
    epochMs: Date.parse('2026-07-17T11:07:24Z'), hasTime: true, place: '龍慈路二段',
  };
  const excluded = [{
    temsis: '2026071710100311072401', squad: '龍岡分隊', caseDate: '2026/07/17 11:07:24',
    epochMs: Date.parse('2026-07-17T11:07:24Z'), place: '龍慈路二段', counted: false,
  }];

  const [result] = matchAppeals([appeal], [], excluded);
  assert.equal(result.outcome, '已排除');
  assert.equal(result.matchedBy, '分隊＋發生地點＋時間相近');
});

test('分母裡找得到的案件優先，不會被誤判成已排除', () => {
  const appeal = {
    temsis: '2026072010100320182701', squad: '平鎮分隊', caseDate: '2026/7/20 20:20',
    epochMs: Date.parse('2026-07-20T20:18:27Z'), hasTime: true, place: '',
  };
  const inDenominator = [{
    temsis: '2026072010100320182701', squad: '平鎮分隊', caseDate: '2026/07/20 20:18:27',
    epochMs: Date.parse('2026-07-20T20:18:27Z'), place: '', counted: false,
  }];

  const [result] = matchAppeals([appeal], inDenominator, inDenominator);
  assert.notEqual(result.outcome, '已排除');
  assert.equal(result.outcome, '補進分子');
});

test('沒傳已排除清單時，行為與從前完全相同', () => {
  const appeal = {
    temsis: '2026071910100312131702', squad: '平鎮分隊', caseDate: '2026/07/19',
    epochMs: Date.parse('2026-07-19T12:13:17Z'), hasTime: true, place: '',
  };
  const [result] = matchAppeals([appeal], []);
  assert.equal(result.outcome, '新增案件');
});
