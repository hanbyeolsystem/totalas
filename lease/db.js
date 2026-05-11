// IndexedDB 첨부 이미지 저장소 (사업자등록증 / 명함 / 신분증 / 통장사본 등)
// localStorage 5MB 제한 우회 + 큰 이미지 안전 보관
'use strict';

const DB_NAME = 'rental_mgmt_db';
const DB_VERSION = 2;
const STORE_ATTACH = 'attachments';
const STORE_BLOB = 'blob_files';   // 음성/문서 등 큰 파일 (Blob)

let _dbPromise = null;

function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_ATTACH)) {
        const s = db.createObjectStore(STORE_ATTACH, { keyPath: 'id' });
        s.createIndex('customer_id', 'customer_id', { unique: false });
        s.createIndex('type', 'type', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_BLOB)) {
        const s = db.createObjectStore(STORE_BLOB, { keyPath: 'id' });
        s.createIndex('customer_id', 'customer_id', { unique: false });
        s.createIndex('kind', 'kind', { unique: false });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
  return _dbPromise;
}

async function attPut(rec) {
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE_ATTACH, 'readwrite');
    tx.objectStore(STORE_ATTACH).put(rec);
    tx.oncomplete = () => res(rec);
    tx.onerror = () => rej(tx.error);
  });
}

async function attGet(id) {
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE_ATTACH, 'readonly');
    const req = tx.objectStore(STORE_ATTACH).get(id);
    req.onsuccess = () => res(req.result || null);
    req.onerror = () => rej(req.error);
  });
}

async function attDel(id) {
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE_ATTACH, 'readwrite');
    tx.objectStore(STORE_ATTACH).delete(id);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

async function attListByCustomer(customerId) {
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE_ATTACH, 'readonly');
    const idx = tx.objectStore(STORE_ATTACH).index('customer_id');
    const req = idx.getAll(customerId);
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => rej(req.error);
  });
}

async function attAll() {
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE_ATTACH, 'readonly');
    const req = tx.objectStore(STORE_ATTACH).getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => rej(req.error);
  });
}

async function attDelByCustomer(customerId) {
  const list = await attListByCustomer(customerId);
  for (const a of list) await attDel(a.id);
}

window.attDB = {
  put: attPut,
  get: attGet,
  del: attDel,
  delByCustomer: attDelByCustomer,
  listByCustomer: attListByCustomer,
  all: attAll,
};

// === Blob 저장소 (음성, 일반 파일) ===
async function blobPut(rec) {
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE_BLOB, 'readwrite');
    tx.objectStore(STORE_BLOB).put(rec);
    tx.oncomplete = () => res(rec);
    tx.onerror = () => rej(tx.error);
  });
}
async function blobGet(id) {
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE_BLOB, 'readonly');
    const req = tx.objectStore(STORE_BLOB).get(id);
    req.onsuccess = () => res(req.result || null);
    req.onerror = () => rej(req.error);
  });
}
async function blobDel(id) {
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE_BLOB, 'readwrite');
    tx.objectStore(STORE_BLOB).delete(id);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function blobListByCustomer(customerId, kind) {
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE_BLOB, 'readonly');
    const idx = tx.objectStore(STORE_BLOB).index('customer_id');
    const req = idx.getAll(customerId);
    req.onsuccess = () => {
      const all = req.result || [];
      res(kind ? all.filter(x => x.kind === kind) : all);
    };
    req.onerror = () => rej(req.error);
  });
}
async function blobAllByKind(kind) {
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE_BLOB, 'readonly');
    const idx = tx.objectStore(STORE_BLOB).index('kind');
    const req = idx.getAll(kind);
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => rej(req.error);
  });
}
async function blobAll() {
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE_BLOB, 'readonly');
    const req = tx.objectStore(STORE_BLOB).getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => rej(req.error);
  });
}

window.blobDB = {
  put: blobPut,
  get: blobGet,
  del: blobDel,
  listByCustomer: blobListByCustomer,
  allByKind: blobAllByKind,
  all: blobAll,
};

// 자료실 카테고리 정의
window.ARCHIVE_CATEGORIES = [
  { key: 'contract', label: '계약서',     icon: '📋' },
  { key: 'manual',   label: '메뉴얼',     icon: '📖' },
  { key: 'promo',    label: '홍보물',     icon: '🎨' },
  { key: 'biz_doc',  label: '고객사업자', icon: '🏢' },
  { key: 'etc',      label: '기타',       icon: '📎' },
];

// 첨부 종류 정의 (UI용)
window.ATTACHMENT_TYPES = [
  { key: 'business_license', label: '사업자등록증', icon: '🏢', required: false },
  { key: 'business_card',    label: '명함',         icon: '📇', required: false },
  { key: 'id_card',          label: '신분증',       icon: '🪪', required: false },
  { key: 'bankbook',         label: '통장사본',     icon: '🏦', required: false },
];
