// Claude 채점 연결: API 키 없이 Claude(구독)가 채점하도록 ‘요청 묶음’을 만들고 ‘결과 파일’을 읽는다.
//  - 요청: request.json + 영역별 PDF  →  zip 한 개로 내려받거나, 연결한 ‘채점 폴더’에 바로 저장
//  - 결과: Claude가 GRADING.md 절차대로 만든 result.json 을 불러와 결과표에 반영
// ※ 양식(REQUEST_VERSION / RESULT_VERSION)을 바꾸면 CLAUDE.md 표, GRADING.md, examples/ 를 함께 고칠 것.

export const REQUEST_FORMAT = 'debate-pdf-grader-request';
export const REQUEST_VERSION = 2;
export const RESULT_FORMAT = 'debate-pdf-grader-result';
export const RESULT_VERSION = 2;
export const REQUESTS_DIR = '채점요청';

export const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+$/g, '').slice(0, 80) || '이름없음';
export const newRequestId = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

// ── zip (압축 없이 묶기: PDF는 이미 압축되어 있어 충분히 빠르고 작음) ──────────────
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
export function makeZip(entries) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const e of entries) {
    const name = enc.encode(e.name);
    const data = e.data instanceof Uint8Array ? e.data : enc.encode(String(e.data));
    const crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, time, true); h.setUint16(12, date, true); h.setUint32(14, crc, true);
    h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
    parts.push(h, name, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, time, true); c.setUint16(14, date, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    central.push(c, name);
    offset += 30 + name.length + data.length;
  }
  const cSize = central.reduce((s, x) => s + (x.byteLength ?? x.length), 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, cSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

// ── 채점 폴더 (Chrome/Edge 의 File System Access API) ──────────────────────────
export const folderSupported = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window;
const IDB = 'dpg-bridge';
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(IDB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => { resolve(req?.result); open.result.close(); };
      tx.onerror = () => { reject(tx.error); open.result.close(); };
    };
  });
}
export const saveDirHandle = (h) => idb('readwrite', (s) => (h ? s.put(h, 'dir') : s.delete('dir'))).catch(() => {});
export const loadDirHandle = () => idb('readonly', (s) => s.get('dir')).catch(() => null);
export async function dirPermission(h, ask) {
  if (!h) return 'none';
  const opts = { mode: 'readwrite' };
  try {
    let p = await h.queryPermission(opts);
    if (p !== 'granted' && ask) p = await h.requestPermission(opts);
    return p;
  } catch { return 'denied'; }
}
export async function writeFile(dir, path, data) {
  const parts = path.split('/');
  let d = dir;
  for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
  const fh = await d.getFileHandle(parts[parts.length - 1], { create: true });
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
}
async function getDir(dir, path) {
  let d = dir;
  for (const p of path.split('/').filter(Boolean)) d = await d.getDirectoryHandle(p);
  return d;
}
// 채점요청/<요청ID>/result*.json 을 모두 찾는다 → [{requestId, name, file}]
export async function findResults(dir) {
  const out = [];
  let root;
  try { root = await getDir(dir, REQUESTS_DIR); } catch { return out; }
  for await (const [reqId, h] of root.entries()) {
    if (h.kind !== 'directory') continue;
    for await (const [name, fh] of h.entries()) {
      if (fh.kind === 'file' && /^result.*\.json$/i.test(name)) out.push({ requestId: reqId, name, file: await fh.getFile() });
    }
  }
  return out;
}

// ── 결과 파일 읽기 (어떤 버전이든 현재 형식으로) ───────────────────────────────
export function normalizeResult(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('결과 파일 형식이 아니에요.');
  if (obj.format && obj.format !== RESULT_FORMAT) {
    if (obj.format === REQUEST_FORMAT) throw new Error('이 파일은 채점 ‘요청’ 파일이에요. Claude가 만든 결과 파일(result.json)을 골라 주세요.');
    throw new Error('이 프로그램의 채점 결과 파일이 아니에요.');
  }
  if (Number(obj.version) > RESULT_VERSION) throw new Error('더 새 버전 결과 파일이에요. 페이지를 새로고침(Ctrl+Shift+R)한 뒤 다시 불러와 주세요.');
  const files = Array.isArray(obj.files) ? obj.files : [];
  if (!files.length) throw new Error('결과 파일에 채점한 파일이 없어요.');
  const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  return {
    requestId: String(obj.requestId || ''),
    gradedAt: String(obj.gradedAt || ''),
    grader: String(obj.grader || 'Claude'),
    files: files.map((f) => ({
      fileId: String(f.fileId || ''),
      name: String(f.name || f.file || ''),
      section: String(f.section || f.sectionName || ''),
      sectionId: String(f.sectionId || ''),
      pages: num(f.pages),
      layout: ['duplex', 'simplex', 'set'].includes(f.layout) ? f.layout : null,
      students: (Array.isArray(f.students) ? f.students : []).map((s, i) => ({
        idx: i + 1,
        pages: Array.isArray(s.pages) ? s.pages.map(Number).filter((n) => n > 0) : [],
        studentId: String(s.studentId ?? '').replace(/\s/g, ''),
        name: String(s.name ?? '').trim(),
        status: ['ok', 'unreadable', 'blank'].includes(s.status) ? s.status : 'ok',
        // v2: deductions(감점 키워드), answer(그 항목에 학생이 쓴 답) — v1 파일에는 없으므로 빈 값
        scores: (Array.isArray(s.scores) ? s.scores : []).map((x) => ({
          name: String(x.name || ''), score: num(x.score), comment: String(x.comment || ''),
          deductions: (Array.isArray(x.deductions) ? x.deductions : []).map((d) => (typeof d === 'string' ? { keyword: d, points: null } : { keyword: String(d?.keyword || d?.reason || '').slice(0, 40), points: num(d?.points) })).filter((d) => d.keyword),
          answer: String(x.answer || ''),
        })),
        total: num(s.total),
        comment: String(s.comment || ''),
        answer: String(s.answer || ''),
      })),
    })),
  };
}
