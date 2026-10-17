import assert from 'node:assert/strict';
import test from 'node:test';
import { progressLabel, splitListFiles } from './revokeUnlisted.mjs';

test('splitListFiles：保留名單開頭的是保留名單，其餘名單檔是全部名單', () => {
  const split = splitListFiles(
    ['保留名單.txt', '全部人員.xlsx', '~$全部人員.xlsx', '說明.docx', '保留名單-補.xlsx', '第二份.csv'],
    '保留名單',
  );
  assert.deepEqual(split.keepFiles, ['保留名單.txt', '保留名單-補.xlsx']);
  assert.deepEqual(split.allFiles, ['全部人員.xlsx', '第二份.csv']);
});

test('progressLabel：依全部名單的檔名分開記進度', () => {
  assert.equal(progressLabel(['D:/x/十月人員.xlsx']), '取消名單外DACPR-十月人員');
  assert.equal(progressLabel(['D:/x/甲.xlsx', 'D:/x/乙.xlsx']), '取消名單外DACPR-甲等2份');
  assert.notEqual(progressLabel(['十月人員.xlsx']), progressLabel(['十一月人員.xlsx']));
});
