/**
 * Firestore 安全規則測試（在 Firestore 模擬器上執行，不碰線上資料）。
 *
 * 前置需求：
 *   1. JDK 21 以上（firebase-tools 15 的模擬器要求）。
 *      這台電腦另裝有舊的 Java 8 且在 PATH 中排在前面，
 *      故由 scripts/run-rules-test.mjs 於執行時自動挑出夠新的 JDK，不需手動設環境變數。
 *   2. npm i --no-save @firebase/rules-unit-testing --legacy-peer-deps
 *      （刻意不列入 devDependencies，避免一般安裝時的 peer 版本衝突；缺少時啟動器會提示）。
 * 執行方式：npm run test:rules
 *
 * 驗證重點（對應 SPEC 2.7 權限模型）：
 * 1. 管理員（email 白名單）可讀寫全部資料，並可刪除業務/屬性/公版、核准帳號。
 * 2. 已核准的一般使用者可讀、可新增、可編輯，但**不可刪除業務、屬性、待辦公版**。
 * 3. 待審核 / 未通過的帳號完全不能存取業務資料。
 * 4. 一般使用者不可自行把自己改成 approved 或 admin（不可自我提權）。
 * 5. **解鎖專用帳號**（role == 'unlocker'）讀不到任何業務資料，
 *    解鎖工單只讀得到自己送的、不可回寫結果、不可冒用他人名義申請。
 * 6. **測試用傷票**：號碼只能接續往下領（計數器、領取紀錄、單位週用量必須一起寫、互相對得上），
 *    不能挑號碼、跳號或冒名；單位須為月報表上的分隊且同單位每週最多 20 張；
 *    解鎖專用帳號只讀得到自己的領取紀錄。
 */
import { readFileSync } from 'node:fs';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';

const ADMIN_EMAIL = 'seansu1220@gmail.com';
const PROJECT_ID = 'ems-rules-test';

const testEnv = await initializeTestEnvironment({
  projectId: PROJECT_ID,
  firestore: {
    rules: readFileSync('firebase/firestore.rules', 'utf8'),
    host: '127.0.0.1',
    port: 8080,
  },
});

/** 取得指定身分的 Firestore 實例（token 內帶 email，規則以此判定管理員）。 */
function dbFor(uid, email) {
  return testEnv.authenticatedContext(uid, { email, email_verified: true }).firestore();
}

/** 以繞過規則的方式預先寫入測試資料。 */
async function seed(writer) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await writer(context.firestore());
  });
}

const results = [];
async function check(name, promise) {
  try {
    await promise;
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, message: error.message });
  }
}

await testEnv.clearFirestore();

// ── 預置資料：管理員、已核准成員、待審核者，以及一筆既有業務 ──
await seed(async (db) => {
  await setDoc(doc(db, 'users/admin-uid'), {
    uid: 'admin-uid',
    email: ADMIN_EMAIL,
    displayName: '股長',
    role: 'admin',
    status: 'approved',
  });
  await setDoc(doc(db, 'users/member-uid'), {
    uid: 'member-uid',
    email: 'member@example.com',
    displayName: '同事',
    role: 'member',
    status: 'approved',
  });
  await setDoc(doc(db, 'users/pending-uid'), {
    uid: 'pending-uid',
    email: 'pending@example.com',
    displayName: '待審核者',
    role: 'member',
    status: 'pending',
  });
  await setDoc(doc(db, 'tasks/task-1'), {
    title: '既有業務',
    categoryId: 'cat-1',
    ownerUid: 'admin-uid',
    completed: false,
  });
  await setDoc(doc(db, 'tasks/task-2'), {
    title: '待刪業務',
    categoryId: 'cat-1',
    ownerUid: 'admin-uid',
    completed: false,
  });
  await setDoc(doc(db, 'categories/cat-1'), { name: '採購', sortOrder: 0, ownerUid: 'admin-uid' });
  await setDoc(doc(db, 'categories/cat-2'), { name: '待刪屬性', sortOrder: 1, ownerUid: 'admin-uid' });
  await setDoc(doc(db, 'checklistTemplates/tpl-1'), {
    name: '標案標準流程',
    items: [{ id: 'i1', content: '簽陳核准', sortOrder: 0 }],
    ownerUid: 'admin-uid',
  });
  await setDoc(doc(db, 'users/unlocker-uid'), {
    uid: 'unlocker-uid',
    email: 'squad@example.com',
    displayName: '某分隊',
    role: 'unlocker',
    status: 'approved',
  });
  await setDoc(doc(db, 'unlockRequests/req-mine'), {
    temsis: '2026071210100310384101',
    reason: '處置漏填',
    requestedBy: 'unlocker-uid',
    requestedByName: '某分隊',
    requestedAt: '2026-08-06T01:00:00.000Z',
    status: 'pending',
    result: null,
  });
  await setDoc(doc(db, 'unlockRequests/req-others'), {
    temsis: '2026071210100310384102',
    reason: '別隊送的',
    requestedBy: 'member-uid',
    requestedByName: '同事',
    requestedAt: '2026-08-06T02:00:00.000Z',
    status: 'pending',
    result: null,
  });
  await setDoc(doc(db, 'holidays/2027'), {
    year: 2027,
    holidays: [{ date: '2027-01-01', name: '開國紀念日' }],
    workdays: [],
    offDayCount: 121,
    updatedBy: 'admin-uid',
  });
});

const admin = dbFor('admin-uid', ADMIN_EMAIL);
const member = dbFor('member-uid', 'member@example.com');
const pending = dbFor('pending-uid', 'pending@example.com');
const unlocker = dbFor('unlocker-uid', 'squad@example.com');

// ── 1. 管理員 ──
await check('管理員可讀業務', assertSucceeds(getDoc(doc(admin, 'tasks/task-1'))));
await check('管理員可列出使用者', assertSucceeds(getDocs(collection(admin, 'users'))));
await check(
  '管理員可核准帳號',
  assertSucceeds(updateDoc(doc(admin, 'users/pending-uid'), { status: 'approved' })),
);
await check('管理員可刪除業務', assertSucceeds(deleteDoc(doc(admin, 'tasks/task-2'))));
await check('管理員可刪除屬性', assertSucceeds(deleteDoc(doc(admin, 'categories/cat-2'))));
await check(
  '管理員可匯入假日清單',
  assertSucceeds(
    setDoc(doc(admin, 'holidays/2028'), {
      year: 2028,
      holidays: [{ date: '2028-01-03', name: '補假' }],
      workdays: [],
      offDayCount: 120,
      updatedBy: 'admin-uid',
    }),
  ),
);
await check('管理員可刪除假日清單', assertSucceeds(deleteDoc(doc(admin, 'holidays/2028'))));

// 復原 pending 狀態供後續測試
await seed(async (db) => {
  await updateDoc(doc(db, 'users/pending-uid'), { status: 'pending' });
});

// ── 2. 已核准的一般使用者 ──
await check('成員可讀業務（共用資料）', assertSucceeds(getDoc(doc(member, 'tasks/task-1'))));
await check('成員可列出業務', assertSucceeds(getDocs(collection(member, 'tasks'))));
await check(
  '成員可編輯業務',
  assertSucceeds(updateDoc(doc(member, 'tasks/task-1'), { title: '同事改的標題' })),
);
await check(
  '成員可新增業務（ownerUid 為自己）',
  assertSucceeds(
    setDoc(doc(member, 'tasks/task-new'), {
      title: '同事新增',
      categoryId: 'cat-1',
      ownerUid: 'member-uid',
    }),
  ),
);
await check(
  '成員不可冒用他人 ownerUid 新增業務',
  assertFails(
    setDoc(doc(member, 'tasks/task-fake'), {
      title: '冒名',
      categoryId: 'cat-1',
      ownerUid: 'admin-uid',
    }),
  ),
);
await check('成員不可刪除業務', assertFails(deleteDoc(doc(member, 'tasks/task-1'))));
await check('成員不可列出使用者清單', assertFails(getDocs(collection(member, 'users'))));
await check(
  '成員不可自我提權為 admin',
  assertFails(updateDoc(doc(member, 'users/member-uid'), { role: 'admin' })),
);
await check(
  '成員可改自己的顯示名稱',
  assertSucceeds(updateDoc(doc(member, 'users/member-uid'), { displayName: '新名字' })),
);
await check(
  '成員可改屬性名稱',
  assertSucceeds(updateDoc(doc(member, 'categories/cat-1'), { name: '採購2' })),
);
await check('成員不可刪除屬性', assertFails(deleteDoc(doc(member, 'categories/cat-1'))));
await check(
  '成員可編輯待辦公版內容',
  assertSucceeds(updateDoc(doc(member, 'checklistTemplates/tpl-1'), { name: '標案流程 v2' })),
);
await check(
  '成員不可刪除待辦公版',
  assertFails(deleteDoc(doc(member, 'checklistTemplates/tpl-1'))),
);
await check('成員可讀假日清單（首頁天數要用）', assertSucceeds(getDoc(doc(member, 'holidays/2027'))));
await check(
  '成員不可匯入假日清單（會改變所有人看到的天數）',
  assertFails(updateDoc(doc(member, 'holidays/2027'), { offDayCount: 999 })),
);

// ── 3. 待審核帳號 ──
await check('待審核者不可讀業務', assertFails(getDoc(doc(pending, 'tasks/task-1'))));
await check('待審核者不可列出業務', assertFails(getDocs(collection(pending, 'tasks'))));
await check(
  '待審核者不可新增業務',
  assertFails(
    setDoc(doc(pending, 'tasks/task-x'), {
      title: '未核准',
      categoryId: 'cat-1',
      ownerUid: 'pending-uid',
    }),
  ),
);
await check('待審核者不可讀假日清單', assertFails(getDoc(doc(pending, 'holidays/2027'))));
await check('待審核者可讀自己的帳號文件', assertSucceeds(getDoc(doc(pending, 'users/pending-uid'))));
await check(
  '待審核者不可自我核准',
  assertFails(updateDoc(doc(pending, 'users/pending-uid'), { status: 'approved' })),
);

// ── 4. 註冊（建立 users 文件） ──
const newcomer = dbFor('new-uid', 'newcomer@example.com');
await check(
  '新使用者註冊只能建立 pending 帳號',
  assertSucceeds(
    setDoc(doc(newcomer, 'users/new-uid'), {
      uid: 'new-uid',
      email: 'newcomer@example.com',
      displayName: '新人',
      role: 'member',
      status: 'pending',
    }),
  ),
);
const cheater = dbFor('cheat-uid', 'cheater@example.com');
await check(
  '新使用者不可註冊成已核准帳號',
  assertFails(
    setDoc(doc(cheater, 'users/cheat-uid'), {
      uid: 'cheat-uid',
      email: 'cheater@example.com',
      displayName: '作弊',
      role: 'member',
      status: 'approved',
    }),
  ),
);
const adminSignup = dbFor('admin2-uid', ADMIN_EMAIL);
await check(
  '管理員 email 註冊即為 approved',
  assertSucceeds(
    setDoc(doc(adminSignup, 'users/admin2-uid'), {
      uid: 'admin2-uid',
      email: ADMIN_EMAIL,
      displayName: '股長備用',
      role: 'admin',
      status: 'approved',
    }),
  ),
);

// ── 5. 解鎖專用帳號（權限最低，只碰得到解鎖工單）──
await check('解鎖專用帳號讀不到業務', assertFails(getDoc(doc(unlocker, 'tasks/task-1'))));
await check('解鎖專用帳號讀不到屬性', assertFails(getDocs(collection(unlocker, 'categories'))));
await check('解鎖專用帳號讀不到待辦公版', assertFails(getDocs(collection(unlocker, 'checklistTemplates'))));
await check('解鎖專用帳號讀不到假日清單', assertFails(getDoc(doc(unlocker, 'holidays/2027'))));
await check(
  '解鎖專用帳號不可新增業務',
  assertFails(
    addDoc(collection(unlocker, 'tasks'), { title: '偷加的', ownerUid: 'unlocker-uid' }),
  ),
);
await check(
  '解鎖專用帳號可送出自己的解鎖工單',
  assertSucceeds(
    addDoc(collection(unlocker, 'unlockRequests'), {
      temsis: '2026080110100310380001',
      reason: '補登處置',
      requestedBy: 'unlocker-uid',
      requestedByName: '某分隊',
      requestedAt: '2026-08-06T03:00:00.000Z',
      status: 'pending',
      result: null,
    }),
  ),
);
await check(
  '不可冒用他人名義送工單',
  assertFails(
    addDoc(collection(unlocker, 'unlockRequests'), {
      temsis: '2026080110100310380002',
      reason: '冒名',
      requestedBy: 'member-uid',
      requestedByName: '同事',
      requestedAt: '2026-08-06T03:00:00.000Z',
      status: 'pending',
      result: null,
    }),
  ),
);
await check(
  '不可直接送一張「已解鎖」的假工單',
  assertFails(
    addDoc(collection(unlocker, 'unlockRequests'), {
      temsis: '2026080110100310380003',
      reason: '假的',
      requestedBy: 'unlocker-uid',
      requestedByName: '某分隊',
      requestedAt: '2026-08-06T03:00:00.000Z',
      status: 'unlocked',
      result: null,
    }),
  ),
);
await check(
  '解鎖專用帳號讀得到自己送的工單',
  assertSucceeds(
    getDocs(query(collection(unlocker, 'unlockRequests'), where('requestedBy', '==', 'unlocker-uid'))),
  ),
);
await check(
  '解鎖專用帳號不可整包撈別人的工單',
  assertFails(getDocs(collection(unlocker, 'unlockRequests'))),
);
await check(
  '解鎖專用帳號讀不到別人送的那一筆',
  assertFails(getDoc(doc(unlocker, 'unlockRequests/req-others'))),
);
await check(
  '解鎖專用帳號不可自己回寫「已解鎖」',
  assertFails(updateDoc(doc(unlocker, 'unlockRequests/req-mine'), { status: 'unlocked' })),
);
await check(
  '一般使用者看得到所有工單（他才是去跑的人）',
  assertSucceeds(getDocs(collection(member, 'unlockRequests'))),
);
await check(
  '一般使用者可回寫解鎖結果',
  assertSucceeds(
    updateDoc(doc(member, 'unlockRequests/req-mine'), {
      status: 'unlocked',
      result: {
        caseDate: '2026/07/12 10:38:41',
        vehicle: '大湳93',
        squad: '大湳分隊',
        detail: '已解鎖',
        processedAt: '2026-08-06T04:00:00.000Z',
        processedBy: '股長',
      },
    }),
  ),
);
await check(
  '管理員可把工單退回待處理重跑（重新送單）',
  assertSucceeds(
    updateDoc(doc(admin, 'unlockRequests/req-mine'), { status: 'pending', result: null }),
  ),
);
await check(
  '回寫結果時不可竄改申請內容',
  assertFails(
    updateDoc(doc(member, 'unlockRequests/req-others'), {
      temsis: '改掉的編號',
      status: 'unlocked',
    }),
  ),
);
// 刪除會把文件變不見，因此這三項一定要排在其他用得到這兩張工單的檢查之後。
await check(
  '一般使用者不可刪除工單',
  assertFails(deleteDoc(doc(member, 'unlockRequests/req-mine'))),
);
await check(
  '解鎖專用帳號不可刪除自己送的工單',
  assertFails(deleteDoc(doc(unlocker, 'unlockRequests/req-mine'))),
);
await check(
  '管理員可刪除任何一張工單',
  assertSucceeds(deleteDoc(doc(admin, 'unlockRequests/req-others'))),
);
await check(
  '待審核帳號不可送出解鎖工單',
  assertFails(
    addDoc(collection(pending, 'unlockRequests'), {
      temsis: '2026080110100310380004',
      reason: '還沒核准',
      requestedBy: 'pending-uid',
      requestedByName: '待審核者',
      requestedAt: '2026-08-06T03:00:00.000Z',
      status: 'pending',
      result: null,
    }),
  ),
);

// ── 6. 測試用傷票（計數器 + 領取紀錄 + 單位週用量必須一起寫、互相對得上）──

/** 與 src/lib/triageTagNumber.ts 的 triageTagWeekIndex() 同算法（台灣時間、週一起算）。 */
const THIS_WEEK = Math.floor((Math.floor((Date.now() + 8 * 3_600_000) / 86_400_000) + 3) / 7);

/**
 * 模擬前端的一次領取：計數器往後推、單位本週用量加上去，同時建立一筆領取紀錄。
 * 各欄位都可以單獨竄改，用來測試規則擋不擋得住。
 */
function allocateTags(db, options) {
  const {
    before,
    count,
    requestedBy,
    unit = '大湳分隊',
    unitUsedBefore = 0,
    startSerial = before,
    advanceTo = before + count,
    usedAfter = unitUsedBefore + count,
    weekIndex = THIS_WEEK,
    writeUsage = true,
  } = options;
  const batch = writeBatch(db);
  batch.set(doc(db, 'triageTagCounter/main'), { nextSerial: advanceTo });
  if (writeUsage) {
    batch.set(doc(db, `triageTagUnitWeeks/${weekIndex}_${unit}`), {
      unit,
      weekIndex,
      used: usedAfter,
      lastStartSerial: startSerial,
    });
  }
  batch.set(doc(db, `triageTagIssues/${startSerial}`), {
    startSerial,
    count,
    unit,
    weekIndex,
    requestedBy,
    requestedByName: requestedBy,
    requestedAt: '2026-09-21T01:00:00.000Z',
  });
  return batch.commit();
}

await check(
  '解鎖專用帳號可領第一批傷票（H00T000 起 10 張，大湳分隊）',
  assertSucceeds(allocateTags(unlocker, { before: 0, count: 10, requestedBy: 'unlocker-uid' })),
);
await check(
  '一般使用者可接續領（H00T010 起 2 張，同單位累計 12 張）',
  assertSucceeds(allocateTags(member, { before: 10, count: 2, unitUsedBefore: 10, requestedBy: 'member-uid' })),
);
await check(
  '同單位一週超過 20 張會被擋（已 12 張再領 9 張）',
  assertFails(allocateTags(member, { before: 12, count: 9, unitUsedBefore: 12, requestedBy: 'member-uid' })),
);
await check(
  '不可少記單位用量（用量沒加上這次的張數）',
  assertFails(allocateTags(member, { before: 12, count: 9, unitUsedBefore: 12, usedAfter: 12, requestedBy: 'member-uid' })),
);
await check(
  '不可不寫單位用量就領（繞過每週上限）',
  assertFails(allocateTags(member, { before: 12, count: 9, unitUsedBefore: 12, writeUsage: false, requestedBy: 'member-uid' })),
);
await check(
  '不可把用量記到別的週（避開本週上限）',
  assertFails(allocateTags(member, { before: 12, count: 9, weekIndex: THIS_WEEK - 1, requestedBy: 'member-uid' })),
);
await check(
  '單位不是完整分隊名稱會被擋（大湳）',
  assertFails(allocateTags(member, { before: 12, count: 1, unit: '大湳', requestedBy: 'member-uid' })),
);
await check(
  '不在月報表名單上的分隊會被擋（台北分隊）',
  assertFails(allocateTags(member, { before: 12, count: 1, unit: '台北分隊', requestedBy: 'member-uid' })),
);
await check(
  '同單位剛好領滿 20 張可以（已 12 張再領 8 張）',
  assertSucceeds(allocateTags(member, { before: 12, count: 8, unitUsedBefore: 12, requestedBy: 'member-uid' })),
);
await check(
  '別的單位不受影響（龜山分隊領 5 張）',
  assertSucceeds(allocateTags(member, { before: 20, count: 5, unit: '龜山分隊', requestedBy: 'member-uid' })),
);
await check(
  '不可自己挑號碼（起始號不等於計數器的下一號）',
  assertFails(
    allocateTags(member, { before: 25, startSerial: 50, count: 2, advanceTo: 52, unit: '八德分隊', requestedBy: 'member-uid' }),
  ),
);
await check(
  '不可偷跳號（計數器推進的張數與紀錄不符）',
  assertFails(allocateTags(member, { before: 25, count: 2, advanceTo: 40, unit: '八德分隊', requestedBy: 'member-uid' })),
);
await check(
  '不可只推計數器不留領取紀錄',
  assertFails(setDoc(doc(member, 'triageTagCounter/main'), { nextSerial: 40 })),
);
await check(
  '不可冒用他人名義領取',
  assertFails(allocateTags(member, { before: 25, count: 1, unit: '八德分隊', requestedBy: 'unlocker-uid' })),
);
await check(
  '待審核帳號不可領傷票',
  assertFails(allocateTags(pending, { before: 25, count: 1, unit: '八德分隊', requestedBy: 'pending-uid' })),
);
await check(
  '任何已核准帳號讀得到單位本週用量',
  assertSucceeds(getDoc(doc(unlocker, `triageTagUnitWeeks/${THIS_WEEK}_大湳分隊`))),
);
await check(
  '解鎖專用帳號讀得到自己的領取紀錄',
  assertSucceeds(getDoc(doc(unlocker, 'triageTagIssues/0'))),
);
await check(
  '解鎖專用帳號讀不到別人的領取紀錄',
  assertFails(getDoc(doc(unlocker, 'triageTagIssues/10'))),
);
await check(
  '解鎖專用帳號帶上自己的條件可以查清單',
  assertSucceeds(getDocs(query(collection(unlocker, 'triageTagIssues'), where('requestedBy', '==', 'unlocker-uid')))),
);
await check(
  '解鎖專用帳號不帶條件查全部會被擋',
  assertFails(getDocs(collection(unlocker, 'triageTagIssues'))),
);
await check('一般使用者可看全部領取紀錄', assertSucceeds(getDocs(collection(member, 'triageTagIssues'))));
await check(
  '領取紀錄不可修改',
  assertFails(updateDoc(doc(admin, 'triageTagIssues/0'), { count: 1 })),
);
await check('計數器不可刪除（管理員也不行）', assertFails(deleteDoc(doc(admin, 'triageTagCounter/main'))));
await check(
  '一般使用者不可刪除單位用量',
  assertFails(deleteDoc(doc(member, `triageTagUnitWeeks/${THIS_WEEK}_大湳分隊`))),
);
await check('一般使用者不可刪除領取紀錄', assertFails(deleteDoc(doc(member, 'triageTagIssues/10'))));
await check('管理員可刪除領取紀錄', assertSucceeds(deleteDoc(doc(admin, 'triageTagIssues/10'))));

// ── 7. 未登入者 ──
const anon = testEnv.unauthenticatedContext().firestore();
await check('未登入者不可讀業務', assertFails(getDoc(doc(anon, 'tasks/task-1'))));
await check(
  '未登入者不可讀解鎖工單',
  assertFails(getDoc(doc(anon, 'unlockRequests/req-mine'))),
);

await testEnv.cleanup();

const failed = results.filter((item) => !item.ok);
for (const item of results) {
  console.log(`${item.ok ? '✅' : '❌'} ${item.name}${item.ok ? '' : ` → ${item.message}`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} 項通過`);
process.exit(failed.length === 0 ? 0 : 1);
