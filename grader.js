// PDF 판독 + 채점 엔진 (데모)
// ─────────────────────────────────────────────────────────────────────────────
// 지금은 데모 모드입니다.
//  · 글자가 들어 있는 PDF(한글/워드에서 저장한 PDF): 실제로 글을 읽어 기준별 키워드와 분량으로 점수를 냅니다.
//  · 스캔본(사진) PDF: 손글씨 인식(OCR)·AI 연결 전이므로 파일마다 고정된 '데모 점수'를 보여 줍니다.
//    판독이 어려운 경우를 보여 주기 위해 일부 파일은 (채점 불가)로 표시됩니다.
// 실제 AI를 붙일 때는 아래 aiGrade() 한 곳만 바꾸면 됩니다. API 키는 절대 이 파일(공개 저장소)에 넣지 마세요.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_PAGES = 30;          // 한 파일에서 읽을 최대 쪽수 (속도 보호)
const MIN_TEXT_CHARS = 40;     // 이보다 글자가 적으면 스캔본으로 간주

const CMAP_URL = new URL('./vendor/pdfjs/cmaps/', import.meta.url).href; // 한글 등 CJK 글꼴 글자 해석용 (필요한 파일만 받아옴)
let pdfjsPromise = null;
// pdf.js는 처음 채점할 때만 불러온다 → 첫 화면 로딩이 가볍다.
export function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('./vendor/pdfjs/pdf.min.js').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.js', import.meta.url).href;
      return lib;
    }).catch((e) => { pdfjsPromise = null; throw e; });
  }
  return pdfjsPromise;
}

export class GradeError extends Error {}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const roundHalf = (n) => Math.round(n * 2) / 2;

export function extractStudentId(text, digits) {
  if (!text) return '';
  const re = new RegExp(`(?<!\\d)(\\d{${digits}})(?!\\d)`);
  const m = String(text).match(re);
  return m ? m[1] : '';
}

const NAME_STOP = new Set(['토론', '수행', '평가', '수행평가', '입론', '입론서', '반론', '최종', '제출', '학번', '이름', '성명', '과제', '스캔', '사본', '국어', '찬성', '반대', '개요', '보고서']);
export function extractName(fileName, text) {
  const base = fileName.replace(/\.pdf$/i, '');
  const runs = base.match(/[가-힣]{2,4}/g) || [];
  const hit = runs.find((r) => !NAME_STOP.has(r));
  if (hit) return hit;
  if (text) {
    const m = text.match(/(?:이름|성명)\s*[:：]?\s*([가-힣]{2,4})/);
    if (m) return m[1];
  }
  return '';
}

async function readPdf(file, signal) {
  const buf = await file.arrayBuffer();
  if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
  const head = new TextDecoder('latin1').decode(new Uint8Array(buf, 0, Math.min(1024, buf.byteLength)));
  if (!head.includes('%PDF-')) throw new GradeError('PDF 형식이 아니에요');

  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(buf), cMapUrl: CMAP_URL, cMapPacked: true, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, stopAtErrors: false });
  const onAbort = () => task.destroy();
  signal?.addEventListener('abort', onAbort, { once: true });
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
    if (e?.name === 'PasswordException') throw new GradeError('암호가 걸린 PDF라 열 수 없어요');
    throw new GradeError('파일이 손상되어 열 수 없어요');
  }
  try {
    const pages = doc.numPages;
    const n = Math.min(pages, MAX_PAGES);
    const parts = [];
    for (let p = 1; p <= n; p++) {
      if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      let s = '';
      for (const it of tc.items) { if ('str' in it) s += it.str + (it.hasEOL ? '\n' : ''); }
      parts.push(s);
      page.cleanup();
    }
    return { pages, text: parts.join('\n').replace(/[ \t]+/g, ' ').trim() };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    doc.destroy();
  }
}

// 기준 문장에서 핵심어를 뽑는다 (아주 단순한 데모용)
const JOSA = /(으로서|으로써|에서는|에게서|하는가|되는가|인가|이며|이고|으로|에서|에게|하여|하고|하며|이다|있는가|는가|은|는|이|가|을|를|의|에|와|과|도|로)$/;
function keywords(item) {
  const words = `${item.name} ${item.desc}`.match(/[가-힣A-Za-z]{2,}/g) || [];
  const out = new Set();
  for (let w of words) { w = w.replace(JOSA, ''); if (w.length >= 2 && !NAME_STOP.has(w)) out.add(w); }
  return [...out];
}

function heuristicGrade(text, criteria) {
  const len = text.replace(/\s/g, '').length;
  const lengthFactor = Math.min(1, len / 1200);
  return criteria.map((c) => {
    const kws = keywords(c);
    const hits = kws.filter((k) => text.includes(k));
    const ratio = kws.length ? hits.length / kws.length : 0.5;
    const score = Math.min(c.points, roundHalf(c.points * Math.min(1, 0.35 + 0.35 * lengthFactor + 0.3 * ratio)));
    const comment = `글 분량 ${len.toLocaleString()}자 · 기준 핵심어 ${hits.length}/${kws.length}개 발견${hits.length ? ` (${hits.slice(0, 4).join(', ')})` : ''}`;
    return { name: c.name, points: c.points, score, comment };
  });
}

function demoScanGrade(seedStr, criteria) {
  const r = rng(fnv1a(seedStr));
  if (r() < 0.15) return null; // 판독 불가 예시
  return criteria.map((c) => {
    const score = roundHalf(c.points * (0.55 + r() * 0.43));
    return { name: c.name, points: c.points, score: Math.min(c.points, score), comment: '스캔본 · 데모 점수 (실제 AI 연결 전)' };
  });
}

/**
 * 실제 AI/OCR 연결 지점.
 * 나중에 서버(예: Cloudflare Worker, Apps Script)를 하나 두고 그곳에서 API 키를 보관한 뒤,
 * 여기서 fetch로 { 기준, 참고사항, PDF 텍스트 또는 페이지 이미지 }를 보내 점수를 받아오면 됩니다.
 * null을 돌려주면 아래 데모 채점이 사용됩니다.
 */
async function aiGrade(/* { file, text, criteria, notes, signal } */) {
  return null;
}

export async function gradeFile(file, { criteria, idDigits, notes }, signal) {
  const { pages, text } = await readPdf(file, signal);
  const studentId = extractStudentId(file.name, idDigits) || extractStudentId(text, idDigits);
  const name = extractName(file.name, text);
  const hasText = text.replace(/\s/g, '').length >= MIN_TEXT_CHARS;

  let scores = await aiGrade({ file, text, criteria, notes, signal });
  let mode = 'ai';
  if (!scores) {
    if (hasText) { scores = heuristicGrade(text, criteria); mode = 'text'; }
    else { scores = demoScanGrade(`${file.name}|${file.size}|${pages}`, criteria); mode = 'scan-demo'; }
  }
  const base = { studentId, name, pages, mode, textPreview: text.slice(0, 3000) };
  if (!scores) return { ...base, status: 'fail', reason: '학생이 쓴 글씨를 해석할 수 없어요', scores: criteria.map((c) => ({ name: c.name, points: c.points, score: null, comment: '판독 불가' })), total: null };
  const total = roundHalf(scores.reduce((s, x) => s + x.score, 0));
  return { ...base, status: 'success', scores, total };
}
