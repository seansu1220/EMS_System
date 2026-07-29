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
 */
import { readFileSync } from 'node:fs';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc, collection } from 'firebase/firestore';

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

// ── 5. 未登入者 ──
const anon = testEnv.unauthenticatedContext().firestore();
await check('未登入者不可讀業務', assertFails(getDoc(doc(anon, 'tasks/task-1'))));

await testEnv.cleanup();

const failed = results.filter((item) => !item.ok);
for (const item of results) {
  console.log(`${item.ok ? '✅' : '❌'} ${item.name}${item.ok ? '' : ` → ${item.message}`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} 項通過`);
process.exit(failed.length === 0 ? 0 : 1);
