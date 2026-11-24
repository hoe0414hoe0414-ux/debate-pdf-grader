// PDF 판독 + 채점 엔진 (데모)
// ─────────────────────────────────────────────────────────────────────────────
// 지금은 데모 모드입니다.
//  · 글자가 들어 있는 PDF(한글/워드에서 저장한 PDF): 실제로 글을 읽어 기준별 키워드와 분량으로 점수를 냅니다.
//  · 스캔본(사진) PDF: 손글씨 인식(OCR)·AI 연결 전이므로 파일마다 고정된 '데모 점수'를 보여 줍니다.
//    판독이 어려운 경우를 보여 주기 위해 일부 파일은 (채점 불가)로 표시됩니다.
// 실제 AI를 붙일 때는 아래 aiGrade() 한 곳만 바꾸면 됩니다. API 키는 절대 이 파일(공개 저장소)에 넣지 마세요.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_PAGES = 300;         // 한 파일에서 읽을 최대 쪽수 (반 전체를 한 번에 스캔한 파일 대비)
const MIN_TEXT_CHARS = 40;     // 이보다 글자가 적으면 스캔본으로 간주

const CMAP_URL = new URL('./vendor/pdfjs/cmaps/', import.meta.url).href; // 한글 등 CJK 글꼴 글자 해석용 (필요한 파일만 받아옴)
let pdfjsPromise = null;
let sharedWorker = null;
// pdf.js는 처음 채점할 때만 불러온다 → 첫 화면 로딩이 가볍다.
export function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('./vendor/pdfjs/pdf.min.js').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.js', import.meta.url).href;
      // 작업 스레드 하나를 계속 재사용 → 파일마다 엔진을 새로 띄우지 않아 빠르다
      sharedWorker = new lib.PDFWorker({ name: 'dpg' });
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

// ── 양면/단면 판단 ──────────────────────────────────────────────────────────
// 글자가 있는 PDF: 학번이 적힌 쪽이 새 학생의 시작. 학번 없는 쪽(양면의 뒷면)은 앞 학생에 붙는다.
// 스캔본: 앞쪽 몇 장만 아주 작게(가로 40px) 그려서 비교한다.
//   양면이면 앞면(학번·이름 칸) - 뒷면 - 앞면 - 뒷면 … 처럼 한 장 건너 모양이 닮고, 바로 옆 장과는 다르다.
//   단면이면 모든 장이 같은 양식이라 서로 닮는다. 비어 있는 뒷면도 이 방법으로 잡힌다.
const THUMB_W = 40;
const SAMPLE_PAGES = 8;

async function pageThumb(page) {
  const vp1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: THUMB_W / vp1.width });
  const w = THUMB_W, h = Math.max(1, Math.round(vp.height));
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  await page.render({ canvasContext: ctx, viewport: vp, intent: 'display' }).promise;
  const px = ctx.getImageData(0, 0, w, h).data;
  const ink = new Float32Array(w * h);
  let total = 0;
  for (let i = 0; i < ink.length; i++) { const v = 1 - (px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114) / 255; ink[i] = v; total += v; }
  return { ink, w, h, inkRatio: total / ink.length };
}
// 윗부분(학번·이름 칸이 있는 곳) 35%의 모양 차이
function headDiff(a, b) {
  const rows = Math.floor(Math.min(a.h, b.h) * 0.35);
  let d = 0;
  for (let y = 0; y < rows; y++) for (let x = 0; x < a.w; x++) d += Math.abs(a.ink[y * a.w + x] - b.ink[y * b.w + x]);
  return d / Math.max(1, rows * a.w);
}
export function guessLayoutFromThumbs(th) {
  const n = th.length;
  if (n < 2) return { layout: 'simplex', reason: '1쪽짜리 파일' };
  const blankBacks = th.filter((t, i) => i % 2 === 1 && t.inkRatio < 0.012).length;
  if (blankBacks && blankBacks >= Math.floor(n / 2)) return { layout: 'duplex', reason: '뒷면이 비어 있는 양면 스캔' };
  if (n === 2) {
    const d = headDiff(th[0], th[1]);
    if (globalThis.__dpgDebug) console.log('headDiff2', d);
    return d > 0.016 ? { layout: 'duplex', reason: '앞뒤 두 쪽의 양식이 서로 다름' } : { layout: 'simplex', reason: '두 쪽의 양식이 같음' };
  }
  let adj = 0, na = 0, skip = 0, ns = 0;
  for (let i = 0; i + 1 < n; i++) { adj += headDiff(th[i], th[i + 1]); na++; }
  for (let i = 0; i + 2 < n; i++) { skip += headDiff(th[i], th[i + 2]); ns++; }
  adj /= na; skip /= ns;
  if (globalThis.__dpgDebug) console.log('adj/skip', adj, skip);
  return adj > skip * 1.6 + 0.004
    ? { layout: 'duplex', reason: '한 장 건너 양식이 반복됨' }
    : { layout: 'simplex', reason: '모든 쪽의 양식이 같음' };
}

export function groupPages(pageCount, layout) {
  const size = layout === 'duplex' ? 2 : 1;
  const groups = [];
  for (let p = 1; p <= pageCount; p += size) groups.push(Array.from({ length: Math.min(size, pageCount - p + 1) }, (_, i) => p + i));
  return groups;
}

const countIdPages = (texts, digits) => texts.reduce((n, t) => n + (extractStudentId(t, digits) ? 1 : 0), 0);

async function readPdf(file, { layout, idDigits }, signal) {
  const fileName = file.name;
  const buf = await file.arrayBuffer();
  if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
  const head = new TextDecoder('latin1').decode(new Uint8Array(buf, 0, Math.min(1024, buf.byteLength)));
  if (!head.includes('%PDF-')) throw new GradeError('PDF 형식이 아니에요');

  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(buf), worker: sharedWorker, cMapUrl: CMAP_URL, cMapPacked: true, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, stopAtErrors: false });
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
    const pageCount = Math.min(doc.numPages, MAX_PAGES);
    const texts = [];
    for (let p = 1; p <= pageCount; p++) {
      if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      let s = '';
      for (const it of tc.items) { if ('str' in it) s += it.str + (it.hasEOL ? '\n' : ''); }
      texts.push(s.replace(/[ \t]+/g, ' ').trim());
      page.cleanup();
    }
    const textPages = texts.filter((t) => t.replace(/\s/g, '').length >= MIN_TEXT_CHARS).length;
    const hasText = textPages >= Math.ceil(pageCount / 2);

    let groups, detected = null;
    if (layout === 'duplex' || layout === 'simplex') {
      groups = groupPages(pageCount, layout);
    } else if (hasText && countIdPages(texts, idDigits) >= 2) {
      // 학번이 적힌 쪽마다 새 학생
      const starts = [];
      texts.forEach((t, i) => { if (extractStudentId(t, idDigits)) starts.push(i + 1); });
      {
        groups = [];
        starts.forEach((st, i) => {
          const from = i === 0 ? 1 : st;
          const to = i + 1 < starts.length ? starts[i + 1] - 1 : pageCount;
          groups.push(Array.from({ length: to - from + 1 }, (_, k) => from + k));
        });
        const sizes = new Set(groups.map((g) => g.length));
        detected = { layout: sizes.size === 1 && sizes.has(1) ? 'simplex' : 'duplex', reason: '쪽마다 적힌 학번으로 학생을 나눔' };
      }
    } else if (hasText || extractStudentId(fileName, idDigits) || pageCount === 1) {
      // 파일 이름에 학번이 있거나 본문에 학번이 한 번뿐 → 학생 한 명의 파일
      groups = [Array.from({ length: pageCount }, (_, k) => k + 1)];
      detected = { layout: pageCount >= 2 ? 'duplex' : 'simplex', reason: pageCount === 1 ? '1쪽짜리 파일' : extractStudentId(fileName, idDigits) ? '파일 이름에 학번이 있어 학생 한 명의 파일로 봄' : '학번이 한 번만 나와 학생 한 명으로 봄' };
    } else {
      const k = Math.min(pageCount, SAMPLE_PAGES);
      const th = [];
      for (let p = 1; p <= k; p++) {
        if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
        const page = await doc.getPage(p);
        th.push(await pageThumb(page));
        page.cleanup();
      }
      detected = guessLayoutFromThumbs(th);
      groups = groupPages(pageCount, detected.layout);
    }
    return { pageCount, totalPages: doc.numPages, texts, hasText, groups, detected };
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
// prompt: 선생님이 쓴 채점 기준 전체(자유 서술). criteria: 그 안에서 뽑은 결과표 열(항목·배점). pages: 이 학생의 쪽 번호 배열
async function aiGrade(/* { file, pages, text, prompt, criteria, notes, signal } */) {
  return null;
}

const pageLabel = (pages) => (pages.length === 1 ? `${pages[0]}쪽` : `${pages[0]}~${pages[pages.length - 1]}쪽`);

/**
 * 파일 하나를 읽어 학생별로 나누고 채점한다.
 * layout: 'auto' | 'duplex'(양면: 2쪽=1명) | 'simplex'(단면: 1쪽=1명)
 */
export async function gradeFile(file, { criteria, prompt = '', idDigits, notes, layout = 'auto' }, signal) {
  const { pageCount, totalPages, texts, hasText, groups, detected } = await readPdf(file, { layout, idDigits }, signal);
  const effLayout = detected ? detected.layout : layout;
  const single = groups.length === 1;
  const students = [];
  for (let i = 0; i < groups.length; i++) {
    const pages = groups[i];
    const text = pages.map((p) => texts[p - 1]).join('\n').trim();
    const studentId = extractStudentId(text, idDigits) || (single ? extractStudentId(file.name, idDigits) : '');
    const name = single ? extractName(file.name, text) : extractName('', text);
    const stText = text.replace(/\s/g, '').length >= MIN_TEXT_CHARS;

    let scores = await aiGrade({ file, pages, text, prompt, criteria, notes, signal });
    let mode = 'ai';
    if (!scores) {
      if (stText) { scores = heuristicGrade(text, criteria); mode = 'text'; }
      else { scores = demoScanGrade(`${file.name}|${file.size}|${totalPages}|${pages.join(',')}`, criteria); mode = 'scan-demo'; }
    }
    const base = { idx: i + 1, pages, pageLabel: pageLabel(pages), studentId, name, mode, textPreview: text.slice(0, 3000) };
    if (!scores) {
      students.push({ ...base, status: 'fail', reason: '학생이 쓴 글씨를 해석할 수 없어요', scores: criteria.map((c) => ({ name: c.name, points: c.points, score: null, comment: '판독 불가' })), total: null });
    } else {
      students.push({ ...base, status: 'success', scores, total: roundHalf(scores.reduce((s, x) => s + x.score, 0)) });
    }
  }
  return {
    pages: totalPages, readPages: pageCount, hasText,
    layout: effLayout, layoutAuto: !!detected, layoutReason: detected?.reason || '직접 지정',
    students,
  };
}
