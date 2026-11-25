import { computeTotal, defaultRubric, shortReason } from './criteria.js?v=10';
// PDF 판독 + 채점 엔진 (데모)
// ─────────────────────────────────────────────────────────────────────────────
// 지금은 데모 모드입니다.
//  · 글자가 들어 있는 PDF(한글/워드에서 저장한 PDF): 실제로 글을 읽어 기준별 키워드와 분량으로 점수를 냅니다.
//  · 손글씨 스캔본 PDF: 브라우저에서는 글씨를 읽을 수 없으므로 학생 나누기(몇 쪽이 한 명인지)까지만 하고,
//    학번·이름·점수는 ‘Claude 채점’ 결과를 불러와 채운다. (가짜 점수를 만들지 않음)
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

// 답안지 보기 창에서 쓰는 PDF 열기 (채점 때와 같은 작업 스레드 사용)
export async function openPdf(file) {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  return pdfjs.getDocument({ data, worker: sharedWorker, cMapUrl: CMAP_URL, cMapPacked: true, isEvalSupported: false, stopAtErrors: false }).promise;
}

const roundHalf = (n) => Math.round(n * 2) / 2;

// 학번 = 학년(1자리) + 반 + 번호(2자리)
//   5자리: 20301 → 2학년 03반 01번      4자리: 2301 → 2학년 3반 01번
const validId = (id, digits) => {
  const g = +id[0], c = +id.slice(1, digits - 2), n = +id.slice(-2);
  return g >= 1 && g <= 6 && c >= 1 && n >= 1 && n <= 60;
};
export function extractStudentId(text, digits) {
  if (!text) return '';
  const src = String(text);
  // “2학년 3반 1번”처럼 풀어 쓴 경우도 학번으로 바꿔 준다
  const k = src.match(/([1-6])\s*학년\s*(\d{1,2})\s*반\s*(\d{1,2})\s*번/);
  if (k && (digits === 5 || +k[2] < 10)) {
    return k[1] + (digits === 5 ? k[2].padStart(2, '0') : String(+k[2])) + k[3].padStart(2, '0');
  }
  const re = new RegExp(`(?<!\\d)(\\d{${digits}})(?!\\d)`, 'g');
  let first = '';
  for (const m of src.matchAll(re)) {
    if (validId(m[1], digits)) return m[1]; // 학년·반·번호 규칙에 맞는 숫자를 우선
    if (!first) first = m[1];
  }
  return first;
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

// ── 학생 한 명의 답안지 세트(몇 쪽마다 반복되는지) 판단 ───────────────────────────
// 글자가 있는 PDF: 학번이 적힌 쪽이 새 학생의 시작. 학번 없는 쪽(양면의 뒷면)은 앞 학생에 붙는다.
// 스캔본: 앞쪽 여러 장을 아주 작게 그려서 ‘양식 모양’을 비교한다.
//   답안지 세트가 P쪽이면 P쪽 떨어진 쪽끼리는 같은 양식이라 닮고, 세트 안의 다른 쪽과는 다르다.
//   (양면 = 2쪽 세트, 단면 = 1쪽, 3~6쪽짜리 세트도 찾는다. 비어 있는 뒷면도 같은 방법으로 잡힌다.)
const THUMB_W = 48;
const SAMPLE_PAGES = 24;
const MAX_PERIOD = 6;

async function pageThumb(page) {
  const vp1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: THUMB_W / vp1.width });
  const w = THUMB_W, h = Math.max(1, Math.round(vp.height));
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  await page.render({ canvasContext: ctx, viewport: vp, intent: 'display' }).promise;
  const px = ctx.getImageData(0, 0, w, h).data;
  const raw = new Float32Array(w * h);
  let total = 0;
  for (let i = 0; i < raw.length; i++) { raw[i] = 1 - (px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114) / 255; total += raw[i]; }
  // 스캔할 때 종이가 조금 밀리거나 기울어도 같은 양식으로 보이도록 살짝 흐리게 + 밝기 차이 보정
  const ink = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let sum = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy >= 0 && yy < h && xx >= 0 && xx < w) { sum += raw[yy * w + xx]; n++; }
    }
    ink[y * w + x] = sum / n;
  }
  const mean = total / raw.length;
  let v = 0;
  for (let i = 0; i < ink.length; i++) { ink[i] -= mean; v += ink[i] * ink[i]; }
  return { ink, w, h, inkRatio: mean, std: Math.sqrt(v / ink.length) };
}
// 두 쪽의 양식 모양 차이 (0 = 똑같음). 스캔이 1~2칸 밀린 것은 가장 잘 맞는 위치로 맞춰 비교한다.
const isBlankThumb = (t) => t.std < 0.012;
function pageDiff(a, b, headOnly = false) {
  const blankA = isBlankThumb(a), blankB = isBlankThumb(b);
  if (blankA && blankB) return 0;
  if (blankA !== blankB) return 0.2; // 빈 쪽과 글 있는 쪽은 확실히 다른 양식
  const w = Math.min(a.w, b.w), m = 2;
  const h = Math.round(Math.min(a.h, b.h) * (headOnly ? 0.3 : 1)); // 학번·이름 칸이 있는 윗부분만 보기도 한다
  let best = Infinity;
  for (let dy = -m; dy <= m; dy++) for (let dx = -m; dx <= m; dx++) {
    let d = 0, n = 0;
    for (let y = m; y < h - m; y++) {
      const ra = y * a.w, rb = (y + dy) * b.w + dx;
      for (let x = m; x < w - m; x++) { d += Math.abs(a.ink[ra + x] - b.ink[rb + x]); n++; }
    }
    if (n) best = Math.min(best, d / n);
  }
  return best;
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

// 거리 P마다 닮은 정도로 세트 길이를 고른다
function findPeriod(n, dist) {
  let best = { per: 1, score: 0 };
  const cands = [];
  for (let P = 2; P <= Math.min(MAX_PERIOD, Math.floor(n / 2)); P++) {
    const same = [], diff = [];
    for (let i = 0; i + P < n; i++) same.push(dist(i, i + P));
    for (let i = 0; i < n; i++) for (let k = 1; k < P && i + k < n; k++) diff.push(dist(i, i + k));
    const s = median(same), d = median(diff);
    const score = (d - s) / (s + 0.004);
    cands.push({ P, s, d, score });
    if (d - s > 0.006 && score > 0.5 && score > best.score * 1.15) best = { per: P, score };
  }
  // 배수(4, 6…)보다 짧은 세트가 거의 같은 점수면 짧은 쪽
  for (const c of cands) if (c.P < best.per && best.per % c.P === 0 && c.d - c.s > 0.006 && c.score >= best.score * 0.8) { best = { per: c.P, score: c.score }; break; }
  if (globalThis.__dpgDebug) console.log('period', JSON.stringify(cands.map((c) => [c.P, +c.s.toFixed(4), +c.d.toFixed(4), +c.score.toFixed(2)])), '→', best.per);
  return best;
}

/** 썸네일 목록 → { per: 한 학생의 쪽수, layout, reason } */
export function guessLayoutFromThumbs(th, pageCount = th.length) {
  const n = th.length;
  if (n < 2) return { per: 1, layout: 'simplex', reason: '1쪽짜리 파일' };
  const memo = (head) => { const m = new Map(); return (i, j) => { const k = i * 1000 + j; if (!m.has(k)) m.set(k, pageDiff(th[i], th[j], head)); return m.get(k); }; };
  const full = memo(false), head = memo(true);
  if (n === 2) {
    const d = Math.max(full(0, 1), head(0, 1) * 0.8);
    if (globalThis.__dpgDebug) console.log('diff2', d);
    return d > 0.03 ? { per: 2, layout: 'duplex', reason: '앞뒤 두 쪽의 양식이 서로 다름' } : { per: 1, layout: 'simplex', reason: '두 쪽의 양식이 같음' };
  }
  // 쪽 전체 모양과, 학번·이름 칸이 있는 윗부분 모양을 각각 보고 더 뚜렷한 쪽을 따른다
  const a = findPeriod(n, full), b = findPeriod(n, head);
  const P = (b.score > a.score * 1.3 ? b : a).per;
  const odd = pageCount % P ? ` (전체 ${pageCount}쪽이 ${P}쪽씩 딱 나누어떨어지지 않음 — 확인 필요)` : '';
  if (P === 1) return { per: 1, layout: 'simplex', reason: '모든 쪽의 양식이 같아 1쪽 = 학생 1명' };
  const blankBack = P === 2 && th.filter((t, i) => i % 2 === 1 && isBlankThumb(t)).length >= Math.floor(n / 2);
  return {
    per: P,
    layout: P === 2 ? 'duplex' : 'set',
    reason: (blankBack ? '뒷면이 비어 있는 양면 스캔' : P === 2 ? '앞·뒷면 양식이 2쪽마다 반복됨' : `답안지 양식이 ${P}쪽마다 반복됨`) + ` → 학생 ${Math.ceil(pageCount / P)}명` + odd,
  };
}

export function groupPages(pageCount, layout, per) {
  const size = per || (layout === 'duplex' ? 2 : 1);
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
        const one = sizes.size === 1 ? [...sizes][0] : null;
        detected = { per: one, layout: one === 1 ? 'simplex' : one === 2 || !one ? 'duplex' : 'set', reason: '쪽마다 적힌 학번으로 학생을 나눔' };
      }
    } else if (hasText || extractStudentId(fileName, idDigits) || pageCount === 1) {
      // 파일 이름에 학번이 있거나 본문에 학번이 한 번뿐 → 학생 한 명의 파일
      groups = [Array.from({ length: pageCount }, (_, k) => k + 1)];
      detected = { per: pageCount, layout: pageCount === 1 ? 'simplex' : pageCount === 2 ? 'duplex' : 'set', reason: pageCount === 1 ? '1쪽짜리 파일' : extractStudentId(fileName, idDigits) ? '파일 이름에 학번이 있어 학생 한 명의 파일로 봄' : '학번이 한 번만 나와 학생 한 명으로 봄' };
    } else {
      const k = Math.min(pageCount, SAMPLE_PAGES);
      const th = [];
      for (let p = 1; p <= k; p++) {
        if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
        const page = await doc.getPage(p);
        th.push(await pageThumb(page));
        page.cleanup();
      }
      detected = guessLayoutFromThumbs(th, pageCount);
      groups = groupPages(pageCount, detected.layout, detected.per);
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

function heuristicGrade(text, criteria, rubric) {
  const len = text.replace(/\s/g, '').length;
  const lengthFactor = Math.min(1, len / 1200);
  return criteria.map((c) => {
    const kws = keywords(c);
    const hits = kws.filter((k) => text.includes(k));
    const ratio = kws.length ? hits.length / kws.length : 0.5;
    if (rubric.mode === 'deduct') {
      // 데모: 핵심어가 적거나 글이 짧으면 그 항목의 감점 규칙을 앞에서부터 적용
      const q = 0.5 * ratio + 0.5 * lengthFactor;
      const n = c.deductions.length ? Math.min(c.deductions.length, Math.round((1 - q) * c.deductions.length)) : 0;
      const used = c.deductions.slice(0, n).map((d) => ({ keyword: d.keyword || shortReason(d.text, c.name), points: -d.pts }));
      return { name: c.name, points: c.points, score: used.reduce((s, d) => s + d.points, 0), deductions: used, comment: used.length ? used.map((d) => d.keyword).join(', ') : '' };
    }
    const score = Math.min(c.points, roundHalf(c.points * Math.min(1, 0.35 + 0.35 * lengthFactor + 0.3 * ratio)));
    const comment = `분량 ${len.toLocaleString()}자 · 핵심어 ${hits.length}/${kws.length}${hits.length ? ` (${hits.slice(0, 3).join(', ')})` : ''}`;
    return { name: c.name, points: c.points, score, comment };
  });
}

/**
 * 실제 AI에게 보낼 채점 지시문. 선생님이 쓴 기준 전문을 한 글자도 빼지 않고 넣고,
 * 프로그램이 알아낸 채점 방식(배점식/감점식, 만점, 최저점, 백지 점수, 결과표 항목)을 덧붙여
 * AI가 결과표 형식에 맞춰 답하도록 한다.
 */
export function buildGradingPrompt({ prompt, criteria, rubric, notes, idDigits }) {
  const r = rubric || defaultRubric(criteria);
  const items = criteria.map((c, i) => r.mode === 'deduct'
    ? `${i + 1}. ${c.name} — 감점 규칙: ${c.deductions.map((d) => `${d.text}`).join(' / ') || '(없음)'}`
    : `${i + 1}. ${c.name} — 배점 ${c.points}점${c.desc ? ` (${c.desc.replace(/\n/g, ' ')})` : ''}`).join('\n');
  return [
    '당신은 학생 토론 수행평가 답안지를 채점하는 교사 보조입니다. 아래 [선생님 채점 기준]을 그대로 따르세요.',
    '', '[선생님 채점 기준]', prompt.trim(), '',
    notes?.trim() ? `[판독 참고 사항]\n${notes.trim()}\n` : '',
    '[결과표 형식]',
    r.mode === 'deduct'
      ? `감점식입니다. 만점 ${r.max}점에서 아래 항목별 감점을 뺍니다. 항목 점수는 감점 합계를 음수로 적으세요(감점 없으면 0).`
      : `배점식입니다. 항목별로 0점부터 배점까지 점수를 주세요. 총점 ${r.max}점.`,
    items,
    r.floor != null ? `총점이 ${r.floor}점보다 낮아지면 ${r.floor}점으로 적으세요.` : '',
    r.blank != null ? `백지(내용 없음) 답안지는 총점 ${r.blank}점입니다.` : '',
    `학번은 ${idDigits}자리(학년 1자리+반+번호 2자리), 이름의 글자가 불명확하면 가장 비슷한 글자로 적으세요.`,
    '글씨를 알아볼 수 없어 판독이 불가하면 status를 "unreadable"로 하세요.',
    '학번·이름은 답안지 첫 쪽 위쪽 칸에서 반드시 읽어 적으세요.',
    '감점 근거는 기준 문장을 옮기지 말고 짧은 핵심 키워드로(예: "주장 누락"). 항목마다 학생이 쓴 답을 answer에 마크다운 목록으로 정리하세요.',
    '답은 JSON 하나로만: {"studentId":"","name":"","status":"ok|unreadable|blank","scores":[{"name":"항목 이름","score":숫자,"deductions":[{"keyword":"주장 누락","points":-2}],"comment":"","answer":"- 학생 답"}]}',
  ].filter((x) => x !== '').join('\n');
}

/**
 * 실제 AI/OCR 연결 지점.
 * 나중에 서버(예: Cloudflare Worker, Apps Script)를 하나 두고 그곳에서 API 키를 보관한 뒤,
 * 여기서 fetch로 { 기준, 참고사항, PDF 텍스트 또는 페이지 이미지 }를 보내 점수를 받아오면 됩니다.
 * null을 돌려주면 아래 데모 채점이 사용됩니다.
 */
// prompt: 선생님이 쓴 채점 기준 전체(자유 서술). criteria: 그 안에서 뽑은 결과표 열(항목·배점). pages: 이 학생의 쪽 번호 배열
async function aiGrade(/* { file, pages, text, prompt, criteria, rubric, notes, signal, instructions } */) {
  // instructions: buildGradingPrompt()로 만든 완성된 지시문 → 그대로 AI에게 보내면 됨
  return null;
}

const pageLabel = (pages) => (pages.length === 1 ? `${pages[0]}쪽` : `${pages[0]}~${pages[pages.length - 1]}쪽`);

/**
 * 파일 하나를 읽어 학생별로 나누고 채점한다.
 * layout: 'auto' | 'duplex'(양면: 2쪽=1명) | 'simplex'(단면: 1쪽=1명)
 */
export async function gradeFile(file, { criteria, rubric, prompt = '', idDigits, notes, layout = 'auto' }, signal) {
  rubric = rubric || defaultRubric(criteria);
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

    let scores = await aiGrade({ file, pages, text, prompt, criteria, rubric, notes, signal, instructions: buildGradingPrompt({ prompt, criteria, rubric, notes, idDigits }) });
    let mode = 'ai';
    if (!scores && stText) { scores = heuristicGrade(text, criteria, rubric); mode = 'text'; }
    const base = { idx: i + 1, pages, pageLabel: pageLabel(pages), studentId, name, mode, textPreview: text.slice(0, 3000), answer: stText ? text.slice(0, 4000) : '' };
    if (!scores && !stText) {
      // 손글씨 스캔본은 이 화면에서 글씨를 읽을 수 없다 → 학생 나누기까지만 하고 실제 판독·채점은 Claude에게
      students.push({ ...base, mode: 'scan', status: 'wait', reason: '손글씨 스캔본 · Claude 채점 필요', scores: criteria.map((c) => ({ name: c.name, points: c.points, score: null, comment: '' })), total: null });
    } else if (!scores) {
      students.push({ ...base, status: 'fail', reason: '학생이 쓴 글씨를 해석할 수 없어요', scores: criteria.map((c) => ({ name: c.name, points: c.points, score: null, comment: '판독 불가' })), total: null });
    } else {
      students.push({ ...base, status: 'success', scores, total: computeTotal(rubric, criteria.map((c) => scores.find((x) => x.name === c.name)?.score ?? 0)) });
    }
  }
  return {
    pages: totalPages, readPages: pageCount, hasText,
    layout: effLayout, per: detected?.per || (effLayout === 'duplex' ? 2 : 1), layoutAuto: !!detected, layoutReason: detected?.reason || '직접 지정',
    students,
  };
}
