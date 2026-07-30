/**
 * 表單填寫的測試（用假的 frame 物件，不需要真的開瀏覽器）。
 *
 * 這裡釘住的是整個工具最重要的一道保護：**填完一定要回讀驗證**。
 * 查詢條件沒真的填進去卻照樣送出，系統會回傳全部資料——曾因此撈到上萬筆。
 *
 * 執行：npm run tool:ems:test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fillField, selectField, detectDateFormat } from './formFill.mjs';

/**
 * 造一個最小的假 frame。
 * @param {{value?: string, visible?: boolean, readonly?: boolean, attributes?: string,
 *   acceptWrite?: boolean}} behaviour
 */
function createFakeFrame(behaviour = {}) {
  const state = { value: behaviour.value ?? '' };
  const acceptWrite = behaviour.acceptWrite ?? true;
  return {
    state,
    locator() {
      return {
        async evaluate(fn) {
          // 依呼叫端的用途回傳：readonly 判定用布林，日期格式用屬性字串。
          const source = fn.toString();
          if (source.includes('readOnly')) return behaviour.readonly ?? false;
          return behaviour.attributes ?? '';
        },
        async isVisible() {
          return behaviour.visible ?? true;
        },
        async inputValue() {
          return state.value;
        },
      };
    },
    async fill(_selector, value) {
      if (acceptWrite) state.value = value;
    },
    async evaluate(_fn, args) {
      // 模擬「直接寫入 value」那條備援路徑。
      if (acceptWrite && args && typeof args.fieldValue === 'string') state.value = args.fieldValue;
    },
    async selectOption(_selector, value) {
      if (acceptWrite) state.value = value;
    },
  };
}

test('fillField 填入後回讀相符即通過', async () => {
  const frame = createFakeFrame();
  await fillField(frame, '#_txtFromDate', '2026-06-01 00:00:00', '起日');
  assert.equal(frame.state.value, '2026-06-01 00:00:00');
});

test('fillField 回讀不符時必須拋錯，不可以放行', async () => {
  const frame = createFakeFrame({ acceptWrite: false });
  await assert.rejects(() => fillField(frame, '#_txtFromDate', '2026-06-01', '起日'), (error) => {
    assert.match(error.message, /回讀不符/);
    assert.match(error.message, /起日/, '錯誤訊息要說明是哪個欄位');
    return true;
  });
});

test('fillField 對唯讀欄位（日曆元件）仍能寫入', async () => {
  const frame = createFakeFrame({ readonly: true });
  await fillField(frame, '#_txtToDate', '2026-06-30 23:59:59', '迄日');
  assert.equal(frame.state.value, '2026-06-30 23:59:59');
});

test('fillField 對看不見的欄位（收合的進階搜尋）仍能寫入', async () => {
  const frame = createFakeFrame({ visible: false });
  await fillField(frame, '#_txtTemsis', 'T115070100001', 'TEMSIS');
  assert.equal(frame.state.value, 'T115070100001');
});

test('selectField 回讀不符時必須拋錯', async () => {
  const frame = createFakeFrame({ acceptWrite: false });
  await assert.rejects(() => selectField(frame, '#_selSTATUS', '0', '救護狀態'), (error) => {
    assert.match(error.message, /回讀不符/);
    return true;
  });
});

test('detectDateFormat 讀得出日曆元件設定的格式', async () => {
  const frame = createFakeFrame({ attributes: "WdatePicker({dateFmt:'yyyy-MM-dd HH:mm:ss'})" });
  assert.equal(await detectDateFormat(frame, '#_txtFromDate', 'yyyy-MM-dd'), 'yyyy-MM-dd HH:mm:ss');
});

test('detectDateFormat 偵測不到時退回預設格式', async () => {
  const frame = createFakeFrame({ attributes: '' });
  assert.equal(await detectDateFormat(frame, '#_txtFromDate', 'yyyy-MM-dd'), 'yyyy-MM-dd');
});
