import { parseCriteria, criteriaSignature, computeTotal, defaultRubric, shortReason, EXAMPLE_CRITERIA } from './criteria.js?v=10';
import { gradeFile, loadPdfjs, openPdf, GradeError, extractStudentId, extractName, buildGradingPrompt } from './grader.js?v=10';
import * as bridge from './bridge.js?v=10';

const LAYOUTS = { auto: '자동', duplex: '양면', simplex: '단면', set: '여러 쪽' };
const layoutLabel = (r) => (r?.layout === 'set' && r.per ? `${r.per}쪽씩` : LAYOUTS[r?.layout] || '');
const $ = (s) => document.querySelector(s);
const fmtNum = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });
const CONCURRENCY = 2;
const MAX_FILE_MB = 80;
const MAX_SECTIONS = 20;

// ── 저장소 (브라우저 저장이 막혀 있어도 앱은 동작) ──────────────────────────
const KEY = 'dpg.settings.v2';
const OLD_KEY = 'dpg.settings.v1';
const OLD_DRAFT_KEY = 'dpg.criteriaDraft.v1';
const draftKey = (secId) => `dpg.draft.${secId}`;
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* 무시 */ } },
};

// ── 평가 영역(섹션) ─────────────────────────────────────────────────────────
let secSeq = 0;
const newSecId = () => `s${Date.now().toString(36)}${(secSeq++).toString(36)}`;
function makeSection(name, from = {}) {
  return {
    id: typeof from.id === 'string' && /^[\w-]{1,40}$/.test(from.id) ? from.id : newSecId(),
    name: String(name || '평가 1').slice(0, 30),
    criteriaText: typeof from.criteriaText === 'string' ? from.criteriaText : '',
    criteria: [],
    rubric: null,
    savedAt: from.savedAt || null,
    notes: typeof from.notes === 'string' ? from.notes : '',
    layoutDefault: ['auto', 'duplex', 'simplex'].includes(from.layoutDefault) ? from.layoutDefault : 'auto',
    keywords: typeof from.keywords === 'string' ? from.keywords.slice(0, 200) : '', // 파일 이름에 이 말이 있으면 이 영역으로 (예: 1차시, 입론)
  };
}
// 채점 기준 글에서 결과표 항목과 채점 방식(배점식/감점식, 만점, 최저점, 백지 점수)을 만든다
function compileCriteria(text) {
  const r = parseCriteria(text);
  return { criteria: r.items.map(({ name, points, desc, deductions }) => ({ name, points, desc, deductions })), rubric: r.rubric };
}
// 저장된 기준이 있으면 글에서 다시 해석한다 (해석 방식이 좋아지면 예전에 저장한 기준에도 바로 반영)
function hydrate(sec, wasSaved) {
  if (wasSaved && sec.criteriaText.trim()) Object.assign(sec, compileCriteria(sec.criteriaText));
  return sec;
}
const rubricOf = (sec) => sec.rubric || defaultRubric(sec.criteria);

function loadSettings() {
  const v2 = store.get(KEY);
  if (v2 && Array.isArray(v2.sections) && v2.sections.length) {
    const seen = new Set();
    const sections = v2.sections.slice(0, MAX_SECTIONS).map((s, i) => hydrate(makeSection((s && s.name) || `평가 ${i + 1}`, s || {}), !!(s && (s.savedAt || s.criteria?.length))))
      .map((s) => { if (seen.has(s.id)) s.id = newSecId(); seen.add(s.id); return s; });
    return { idDigits: v2.idDigits === 4 ? 4 : 5, sections, activeSec: v2.activeSec };
  }
  // 예전 버전(영역 하나) 설정을 첫 번째 영역으로 옮긴다
  const v1 = store.get(OLD_KEY) || {};
  const sec = makeSection('평가 1', { ...v1, id: undefined });
  hydrate(sec, !!sec.criteriaText.trim());
  const oldDraft = store.get(OLD_DRAFT_KEY);
  if (typeof oldDraft === 'string') { store.set(draftKey(sec.id), oldDraft); store.del(OLD_DRAFT_KEY); }
  return { idDigits: v1.idDigits === 4 ? 4 : 5, sections: [sec], activeSec: sec.id };
}

const loaded = loadSettings();
const state = {
  idDigits: loaded.idDigits,
  sections: loaded.sections,
  activeSec: loaded.sections.some((s) => s.id === loaded.activeSec) ? loaded.activeSec : loaded.sections[0].id, // 설정·업로드 화면에서 고른 영역
  files: new Map(),   // id -> 파일 항목
  order: [],          // 정렬된 id 목록 (영역 순서 → 파일 이름 순)
  showWhy: true,      // 학급 표에서 채점 근거·답안 펼침
  result: { kind: 'all' }, // 결과 화면에서 보는 것: {kind:'all'} | {kind:'sec', sec} | {kind:'file', sec, file}
  view: 'settings',
};
let seq = 0;
let listVersion = 0; // 파일 추가/삭제 때만 증가
const queue = [];
let running = 0;

const secById = (id) => state.sections.find((s) => s.id === id);
const activeSection = () => secById(state.activeSec) || state.sections[0];
const secName = (s) => (s?.name || '').trim() || '이름 없는 영역';
const filesOf = (secId) => state.order.filter((id) => state.files.get(id).sec === secId);

function persist() {
  return store.set(KEY, {
    idDigits: state.idDigits,
    activeSec: state.activeSec,
    sections: state.sections.map(({ id, name, criteriaText, criteria, savedAt, notes, layoutDefault, keywords }) => ({ id, name, criteriaText, criteria: criteria.map(({ name: n, points }) => ({ name: n, points })), savedAt, notes, layoutDefault, keywords })),
  });
}
const secSig = (s) => `${state.idDigits}\u0003${s.criteriaText}\u0003${criteriaSignature(s.criteria)}\u0003${JSON.stringify(s.rubric)}\u0003${s.notes}`;
// 파일마다 고른 양면/단면 (null이면 그 영역의 기본값을 따름)
const layoutChoice = (f) => f.layout || secById(f.sec)?.layoutDefault || 'auto';
const fileSig = (f) => `${secSig(secById(f.sec))}\u0003${layoutChoice(f)}`;
const isClaude = (f) => f.result?.source === 'claude';
const isStale = (f) => !isClaude(f) && !!f.sig && !!secById(f.sec) && f.sig !== fileSig(f);

// ── 렌더링 예약 (한 프레임에 한 번만 다시 그림) ──────────────────────────────
const dirty = new Set();
let rafId = 0;
function invalidate(...parts) {
  parts.forEach((p) => dirty.add(p));
  if (parts.includes('files') || parts.includes('results')) scheduleSave();
  if (!rafId) rafId = requestAnimationFrame(flush);
}
function flush() {
  rafId = 0;
  const d = new Set(dirty); dirty.clear();
  if (d.has('badges')) renderBadges();
  // 숨겨진 화면은 그리지 않고, 화면을 열 때(route) 그린다
  if (d.has('files') && state.view === 'files') { renderFiles(); renderClaude(); }
  if (d.has('results') && state.view === 'results') renderResults();
  if (d.has('sectabs') && state.view === 'settings') renderSecTabs();
}

let toastTimer = 0;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

// ── 라우팅 ──────────────────────────────────────────────────────────────
function route() {
  const [view, sub] = location.hash.replace(/^#/, '').split('/');
  const v = ['settings', 'files', 'results'].includes(view) ? view : 'settings';
  if (v === 'results' && sub) {
    const f = state.files.get(sub);
    if (f) state.result = { kind: 'file', sec: f.sec, file: f.id };
    else if (secById(sub)) state.result = { kind: 'sec', sec: sub };
  }
  if (state.view === 'settings' && v !== 'settings') flushPendingInputs();
  state.view = v;
  closeMenu();
  document.querySelectorAll('.view').forEach((el) => { el.hidden = el.dataset.view !== v; });
  document.querySelectorAll('.nav-item').forEach((el) => {
    const on = el.dataset.view === v;
    el.classList.toggle('active', on);
    if (on) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
  });
  if (v === 'files') renderFiles();
  if (v === 'results') renderResults();
  if (v === 'settings') renderSettings();
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

// ── 설정 화면 ────────────────────────────────────────────────────────────
const ta = $('#criteria');
const notes = $('#reading-notes');
const nameInput = $('#sec-name');
const kwInput = $('#sec-keywords');
const draftAt = new Map(); // 영역별 임시 저장 시각 (-1: 브라우저가 저장을 막음)
let vTimer = 0, nTimer = 0, nameTimer = 0;
let formSec = null; // 지금 입력 칸에 올라와 있는 영역 id

const secTabsHtml = (activeId, withAdd) => state.sections.map((s) => {
  const n = filesOf(s.id).length;
  const need = s.criteria.length ? '' : ' <i class="need" title="채점 기준 저장 전">•</i>';
  return `<button type="button" class="sec-tab" role="tab" data-sec="${s.id}" aria-selected="${s.id === activeId}"><span class="sec-tab-name">${esc(secName(s))}</span>${n ? ` <small>${n}</small>` : ''}${need}</button>`;
}).join('') + (withAdd ? '<button type="button" class="sec-tab add" data-sec-add title="평가 영역 추가">+ 영역 추가</button>' : '');

function persistDraft() {
  const sec = secById(formSec);
  if (!sec) return;
  if (ta.value === sec.criteriaText) { store.del(draftKey(sec.id)); draftAt.delete(sec.id); }
  else draftAt.set(sec.id, store.set(draftKey(sec.id), ta.value) ? Date.now() : -1);
}

// 영역을 바꾸거나 화면을 떠나기 전에 지금 쓰던 내용을 확실히 남긴다
function flushPendingInputs() {
  clearTimeout(vTimer); clearTimeout(nTimer); clearTimeout(nameTimer);
  const sec = secById(formSec);
  if (!sec) return;
  persistDraft();
  if (notes.value !== sec.notes) { sec.notes = notes.value; persist(); markStale(); }
  commitKeywords();
  commitName();
}
function commitKeywords() {
  const sec = secById(formSec);
  if (!sec) return;
  const v = kwInput.value.slice(0, 200);
  if (v !== (sec.keywords || '')) { sec.keywords = v; persist(); invalidate('files'); }
}
function commitName() {
  const sec = secById(formSec);
  if (!sec) return;
  const v = nameInput.value.trim().slice(0, 30);
  if (v && v !== sec.name) { sec.name = v; persist(); invalidate('files', 'results', 'sectabs'); refreshCriteriaStateSoon(); }
}
let stateTimer = 0;
function refreshCriteriaStateSoon() { clearTimeout(stateTimer); stateTimer = setTimeout(renderCriteriaState, 0); }

function loadSectionIntoForm() {
  const sec = activeSection();
  formSec = sec.id;
  const draft = store.get(draftKey(sec.id));
  ta.value = typeof draft === 'string' ? draft : sec.criteriaText;
  if (typeof draft === 'string' && draft !== sec.criteriaText && !draftAt.has(sec.id)) draftAt.set(sec.id, Date.now());
  notes.value = sec.notes;
  nameInput.value = sec.name;
  kwInput.value = sec.keywords || '';
  document.querySelectorAll('input[name="layoutDefault"]').forEach((r) => { r.checked = r.value === sec.layoutDefault; });
  $('#sec-delete').hidden = state.sections.length <= 1;
  resetDeleteArm();
}

function renderSecTabs() {
  $('#sec-tabs').innerHTML = secTabsHtml(state.activeSec, state.sections.length < MAX_SECTIONS);
}
function renderSettings() {
  renderSecTabs();
  if (formSec !== state.activeSec || document.activeElement !== ta) loadSectionIntoForm();
  renderCriteriaState();
}

function selectSection(id, { focusName = false } = {}) {
  if (!secById(id)) return;
  flushPendingInputs();
  state.activeSec = id;
  persist();
  formSec = null;
  renderSettings();
  if (focusName) { nameInput.focus(); nameInput.select(); }
}

function addSection() {
  if (state.sections.length >= MAX_SECTIONS) { toast(`영역은 ${MAX_SECTIONS}개까지 만들 수 있어요.`); return; }
  flushPendingInputs();
  let n = state.sections.length + 1;
  while (state.sections.some((s) => s.name === `평가 ${n}`)) n++;
  const sec = makeSection(`평가 ${n}`, { layoutDefault: activeSection().layoutDefault });
  state.sections.push(sec);
  persist();
  invalidate('files', 'results', 'badges');
  selectSection(sec.id, { focusName: true });
  toast(`‘${sec.name}’ 영역을 만들었어요. 이름과 채점 기준을 적어 주세요.`);
}

let delArm = 0;
function resetDeleteArm() { clearTimeout(delArm); delArm = 0; $('#sec-delete').textContent = '이 영역 삭제'; }
function deleteSection() {
  const sec = activeSection();
  if (state.sections.length <= 1) return;
  const n = filesOf(sec.id).length;
  const b = $('#sec-delete');
  if (!delArm) {
    b.textContent = n ? `한 번 더 누르면 삭제 (올린 파일 ${n}개도 함께)` : '한 번 더 누르면 삭제';
    delArm = setTimeout(resetDeleteArm, 3500);
    return;
  }
  resetDeleteArm();
  clearTimeout(vTimer); clearTimeout(nTimer); clearTimeout(nameTimer);
  for (const id of filesOf(sec.id)) removeFile(id);
  store.del(draftKey(sec.id));
  draftAt.delete(sec.id);
  const idx = state.sections.indexOf(sec);
  state.sections.splice(idx, 1);
  state.activeSec = state.sections[Math.max(0, idx - 1)].id;
  if (state.result.sec === sec.id) state.result = { kind: 'all' };
  formSec = null;
  persist();
  invalidate('files', 'results', 'badges');
  renderSettings();
  toast(`‘${secName(sec)}’ 영역을 삭제했어요.`);
}

function initSettings() {
  document.querySelectorAll('input[name="idDigits"]').forEach((r) => {
    r.checked = Number(r.value) === state.idDigits;
    r.addEventListener('change', () => {
      state.idDigits = Number(r.value);
      persist();
      markStale();
      toast(`학번을 ${state.idDigits}자리로 저장했어요. (모든 영역에 적용)`);
    });
  });
  document.querySelectorAll('input[name="layoutDefault"]').forEach((r) => {
    r.addEventListener('change', () => {
      const sec = activeSection();
      sec.layoutDefault = r.value;
      persist();
      markStale();
      toast(`‘${secName(sec)}’의 양면/단면 기본값을 ‘${LAYOUTS[r.value]}’(으)로 저장했어요.`);
    });
  });

  $('#sec-tabs').addEventListener('click', (e) => {
    if (e.target.closest('[data-sec-add]')) { addSection(); return; }
    const t = e.target.closest('[data-sec]');
    if (t && t.dataset.sec !== state.activeSec) selectSection(t.dataset.sec);
  });
  nameInput.addEventListener('input', () => { clearTimeout(nameTimer); nameTimer = setTimeout(commitName, 400); });
  nameInput.addEventListener('blur', () => { clearTimeout(nameTimer); commitName(); if (!nameInput.value.trim()) nameInput.value = activeSection().name; });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(nameTimer); commitName(); ta.focus(); } });
  $('#sec-delete').addEventListener('click', deleteSection);
  kwInput.addEventListener('input', () => { clearTimeout(nameTimer); nameTimer = setTimeout(() => { commitKeywords(); commitName(); }, 400); });
  kwInput.addEventListener('blur', commitKeywords);

  // 작성 중인 내용은 자동으로 임시 저장 (새로고침·창 닫기에도 유지)
  ta.addEventListener('input', () => {
    $('#criteria-save').disabled = !ta.value.trim(); // 저장 버튼은 즉시 반응
    clearTimeout(vTimer); vTimer = setTimeout(() => { persistDraft(); renderCriteriaState(); }, 300);
  });
  // 포커스가 빠지거나 창을 닫을 때는 저장만 한다 (화면을 다시 그리면 누르려던 버튼이 움직일 수 있음)
  ta.addEventListener('blur', persistDraft);
  window.addEventListener('pagehide', flushPendingInputs);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushPendingInputs(); });
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveCriteria(); }
  });
  notes.addEventListener('input', () => {
    clearTimeout(nTimer);
    nTimer = setTimeout(() => { const sec = secById(formSec); if (!sec) return; sec.notes = notes.value; persist(); markStale(); }, 400);
  });

  $('#criteria-save').addEventListener('click', saveCriteria);
  $('#criteria-revert').addEventListener('click', () => {
    clearTimeout(vTimer);
    const sec = activeSection();
    ta.value = sec.criteriaText; store.del(draftKey(sec.id)); draftAt.delete(sec.id); renderCriteriaState(); toast('저장된 기준으로 되돌렸어요.');
  });
  $('#criteria-example').addEventListener('click', () => {
    clearTimeout(vTimer);
    if (ta.value.trim() && ta.value !== EXAMPLE_CRITERIA) {
      ta.value = `${ta.value.replace(/\s+$/, '')}\n\n${EXAMPLE_CRITERIA}`;
      toast('예시를 기존 내용 아래에 붙였어요. 겹치는 부분은 지워 주세요.');
    } else ta.value = EXAMPLE_CRITERIA;
    persistDraft();
    renderCriteriaState();
    ta.focus();
  });
}

const hhmm = (t) => new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
function renderCriteriaState() {
  const sec = activeSection();
  const r = parseCriteria(ta.value);
  const box = $('#criteria-validation');
  const lines = [];
  if (r.ok) {
    const rb = r.rubric;
    const extra = [rb.floor != null ? `최저 ${fmtNum(rb.floor)}점` : '', rb.blank != null ? `백지 ${fmtNum(rb.blank)}점` : ''].filter(Boolean).join(' · ');
    if (rb.mode === 'deduct') {
      const chips = r.items.map((it) => `<span class="chip" title="${esc(it.deductions.map((d) => d.text).join('\n'))}">${esc(it.name)} <b>감점 규칙 ${it.deductions.length}개</b></span>`).join('');
      lines.push(`<div class="ok">✓ 감점식 · 만점 ${fmtNum(rb.max)}점${r.assumed ? '(자동)' : ''}에서 감점 · 결과표 항목 ${r.items.length}개${extra ? ` · ${extra}` : ''}</div><div class="chips">${chips}</div>`);
    } else {
      const chips = r.items.map((it) => `<span class="chip">${esc(it.name)} <b>${fmtNum(it.points)}점</b></span>`).join('');
      lines.push(`<div class="ok">✓ 결과표에 쓸 채점 항목 ${r.items.length}개 · 총 ${fmtNum(r.total)}점${r.assumed ? ' (자동 지정)' : ''}${extra ? ` · ${extra}` : ''}</div><div class="chips">${chips}</div>`);
    }
  }
  r.errors.forEach((e) => lines.push(`<div class="err">✕ ${esc(e.msg)}</div>`));
  r.warnings.slice(0, 3).forEach((w) => lines.push(`<div class="warn">! ${esc(w)}</div>`));
  box.innerHTML = lines.join('');

  const st = $('#criteria-state');
  const isDirty = ta.value !== sec.criteriaText;
  const d = draftAt.get(sec.id);
  const nm = `‘${secName(sec)}’`;
  st.className = 'save-state' + (isDirty ? ' dirty' : sec.savedAt ? ' saved' : '');
  if (isDirty) st.textContent = d === -1 ? `${nm} 작성 중 · 이 브라우저는 임시 저장이 막혀 있어요` : d ? `${nm} 작성 중 · ${hhmm(d)} 임시 저장됨` : `${nm} 작성 중`;
  else st.textContent = sec.savedAt ? `${nm} 저장됨 · ${new Date(sec.savedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : `${nm} 아직 저장 안 됨`;
  $('#criteria-save').disabled = !r.ok || (!isDirty && !!sec.savedAt);
  $('#criteria-revert').disabled = !isDirty || !sec.savedAt;
}

function saveCriteria() {
  clearTimeout(vTimer);
  const sec = activeSection();
  const r = parseCriteria(ta.value);
  if (!r.ok) { renderCriteriaState(); toast('채점 기준이 비어 있어요.'); return; }
  const wasNew = !sec.criteria.length;
  sec.criteriaText = ta.value;
  Object.assign(sec, compileCriteria(ta.value));
  sec.savedAt = Date.now();
  const ok = persist();
  store.del(draftKey(sec.id));
  draftAt.delete(sec.id);
  renderCriteriaState();
  if (wasNew) renderSecTabs();
  toast(ok ? `‘${secName(sec)}’ 채점 기준을 저장했어요. (채점 항목 ${r.items.length}개)` : '저장했지만 이 브라우저는 저장소가 막혀 있어 새로고침하면 사라져요.');
  markStale();
  pump();
}

function markStale() { invalidate('files', 'results'); }

// ── 파일 업로드 ───────────────────────────────────────────────────────────
// 파일 이름으로 영역 찾기: 영역의 ‘파일 이름 키워드’(예: 1차시) 또는 영역 이름이 파일 이름에 들어 있으면 그 영역.
// 여러 영역이 걸리면 더 길게(구체적으로) 맞은 쪽, 그래도 같으면 판단하지 않는다(→ 지금 고른 영역).
const squash = (x) => String(x || '').replace(/\s+/g, '').toLowerCase();
const keywordsOf = (sec) => String(sec.keywords || '').split(/[,，\n]/).map((k) => k.trim()).filter(Boolean);
export function matchSection(fileName, sections = state.sections) {
  const fn = squash(fileName.replace(/\.pdf$/i, ''));
  let best = null, bestLen = 0, tie = false;
  for (const sec of sections) {
    let len = 0;
    for (const k of [...keywordsOf(sec), sec.name]) {
      const q = squash(k);
      if (q.length < 2 && !/\d/.test(q)) continue;
      // ‘1차시’가 ‘11차시’ 안에서 맞지 않도록 숫자로 시작하는 키워드는 앞이 숫자가 아니어야 함
      const i = fn.indexOf(q);
      if (i < 0 || (/^\d/.test(q) && i > 0 && /\d/.test(fn[i - 1]))) continue;
      len = Math.max(len, q.length);
    }
    if (!len) continue;
    if (len > bestLen) { best = sec; bestLen = len; tie = false; } else if (len === bestLen) tie = true;
  }
  if (best && !tie) return best;
  // 키워드를 아무 영역에도 적지 않았다면: 파일 이름의 ‘N차시’ → N번째 영역 (영역 탭 순서 = 차시 순서)
  const m = fn.match(/(?<!\d)(\d{1,2})차시/);
  if (m && !sections.some((x) => keywordsOf(x).length) && +m[1] >= 1 && +m[1] <= sections.length) return sections[+m[1] - 1];
  return null;
}
function addFiles(list, secId = null) {
  const incoming = [...list];
  let dup = 0, skipped = 0, big = 0;
  const addedTo = new Map(); // 영역 id → 개수
  const keysOf = (sid) => new Set([...state.files.values()].filter((f) => f.sec === sid).map((f) => `${f.name}\u0000${f.size}`));
  const keys = new Map();
  for (const file of incoming) {
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    if (!isPdf) { skipped++; continue; }
    if (file.size > MAX_FILE_MB * 1024 * 1024) { big++; continue; }
    const target = secId || matchSection(file.name)?.id || state.activeSec;
    if (!keys.has(target)) keys.set(target, keysOf(target));
    const k = `${file.name}\u0000${file.size}`;
    if (keys.get(target).has(k)) { dup++; continue; }
    keys.get(target).add(k);
    const id = `f${++seq}`;
    state.files.set(id, { id, sec: target, file, name: file.name, size: file.size, status: 'pending', result: null, error: '', sig: null, layout: null });
    addedTo.set(target, (addedTo.get(target) || 0) + 1);
    queue.push(id);
  }
  const added = [...addedTo.values()].reduce((a, b) => a + b, 0);
  if (added) sortFiles();
  const msg = [];
  if (added) msg.push([...addedTo].map(([sid, n]) => `‘${secName(secById(sid))}’에 ${n}개`).join(', ') + ' 추가');
  if (dup) msg.push(`중복 ${dup}개 제외`);
  if (skipped) msg.push(`PDF가 아닌 파일 ${skipped}개 제외`);
  if (big) msg.push(`${MAX_FILE_MB}MB 초과 ${big}개 제외`);
  if (msg.length) toast(msg.join(' · '));
  // 올린 파일이 지금 보고 있는 영역에 하나도 없으면, 들어간 영역 탭을 보여 준다
  if (added && !addedTo.has(state.activeSec)) { state.activeSec = [...addedTo.keys()][0]; formSec = null; persist(); }
  invalidate('files', 'results', 'badges', 'sectabs');
  if (added) { loadPdfjs().catch(() => {}); pump(); }
}
// 파일을 다른 영역으로 옮긴다 (영역마다 채점 기준이 다르므로 점수는 새로 매김)
function moveFile(id, secId) {
  const f = state.files.get(id);
  const sec = secById(secId);
  if (!f || !sec || f.sec === secId) return;
  if ([...state.files.values()].some((x) => x.sec === secId && x.name === f.name && x.size === f.size)) { toast(`‘${secName(sec)}’에 같은 파일이 이미 있어요.`); renderFiles(); return; }
  const from = secName(secById(f.sec));
  f.sec = secId;
  f.edits = null;
  if (state.result.file === id) state.result = { kind: 'file', sec: secId, file: id };
  sortFiles();
  if (f.file) regradeOne(f);
  else { f.status = 'pending'; f.result = null; invalidate('files', 'results', 'badges'); }
  invalidate('sectabs');
  toast(`‘${f.name}’ 파일을 ‘${from}’에서 ‘${secName(sec)}’(으)로 옮겼어요.`);
}
function sortFiles() {
  listVersion++;
  const secIdx = new Map(state.sections.map((s, i) => [s.id, i]));
  state.order = [...state.files.keys()].sort((a, b) => {
    const fa = state.files.get(a), fb = state.files.get(b);
    return (secIdx.get(fa.sec) ?? 99) - (secIdx.get(fb.sec) ?? 99) || collator.compare(fa.name, fb.name);
  });
}
function removeFile(id) {
  const f = state.files.get(id);
  if (!f) return;
  f.abort?.abort();
  state.files.delete(id);
  state.order = state.order.filter((x) => x !== id);
  listVersion++;
  const qi = queue.indexOf(id); if (qi >= 0) queue.splice(qi, 1);
  if (state.result.file === id) state.result = { kind: 'sec', sec: f.sec };
  invalidate('files', 'results', 'badges', 'sectabs');
}

// ── 채점 대기열 (동시에 2개씩, 화면은 멈추지 않음) ──────────────────────────
const canGradeFile = (f) => !!secById(f.sec)?.criteria.length;
function pump() {
  // 기준이 저장되지 않은 영역의 파일은 건너뛰고 대기열에 남겨 둔다
  let i = 0;
  while (running < CONCURRENCY && i < queue.length) {
    const f = state.files.get(queue[i]);
    if (!f || f.status === 'grading') { queue.splice(i, 1); continue; }
    if (!f.file || isClaude(f)) { queue.splice(i, 1); continue; } // Claude 결과·불러온 결과는 데모 채점으로 덮지 않음
    if (!canGradeFile(f)) { i++; continue; }
    queue.splice(i, 1);
    run(f);
  }
  invalidate('files');
}
async function run(f) {
  running++;
  const ctrl = new AbortController();
  f.abort = ctrl; f.status = 'grading'; f.error = '';
  invalidate('files', 'badges');
  const sec = secById(f.sec);
  const sig = fileSig(f);
  const opts = { criteria: sec.criteria, rubric: rubricOf(sec), prompt: sec.criteriaText, idDigits: state.idDigits, notes: sec.notes, layout: layoutChoice(f) };
  try {
    const res = await gradeFile(f.file, opts, ctrl.signal);
    if (state.files.get(f.id) !== f || f.abort !== ctrl) return; // 도중에 삭제되었거나 다시 채점 시작됨
    const ok = res.students.filter((st) => st.status === 'success' || st.status === 'wait').length;
    f.result = res; f.sig = sig;
    f.status = ok ? 'success' : 'fail';
    f.error = ok ? '' : (res.students[0]?.reason || '판독 불가');
  } catch (e) {
    if (e?.name === 'AbortError' || state.files.get(f.id) !== f || f.abort !== ctrl) return;
    // 열지 못한 파일도 파일명에서 학번·이름은 찾아 표에 보여 준다
    f.result = { pages: null, layout: null, layoutAuto: false, students: [{ idx: 1, pages: [], pageLabel: '', studentId: extractStudentId(f.name, opts.idDigits), name: extractName(f.name, ''), status: 'fail', scores: null, total: null, mode: null }] };
    f.sig = sig; f.status = 'fail';
    f.error = e instanceof GradeError ? e.message : '읽는 중 문제가 생겼어요';
    if (!(e instanceof GradeError)) console.error(e);
  } finally {
    running--;
    if (f.abort === ctrl) f.abort = null;
    invalidate('files', 'results', 'badges');
    // 다음 작업은 다음 틱에 시작해 화면이 숨 쉴 틈을 준다
    setTimeout(pump, 0);
  }
}
function regradeOne(f) {
  if (!f.file) { toast('결과 파일에서 불러온 학급이라 다시 채점할 PDF가 없어요.'); return; }
  if (isClaude(f)) f.result = null;
  if (f.abort) f.abort.abort();
  f.abort = null;
  f.status = 'pending'; f.result = null; f.error = '';
  if (!queue.includes(f.id)) queue.unshift(f.id);
  invalidate('files', 'results', 'badges');
  pump();
}
function setLayout(id, value) {
  const f = state.files.get(id);
  if (!f) return;
  const next = value === secById(f.sec).layoutDefault ? null : value;
  if (layoutChoice(f) === value && f.layout === next) return;
  f.layout = next;
  f.edits = null; // 학생 나누기가 바뀌면 직접 고친 값은 맞지 않으므로 비움
  regradeOne(f);
}
function regradeAll(secId = null) {
  let any = false;
  for (const id of state.order) {
    const f = state.files.get(id);
    if (secId && f.sec !== secId) continue;
    if (!f.file || isClaude(f)) continue; // Claude 채점 결과는 그대로 둔다 (다시 받으려면 ‘채점 시작’)
    if (f.status === 'grading') { f.abort?.abort(); f.abort = null; }
    f.status = 'pending'; f.result = null; f.error = '';
    if (!queue.includes(id)) queue.push(id);
    any = true;
  }
  if (!any) return;
  invalidate('files', 'results', 'badges');
  pump();
}

// ── 업로드 화면 렌더링 ────────────────────────────────────────────────────
const fmtSize = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))}KB` : `${(n / 1024 / 1024).toFixed(1)}MB`);
const X_ICON = '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M2 2l10 10M12 2L2 12"/></svg>';

function statusText(f) {
  switch (f.status) {
    case 'success': {
      const st = f.result.students;
      const bad = st.filter((x) => x.status === 'fail').length;
      if (!isClaude(f) && st.every((x) => x.status === 'wait')) return `학생 ${st.length}명으로 나눔 · Claude 채점 필요`;
      return `${isClaude(f) ? 'Claude 채점 완료' : '데모 채점'} · 학생 ${st.length}명${bad ? ` (채점 불가 ${bad}명)` : ''} · 결과 보기`;
    }
    case 'fail': return `${isClaude(f) ? 'Claude: ' : ''}채점 실패 · ${f.error || '판독 불가'}`;
    case 'grading': return '읽는 중…';
    default: return !f.file ? '결과만 있음' : canGradeFile(f) ? '대기 중' : '기준 저장 후 채점';
  }
}
function counts(secId = null) {
  let s = 0, x = 0, p = 0, students = 0, n = 0;
  for (const f of state.files.values()) {
    if (secId && f.sec !== secId) continue;
    n++;
    if (f.status === 'success') s++; else if (f.status === 'fail') x++; else p++;
    if (f.result) students += f.result.students.length;
  }
  return { s, x, p, n, students };
}
// 양면/단면 선택 버튼 (한 번 클릭으로 전환)
function layoutSeg(f) {
  const cur = layoutChoice(f);
  const detected = f.result?.layoutAuto && !isClaude(f) ? f.result.layout : null;
  const btn = (v) => {
    const label = v === 'auto' && detected ? `자동(${layoutLabel(f.result)})` : LAYOUTS[v];
    const tip = v === 'auto' ? (f.result?.layoutReason ? `자동 판단: ${f.result.layoutReason}` : '답안지 양식이 몇 쪽마다 반복되는지 보고 학생을 자동으로 나눔') : v === 'duplex' ? '양면: 2쪽(앞+뒤)을 학생 1명으로 채점' : '단면: 1쪽을 학생 1명으로 채점';
    return `<button type="button" data-layout="${v}" aria-pressed="${cur === v}" title="${esc(tip)}">${esc(label)}</button>`;
  };
  return `<span class="seg" role="group" aria-label="양면/단면" data-seg="${f.id}">${btn('auto')}${btn('duplex')}${btn('simplex')}</span>`;
}
function rowKey(f) { return `${f.status}|${f.result?.source || ''}|${statusText(f)}|${layoutChoice(f)}|${f.result?.layout || ''}|${f.result?.per || ''}|${state.sections.map((x) => secName(x)).join(',')}`; }

function renderFiles() {
  const sec = activeSection();
  const tabsHtml = secTabsHtml(sec.id, false) + '<a class="sec-tab add" href="#settings" title="설정에서 평가 영역 추가">+ 영역 추가</a>';
  const tabsEl = $('#files-sec-tabs');
  if (tabsEl.dataset.h !== tabsHtml) { tabsEl.innerHTML = tabsHtml; tabsEl.dataset.h = tabsHtml; }
  $('#dz-title').textContent = state.sections.length > 1 ? 'PDF를 여기로 끌어다 놓으세요' : `‘${secName(sec)}’ PDF를 여기로 끌어다 놓으세요`;
  const kwHint = state.sections.filter((x) => keywordsOf(x).length);
  $('#dz-sub').innerHTML = state.sections.length > 1
    ? (kwHint.length ? `파일 이름으로 영역을 자동으로 나눠요: ${state.sections.map((x) => `<b>${esc(secName(x))}</b>${keywordsOf(x).length ? `(${esc(keywordsOf(x).join(', '))})` : ''}`).join(' · ')} · 못 찾으면 ‘${esc(secName(sec))}’에 넣어요` : `파일 이름으로 영역을 자동으로 나눠요: ${state.sections.map((x, i) => `<b>${i + 1}차시</b>→${esc(secName(x))}`).join(' · ')} · 다르면 설정의 ‘파일 이름 키워드’로 지정하거나 목록에서 영역을 바꿔 주세요`)
    : '또는 클릭해서 선택 · 여러 파일 가능 · 파일은 이 컴퓨터 밖으로 전송되지 않아요';

  const c = counts(sec.id);
  $('#files-summary').textContent = c.n ? `‘${secName(sec)}’ 파일 ${c.n}개 · 학생 ${c.students}명 · 성공 ${c.s} · 실패 ${c.x}${c.p ? ` · 대기/진행 ${c.p}` : ''}` : `‘${secName(sec)}’에 아직 올린 파일이 없어요.`;
  $('#regrade-all').hidden = !c.n;
  $('#clear-all').hidden = !c.n;

  const notice = $('#files-notice');
  const ids = filesOf(sec.id);
  const stale = ids.some((id) => isStale(state.files.get(id)));
  let nh = '';
  if (!sec.criteria.length) nh = `‘${esc(secName(sec))}’의 채점 기준이 아직 저장되지 않았어요. 올린 파일은 기준을 저장하면 바로 채점돼요. <a href="#settings">설정으로 이동</a>`;
  else if (stale) nh = '설정이 바뀌었어요. 새 기준으로 점수를 다시 매기려면 <button type="button" class="btn small" data-act="regrade-sec">다시 채점</button>';
  if (notice.dataset.h !== nh) { notice.innerHTML = nh; notice.dataset.h = nh; }
  notice.hidden = !nh;

  const ul = $('#file-list');
  const rowHtml = (f) => {
    const link = f.status === 'success' || f.status === 'fail';
    const pages = f.result?.pages ? `${f.result.pages}쪽` : f.file ? fmtSize(f.size) : '–';
    const move = state.sections.length > 1 ? `<select class="sec-move" data-move="${f.id}" aria-label="${esc(f.name)} 평가 영역" title="다른 평가 영역으로 옮기기">${state.sections.map((s2) => `<option value="${s2.id}"${s2.id === f.sec ? ' selected' : ''}>${esc(secName(s2))}</option>`).join('')}</select>` : '';
    return `<span class="dot"></span>
      <span class="name" title="${esc(f.name)}">${esc(f.name)}</span>${move}
      ${f.file ? layoutSeg(f) : '<span class="seg seg-off" title="결과 파일에서 불러옴">불러온 결과</span>'}
      <span class="size">${pages}</span>
      ${link ? `<button type="button" class="status" data-link="${f.id}">${esc(statusText(f))}</button>` : `<span class="status">${esc(statusText(f))}</span>`}
      <button type="button" class="remove" data-remove="${f.id}" aria-label="${esc(f.name)} 업로드 취소" title="업로드 취소">${X_ICON}</button>`;
  };
  // 목록 구성이 그대로면 상태가 바뀐 줄만 고친다 (파일이 수백 개여도 렉 없음)
  const ver = `${listVersion}|${sec.id}`;
  if (ul.dataset.v === ver) {
    for (const li of ul.children) {
      const f = state.files.get(li.dataset.id);
      if (!f) continue;
      const key = rowKey(f);
      if (li.dataset.k !== key) { li.className = `file-row ${f.status}`; li.dataset.k = key; li.innerHTML = rowHtml(f); }
    }
    return;
  }
  ul.innerHTML = ids.map((id) => {
    const f = state.files.get(id);
    return `<li class="file-row ${f.status}" data-id="${id}" data-k="${esc(rowKey(f))}">${rowHtml(f)}</li>`;
  }).join('');
  ul.dataset.v = ver;
}
function renderBadges() {
  const c = counts();
  const bf = $('#badge-files'), br = $('#badge-results');
  bf.hidden = !c.n; bf.textContent = c.n;
  br.hidden = !c.students; br.textContent = c.students;
}

// ── 결과 화면 렌더링 ──────────────────────────────────────────────────────
const fmt = (n) => (n == null ? '' : Number.isInteger(n) ? String(n) : n.toFixed(1));
const BAD = '(채점 불가)';
const scoreOf = (st, crit) => { const hit = st.scores?.find((x) => x.name === crit.name); return hit ? hit.score : undefined; };
const scoreObj = (st, crit) => st.scores?.find((x) => x.name === crit.name);
const studentLabel = (f, st) => st.name || '';

// ── 직접 수정한 값 (파일마다 학생 번호별로 보관, 다시 채점해도 유지) ──
const editOf = (f, st) => f.edits?.[st.idx];
const hasEdit = (e) => !!e && (Object.keys(e.scores || {}).length > 0 || e.total != null || e.studentId != null || e.name != null);
const valOf = (f, st, c) => { const e = editOf(f, st); if (e?.scores && c.name in e.scores) return e.scores[c.name]; return st.status === 'success' ? scoreOf(st, c) : undefined; };
const idOf = (f, st) => editOf(f, st)?.studentId ?? st.studentId ?? '';
const nameOf = (f, st) => editOf(f, st)?.name ?? studentLabel(f, st);
const scoreEdited = (f, st) => Object.keys(editOf(f, st)?.scores || {}).length > 0;
function totalEff(f, st, sec) {
  const e = editOf(f, st);
  if (e?.total != null) return e.total;
  if (st.status === 'success' && !scoreEdited(f, st)) return st.total;
  if (st.status !== 'success' && !scoreEdited(f, st)) return null;
  const vals = sec.criteria.map((c) => { const v = valOf(f, st, c); return v == null ? null : v; });
  return computeTotal(rubricOf(sec), vals);
}
const isBad = (f, st) => st.status === 'fail' && !hasEdit(editOf(f, st));
const isWait = (f, st) => st.status === 'wait' && !hasEdit(editOf(f, st)); // 스캔본: Claude 채점 전
// 표 머리글은 짧게 두 줄로 (항목 이름 + 작은 글씨로 배점/감점) → 점수 칸이 좁아져 표가 한 화면에 들어옴
const critHead = (sec, c) => `<span class="th-name">${esc(c.name)}</span><small>${rubricOf(sec).mode === 'deduct' ? '감점' : `${fmt(c.points)}점`}</small>`;
const totalHead = (sec) => { const r = rubricOf(sec); return `<span class="th-name">총점</span><small>${fmt(r.max)}점${r.mode === 'deduct' ? ' 만점' : ''}${r.floor != null ? ` · 최저 ${fmt(r.floor)}` : ''}</small>`; };
const fmtScore = (sec, v) => (v == null ? '' : rubricOf(sec).mode === 'deduct' && v < 0 ? `−${fmt(-v)}` : fmt(v));
// 학번 순 정렬 (학번이 없으면 맨 뒤, 같으면 학급·순서대로)
function byStudentId(a, b) {
  const ia = idOf(a.f, a.st), ib = idOf(b.f, b.st);
  if (!ia !== !ib) return ia ? -1 : 1;
  return collator.compare(ia, ib) || collator.compare(a.f.name, b.f.name) || a.st.idx - b.st.idx;
}
const studentsOf = (ids) => ids.flatMap((id) => { const f = state.files.get(id); return f.result ? f.result.students.map((st) => ({ f, st })) : []; }).sort(byStudentId);
const fileTitle = (f) => f.name.replace(/\.pdf$/i, '');

// ── 아주 작은 마크다운 → HTML (학생 답안·채점 근거 표시용, 글자는 모두 이스케이프) ──
function mdInline(t) {
  return esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, '$1<i>$2</i>').replace(/`([^`]+)`/g, '<code>$1</code>');
}
export function mdToHtml(src) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let list = null, quote = [], para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(mdInline).join('<br>')}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((x) => `<li>${mdInline(x)}</li>`).join('')}</${list.tag}>`); list = null; } };
  const flushQuote = () => { if (quote.length) { out.push(`<blockquote>${mdToHtml(quote.join('\n'))}</blockquote>`); quote = []; } };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    let m;
    if ((m = line.match(/^\s*>\s?(.*)$/))) { flushPara(); flushList(); quote.push(m[1]); continue; }
    flushQuote();
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if ((m = line.match(/^\s*#{1,6}\s+(.*)$/))) { flushAll(); out.push(`<h5>${mdInline(m[1])}</h5>`); continue; }
    if ((m = line.match(/^\s*(?:[-*•·]|(\d+)[.)])\s+(.*)$/))) {
      flushPara();
      const tag = m[1] ? 'ol' : 'ul';
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push(m[2]); continue;
    }
    if (list && /^\s{2,}\S/.test(raw)) { list.items[list.items.length - 1] += ` ${line.trim()}`; continue; }
    flushList(); para.push(line.trim());
  }
  flushAll();
  return out.join('');
}

function validResult() {
  const r = state.result;
  if (r.kind === 'file' && !state.files.has(r.file)) return (state.result = secById(r.sec) ? { kind: 'sec', sec: r.sec } : { kind: 'all' });
  if (r.kind === 'sec' && !secById(r.sec)) return (state.result = { kind: 'all' });
  return r;
}

function renderResults() {
  const tabs = $('#result-tabs');
  const body = $('#result-body');
  const sel = validResult();
  $('#export-csv').hidden = !state.files.size;

  const anyStale = state.order.some((id) => isStale(state.files.get(id)));
  const notice = $('#results-notice');
  notice.hidden = !anyStale;
  if (anyStale && !notice.innerHTML) notice.innerHTML = '설정이 바뀌어 일부 점수는 이전 기준으로 매겨졌어요. <button type="button" class="btn small" data-act="regrade">새 기준으로 다시 채점</button>';

  // 전체 결과표 | 영역 이름 ▾ …
  const tabsHtml = [`<button type="button" class="tab" role="tab" data-rtab="all" aria-selected="${sel.kind === 'all'}">전체 결과표</button>`]
    .concat(state.sections.map((s) => {
      const on = sel.kind !== 'all' && sel.sec === s.id;
      const c = counts(s.id);
      const cur = on && sel.kind === 'file' ? ` · ${esc(fileTitle(state.files.get(sel.file)))}` : on ? ' · 모든 학급' : '';
      const dot = c.x ? 'fail' : c.s ? 'success' : '';
      return `<button type="button" class="tab sec-rtab" role="tab" data-rtab="${s.id}" aria-selected="${on}" aria-haspopup="menu"${menuFor === s.id ? ' aria-expanded="true"' : ''} title="${esc(secName(s))}: 눌러서 학급 고르기"><span class="tdot ${dot}"></span>${esc(secName(s))}${cur}${c.n ? ` <small>학급 ${c.n}</small>` : ''} <span class="caret" aria-hidden="true">▾</span></button>`;
    })).join('');
  if (tabs.dataset.h !== tabsHtml) {
    tabs.innerHTML = tabsHtml; tabs.dataset.h = tabsHtml;
    const selBtn = tabs.querySelector('[aria-selected="true"]');
    if (selBtn) {
      const l = selBtn.offsetLeft - tabs.offsetLeft, r = l + selBtn.offsetWidth;
      if (l < tabs.scrollLeft) tabs.scrollLeft = l - 8;
      else if (r > tabs.scrollLeft + tabs.clientWidth) tabs.scrollLeft = r - tabs.clientWidth + 8;
    }
  }
  if (menuFor) refreshMenu();

  if (editing && body.contains(editing)) return; // 칸을 고치는 중에는 표를 그대로 둔다
  // 채점 중 표가 다시 그려져도 보고 있던 스크롤 위치를 유지
  const viewKey = `${sel.kind}|${sel.sec || ''}|${sel.file || ''}`;
  const prevWraps = [...body.querySelectorAll('.table-wrap')];
  const keep = body.dataset.key === viewKey ? prevWraps.map((w) => [w.scrollTop, w.scrollLeft]) : null;
  if (!state.files.size) body.innerHTML = '<div class="empty">아직 채점한 파일이 없어요. <a href="#files">업로드 파일</a>에서 PDF를 올려 주세요.</div>';
  else if (sel.kind === 'all') body.innerHTML = renderAllSections();
  else if (sel.kind === 'sec') body.innerHTML = `<div class="stack">${renderSectionTable(secById(sel.sec))}${FOOT}</div>`;
  else body.innerHTML = renderDetail(state.files.get(sel.file));
  body.dataset.key = viewKey;
  if (keep) body.querySelectorAll('.table-wrap').forEach((w, i) => { if (keep[i]) { w.scrollTop = keep[i][0]; w.scrollLeft = keep[i][1]; } });
}

const edCell = (f, st, field, html, cls, orig) => {
  const e = editOf(f, st);
  const edited = field === 'id' ? e?.studentId != null : field === 'name' ? e?.name != null : field === 'total' ? e?.total != null : e?.scores && field.slice(2) in e.scores;
  return `<td class="ed ${cls}${edited ? ' edited' : ''}" data-ed="${f.id}|${st.idx}|${esc(field)}" title="${edited ? `직접 수정함 · 원래 값: ${esc(orig ?? '없음')} · 지우면 원래 값으로` : '눌러서 수정'}">${html}</td>`;
};
function scoreCells(f, st, sec) {
  const crit = sec.criteria;
  const bad = isBad(f, st), wait = isWait(f, st);
  const cells = crit.map((c) => {
    const v = valOf(f, st, c);
    const orig = st.status === 'success' ? fmtScore(sec, scoreOf(st, c)) : st.status === 'wait' ? '채점 전' : BAD;
    if (v == null) return edCell(f, st, `s:${c.name}`, bad ? BAD : '–', `num ${bad ? 'bad' : 'pending'}`, orig);
    return edCell(f, st, `s:${c.name}`, fmtScore(sec, v), 'num', orig);
  }).join('');
  const t = totalEff(f, st, sec);
  const origT = st.status === 'success' ? fmt(st.total) : st.status === 'wait' ? '채점 전' : BAD;
  const tag = st.blank ? '<span class="demo-tag">백지</span>' : st.mode === 'text' && !hasEdit(editOf(f, st)) ? '<span class="demo-tag" title="글자 PDF를 키워드로 매긴 임시 점수">데모</span>' : '';
  if (t == null) return cells + edCell(f, st, 'total', wait ? '<span class="wait-tag">채점 전</span>' : BAD, `num total ${wait ? 'pending' : 'bad'}`, origT);
  return cells + edCell(f, st, 'total', `${fmt(t)}${tag}`, 'num total', origT);
}
const UNREAD = '<span class="unread" title="손글씨 스캔본은 Claude 채점 후 학번·이름이 채워져요. 눌러서 직접 적을 수도 있어요">판독 전</span>';
const idCells = (f, st) => {
  const scan = st.mode === 'scan' || st.mode === 'claude';
  return edCell(f, st, 'id', idOf(f, st) ? esc(idOf(f, st)) : scan ? UNREAD : '–', 'idc', st.studentId || '없음')
    + edCell(f, st, 'name', nameOf(f, st) ? esc(nameOf(f, st)) : scan ? UNREAD : '–', 'namec', st.name || '없음');
};
const viewBtn = (f, st) => (f.file ? `<td class="vcell"><button type="button" class="btn tiny" data-view-st="${f.id}|${st.idx}" title="이 학생의 답안지와 채점 근거 보기">답안지</button></td>` : '<td class="vcell"></td>');

const FOOT = `<p class="muted foot">※ ‘판독 전’·‘채점 전’은 손글씨 스캔본이라 아직 Claude가 채점하지 않은 학생이에요. 업로드 화면의 ‘Claude 채점 시작’ 후 결과를 불러오면 학번·이름·점수가 채워져요. 빨간색 ${BAD}는 글씨를 판독하지 못한 경우예요. 점수·학번·이름 칸을 누르면 직접 고칠 수 있어요(고친 칸은 노란색). 학급 이름을 누르면 그 학급의 채점 근거와 답안이 함께 나와요.</p>`;

// 한 영역의 모든 학생을 한 표로 (영역마다 채점 항목이 달라서 표를 영역별로 나눈다)
function renderSectionTable(sec) {
  const ids = filesOf(sec.id);
  const crit = sec.criteria;
  const c = counts(sec.id);
  const title = `<div class="sec-title"><h2>${esc(secName(sec))}</h2><span class="muted">${ids.length ? `학급 ${ids.length}개 · 학생 ${c.students}명` : '올린 파일 없음'}</span></div>`;
  if (!ids.length) return `${title}<div class="empty">이 영역에 올린 파일이 없어요. <a href="#files" data-go-sec="${sec.id}">업로드 파일</a>에서 올려 주세요.</div>`;
  if (!crit.length) return `${title}<div class="empty">‘${esc(secName(sec))}’의 채점 기준이 아직 저장되지 않았어요. <a href="#settings" data-go-sec="${sec.id}">설정</a>에서 저장하면 바로 채점돼요.</div>`;
  const head = `<tr><th>학번</th><th>이름</th><th>학급</th><th>쪽</th>${crit.map((x) => `<th class="num">${critHead(sec, x)}</th>`).join('')}<th class="num">${totalHead(sec)}</th><th class="vcell"></th></tr>`;
  const rows = studentsOf(ids).map(({ f, st }) => `<tr>${idCells(f, st)}<td class="cls"><button type="button" class="linkish" data-open-file="${f.id}" title="${esc(fileTitle(f))}">${esc(fileTitle(f))}</button></td><td class="pg">${esc(st.pageLabel || '–')}</td>${scoreCells(f, st, sec)}${viewBtn(f, st)}</tr>`);
  for (const id of ids) {
    const f = state.files.get(id);
    if (f.result) continue;
    const label = f.status === 'grading' ? '읽는 중…' : '대기 중';
    rows.push(`<tr><td>–</td><td>–</td><td class="cls"><button type="button" class="linkish" data-open-file="${id}">${esc(fileTitle(f))}</button></td><td>–</td>${crit.map(() => `<td class="num pending">${label}</td>`).join('')}<td class="num pending">${label}</td><td class="vcell"></td></tr>`);
  }
  return `${title}<div class="table-wrap"><table class="grid"><thead>${head}</thead><tbody>${rows.join('')}</tbody></table></div>`;
}

function renderAllSections() {
  const used = state.sections.filter((s) => filesOf(s.id).length);
  if (!used.length) return '<div class="empty">아직 채점한 파일이 없어요.</div>';
  return `<div class="stack">${used.map((s) => `<section class="stack sec-block">${renderSectionTable(s)}</section>`).join('')}${FOOT}</div>`;
}

// 항목별 감점 키워드: v2 결과는 deductions[], 예전 결과는 comment, 데모는 감점 규칙에서 뽑은 키워드
function reasonChips(sec, x) {
  const rb = rubricOf(sec);
  if (x.deductions?.length) return x.deductions.map((d) => `<span class="kw">${esc(d.keyword)}${d.points ? ` <b>${fmtScore(sec, -Math.abs(d.points))}</b>` : ''}</span>`).join('');
  if (rb.mode === 'deduct' && x.score === 0) return '<span class="kw ok">감점 없음</span>';
  if (!x.comment) return '';
  const c = x.comment.length > 40 ? shortReason(x.comment, x.name) : x.comment; // 기준 문장을 통째로 옮긴 근거는 키워드로 줄임
  return `<span class="kw">${esc(c)}</span>`;
}
// 학생 한 명의 채점 근거 + 학생 답안 (마크다운 형식으로 정리)
function whyHtml(f, st, sec) {
  if (isWait(f, st)) return `<div class="why-empty">아직 Claude가 채점하지 않았어요. ${f.file ? '‘답안지’ 버튼으로 원본을 볼 수 있어요.' : ''}</div>`;
  if (st.status === 'fail') return `<div class="why-empty bad">${esc(st.reason || '판독 불가')}</div>`;
  const rb = rubricOf(sec);
  const items = sec.criteria.map((c) => {
    const x = scoreObj(st, c) || { name: c.name, score: null };
    const v = valOf(f, st, c);
    const edited = editOf(f, st)?.scores && c.name in editOf(f, st).scores;
    const sc = v == null ? '–' : rb.mode === 'deduct' ? (v === 0 ? '0' : fmtScore(sec, v)) : `${fmt(v)}/${fmt(c.points)}`;
    const extra = x.deductions?.length && x.comment && x.comment.length <= 80 ? `<div class="wi-note">${mdInline(x.comment)}</div>` : '';
    const ans = x.answer ? `<blockquote class="ans">${mdToHtml(x.answer)}</blockquote>` : '';
    const ded = rb.mode === 'deduct' ? v != null && v < 0 : v != null && v < c.points;
    return `<div class="why-item${ded ? ' ded' : ''}"><div class="wi-head"><b>${esc(c.name)}</b><span class="wi-score">${sc}${edited ? ' <small>(수정)</small>' : ''}</span></div><div class="kws">${reasonChips(sec, x)}</div>${extra}${ans}</div>`;
  }).join('');
  const hasItemAns = (st.scores || []).some((x) => x.answer);
  const whole = !hasItemAns && st.answer ? `<details class="why-ans"${st.mode === 'claude' ? ' open' : ''}><summary>학생 답안 전체</summary><div class="md">${mdToHtml(st.answer)}</div></details>` : '';
  const note = st.comment && st.mode === 'claude' ? `<div class="wi-note">총평: ${mdInline(st.comment)}</div>` : '';
  return `<div class="why-grid">${items}</div>${note}${whole}`;
}

function renderDetail(f) {
  const sec = secById(f.sec);
  const r = f.result;
  const crit = sec.criteria;
  const stat = (k, v, cls = '') => `<div class="stat"><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`;
  const title = `<div class="sec-title"><h2>${esc(secName(sec))} · ${esc(fileTitle(f))}</h2>${f.file ? `<button type="button" class="btn small" data-view-st="${f.id}|">답안지 보기</button>` : ''}</div>`;
  if (f.status !== 'success' && f.status !== 'fail') {
    return `<div class="stack">${title}<div class="empty">${f.status === 'grading' ? 'PDF를 읽는 중이에요…' : canGradeFile(f) ? '아직 읽지 않았어요.' : '이 영역의 채점 기준을 저장하면 읽기 시작해요.'}</div></div>`;
  }
  const reason = f.status === 'fail' ? `<div class="notice warn">채점 실패: ${esc(f.error || '판독 불가')}</div>` : '';
  const layoutTxt = r.layout ? `${r.layout === 'set' ? `${r.per}쪽 = 1명` : LAYOUTS[r.layout]}${r.layoutAuto ? ' (자동)' : isClaude(f) ? ' (Claude)' : ' (직접 지정)'}` : '–';
  const sts = r.students;
  const done = sts.filter((x) => !isBad(f, x) && !isWait(f, x)).length;
  const bad = sts.filter((x) => isBad(f, x)).length;
  const wait = sts.filter((x) => isWait(f, x)).length;
  const top = `<div class="detail-grid">
    ${stat('학생 수', `${sts.length}명`)}
    ${wait ? stat('Claude 채점 전', `${wait}명`, 'muted') : stat('채점 완료', `${done}명`, 'good')}
    ${stat('채점 불가', `${bad}명`, bad ? 'bad' : '')}
    ${stat('나눈 방식', `<span style="font-size:15px">${r.pages ? `${layoutTxt} · ${r.pages}쪽` : '–'}</span>`)}
  </div>`;
  const cols = 5 + crit.length;
  const head = `<tr><th>학번</th><th>이름</th><th>쪽</th>${crit.map((c) => `<th class="num">${critHead(sec, c)}</th>`).join('')}<th class="num">${totalHead(sec)}</th><th class="vcell"></th></tr>`;
  const rows = studentsOf([f.id]).map(({ st }) => `<tr class="st-row">${idCells(f, st)}<td class="pg">${esc(st.pageLabel || '–')}</td>${scoreCells(f, st, sec)}${viewBtn(f, st)}</tr>`
    + (state.showWhy ? `<tr class="why-row"><td colspan="${cols}">${whyHtml(f, st, sec)}</td></tr>` : '')).join('');
  const hint = r.layoutAuto ? `<p class="muted foot">학생 나누기가 틀렸다면 <a href="#files" data-go-sec="${sec.id}">업로드 파일</a>에서 이 파일의 ‘양면/단면’ 버튼을 눌러 바꿔 주세요. 판단 근거: ${esc(r.layoutReason)}</p>` : '';
  const toggle = `<div class="why-toggle"><button type="button" class="btn small ghost" data-act="toggle-why">${state.showWhy ? '채점 근거·답안 접기' : '채점 근거·답안 펼치기'}</button></div>`;
  return `<div class="stack">${title}${reason}${top}${toggle}<div class="table-wrap detail"><table class="grid"><thead>${head}</thead><tbody>${rows}</tbody></table></div>${hint}</div>`;
}

// ── 결과 영역 드롭다운 (영역 이름을 누르면 학급 고르기) ─────────────────
const menu = $('#tab-menu');
let menuFor = null;
function menuHtml(secId) {
  const sec = secById(secId);
  const ids = filesOf(secId);
  const sel = state.result;
  const item = (attr, label, on, extra = '') => `<button type="button" role="menuitemradio" aria-checked="${on}" ${attr}>${label}${extra}</button>`;
  if (!ids.length) return '<div class="menu-empty">이 영역에 올린 파일(학급)이 없어요</div>';
  return `<div class="menu-label">학급 선택 · ${ids.length}개</div>` + ids.map((id) => {
      const f = state.files.get(id);
      const n = f.result?.students.length;
      const dot = f.status === 'success' ? 'success' : f.status === 'fail' ? 'fail' : '';
      return item(`data-pick-file="${id}"`, `<span class="tdot ${dot}"></span><span class="mname">${esc(fileTitle(f))}</span>`, sel.kind === 'file' && sel.file === id, n ? ` <small>학생 ${n}명</small>` : f.status === 'grading' ? ' <small>채점 중</small>' : '');
    }).join('')
    + '<div class="menu-sep" role="separator"></div>'
    + item(`data-pick-sec="${secId}"`, `‘${esc(secName(sec))}’ 모든 학급 한 표로 보기`, sel.kind === 'sec' && sel.sec === secId, '');
}
function refreshMenu() {
  if (!secById(menuFor)) { closeMenu(); return; }
  const h = menuHtml(menuFor);
  if (menu.dataset.h === h) return;
  const focusedId = document.activeElement?.closest?.('#tab-menu') ? (document.activeElement.dataset.pickFile || document.activeElement.dataset.pickSec) : null;
  menu.innerHTML = h; menu.dataset.h = h;
  if (focusedId) menu.querySelector(`[data-pick-file="${focusedId}"],[data-pick-sec="${focusedId}"]`)?.focus();
  placeMenu();
}
function placeMenu() {
  const btn = $(`#result-tabs [data-rtab="${menuFor}"]`);
  if (!btn) { closeMenu(); return; }
  const rb = btn.getBoundingClientRect();
  const host = $('#view-results').getBoundingClientRect();
  const w = menu.offsetWidth || 260;
  menu.style.left = `${Math.max(0, Math.min(rb.left - host.left, host.width - w))}px`;
  menu.style.top = `${rb.bottom - host.top + 6}px`;
}
function openMenu(btn, secId) {
  menuFor = secId;
  menu.dataset.h = '';
  menu.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  refreshMenu();
  (menu.querySelector('[aria-checked="true"]') || menu.querySelector('button'))?.focus({ preventScroll: true });
}
function closeMenu() {
  if (menu.hidden) return;
  menu.hidden = true; menuFor = null;
  document.querySelectorAll('#result-tabs [aria-expanded]').forEach((b) => b.removeAttribute('aria-expanded'));
}
function setResult(r) {
  state.result = r;
  const h = r.kind === 'all' ? '#results' : `#results/${r.kind === 'file' ? r.file : r.sec}`;
  if (location.hash !== h) history.replaceState(null, '', h);
  closeMenu();
  renderResults();
}

// ── 결과표 칸 직접 수정 ──────────────────────────────────────────────────
let editing = null; // 수정 중인 칸이 있으면 표를 다시 그리지 않는다
function startEdit(td, after = null) {
  const [fid, idxStr, field] = td.dataset.ed.split('|');
  const f = state.files.get(fid);
  const st = f?.result?.students.find((x) => x.idx === Number(idxStr));
  if (!f || !st) return;
  const sec = secById(f.sec);
  let cur = '';
  if (field === 'id') cur = idOf(f, st);
  else if (field === 'name') cur = nameOf(f, st);
  else if (field === 'total') cur = totalEff(f, st, sec) ?? '';
  else { const c = sec.criteria.find((x) => x.name === field.slice(2)); cur = c ? valOf(f, st, c) ?? '' : ''; }
  const input = document.createElement('input');
  input.className = 'cell-input';
  input.value = String(cur);
  input.inputMode = field === 'name' ? 'text' : 'decimal';
  input.setAttribute('aria-label', '값 수정 (Enter 저장, Esc 취소, 비우면 원래 값)');
  td.textContent = '';
  td.appendChild(input);
  td.classList.add('editing');
  editing = td;
  input.focus(); input.select();
  let done = false;
  const finish = (save) => {
    if (done) return; done = true;
    editing = null;
    if (save) commitEdit(f, st, sec, field, input.value);
    renderResults();
    after?.();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}
function commitEdit(f, st, sec, field, raw) {
  const v = raw.trim();
  f.edits = f.edits || {};
  const e = f.edits[st.idx] = f.edits[st.idx] || { scores: {} };
  const rb = rubricOf(sec);
  if (field === 'id') { if (!v || v === (st.studentId || '')) delete e.studentId; else e.studentId = v.replace(/\s/g, ''); }
  else if (field === 'name') { if (!v || v === studentLabel(f, st)) delete e.name; else e.name = v.slice(0, 20); }
  else {
    let n = v === '' ? null : Number(v.replace(/[−–]/g, '-').replace(/[^\d.\-]/g, ''));
    if (n != null && Number.isNaN(n)) { toast('숫자로 적어 주세요.'); return; }
    if (field === 'total') {
      if (n == null) delete e.total;
      else { n = Math.min(rb.max, Math.max(0, n)); e.total = n; }
    } else {
      const name = field.slice(2);
      const c = sec.criteria.find((x) => x.name === name);
      if (!c) return;
      if (n == null) delete e.scores[name];
      else {
        n = rb.mode === 'deduct' ? -Math.min(rb.max, Math.abs(n)) : Math.min(c.points, Math.max(0, n)); // 감점식은 4라고 써도 −4로
        if (st.status === 'success' && n === scoreOf(st, c)) delete e.scores[name]; else e.scores[name] = n;
      }
      delete e.total; // 항목을 고치면 총점은 다시 계산
    }
  }
  if (!hasEdit(e)) delete f.edits[st.idx];
  scheduleSave();
}

// ── 학생 답안지 보기 (왼쪽: 답안지 원본, 오른쪽: 채점 근거 · 50:50) ────────────────
const vw = { fid: null, idx: null, doc: null, docFid: null, token: 0, zoom: 1, lastFocus: null };
const viewerEl = $('#viewer');
const viewable = () => state.order.map((id) => state.files.get(id)).filter((f) => f.file && f.result?.students?.length);
function openViewer(fid = null, idx = null) {
  const list = viewable();
  if (!list.length) {
    toast(state.files.size ? '답안지를 보려면 원본 PDF가 필요해요. 업로드 파일에 그 학급 PDF를 올려 주세요.' : '먼저 업로드 파일에서 PDF를 올려 주세요.');
    return;
  }
  const sel = state.result;
  let f = (fid && state.files.get(fid)) || (sel.kind === 'file' && state.files.get(sel.file)) || null;
  if (!f || !list.includes(f)) f = list.find((x) => sel.kind === 'sec' && x.sec === sel.sec) || list[0];
  vw.fid = f.id;
  const order = studentsOf([f.id]);
  vw.idx = idx != null && order.some((o) => o.st.idx === idx) ? idx : order[0].st.idx;
  vw.lastFocus = document.activeElement;
  viewerEl.hidden = false;
  document.body.classList.add('modal-open');
  renderViewer();
  $('#vw-close').focus();
}
function closeViewer() {
  if (viewerEl.hidden) return;
  viewerEl.hidden = true;
  document.body.classList.remove('modal-open');
  vw.token++;
  if (vw.doc) { vw.doc.destroy(); vw.doc = null; vw.docFid = null; }
  $('#vw-pages').innerHTML = '';
  vw.lastFocus?.focus?.();
}
function viewerStudent() {
  const f = state.files.get(vw.fid);
  if (!f?.result) return null;
  const order = studentsOf([f.id]);
  const pos = order.findIndex((o) => o.st.idx === vw.idx);
  return { f, order, pos, st: order[pos]?.st };
}
function moveViewer(step) {
  const v = viewerStudent();
  if (!v) return;
  let pos = v.pos + step;
  if (pos < 0 || pos >= v.order.length) {
    // 학급의 처음/끝이면 이전/다음 학급으로
    const list = viewable();
    const fi = list.indexOf(v.f) + (step > 0 ? 1 : -1);
    if (fi < 0 || fi >= list.length) { toast(step > 0 ? '마지막 학생이에요.' : '첫 학생이에요.'); return; }
    vw.fid = list[fi].id;
    const o = studentsOf([vw.fid]);
    vw.idx = (step > 0 ? o[0] : o[o.length - 1]).st.idx;
  } else vw.idx = v.order[pos].st.idx;
  renderViewer();
}
const stLabel = (f, st) => `${idOf(f, st) || '학번 판독 전'} ${nameOf(f, st) || ''}`.trim() + ` · ${st.pageLabel || '쪽 정보 없음'}`;
function renderViewer() {
  const v = viewerStudent();
  if (!v || !v.st) { closeViewer(); return; }
  const { f, order, pos, st } = v;
  const sec = secById(f.sec);
  $('#vw-file').innerHTML = viewable().map((x) => `<option value="${x.id}"${x.id === f.id ? ' selected' : ''}>${esc(secName(secById(x.sec)))} · ${esc(fileTitle(x))}</option>`).join('');
  $('#vw-student').innerHTML = order.map((o, i) => `<option value="${o.st.idx}"${o.st.idx === st.idx ? ' selected' : ''}>${i + 1}. ${esc(stLabel(f, o.st))}</option>`).join('');
  $('#vw-pos').textContent = `${pos + 1} / ${order.length}명`;
  renderViewerRight();
  renderViewerPages(f, st);
}
function renderViewerRight() {
  const v = viewerStudent();
  if (!v?.st) return;
  const { f, st } = v;
  const sec = secById(f.sec);
  const crit = sec.criteria;
  const head = `<tr><th>학번</th><th>이름</th>${crit.map((c) => `<th class="num">${critHead(sec, c)}</th>`).join('')}<th class="num">${totalHead(sec)}</th></tr>`;
  $('#vw-why').innerHTML = `
    <div class="vw-title"><h3>${esc(idOf(f, st) || '')} ${esc(nameOf(f, st) || '')}${!idOf(f, st) && !nameOf(f, st) ? '<span class="unread">학번·이름 판독 전</span>' : ''}</h3><span class="muted">${esc(secName(sec))} · ${esc(fileTitle(f))} · ${esc(st.pageLabel || '')}</span></div>
    <div class="table-wrap vw-table"><table class="grid"><thead>${head}</thead><tbody><tr>${idCells(f, st)}${scoreCells(f, st, sec)}</tr></tbody></table></div>
    <p class="muted foot">칸을 누르면 바로 고칠 수 있어요 (Enter 저장).</p>
    <div class="vw-reasons">${whyHtml(f, st, sec)}</div>`;
}
async function renderViewerPages(f, st) {
  const box = $('#vw-pages');
  const token = ++vw.token;
  if (!st.pages?.length) { box.innerHTML = '<div class="why-empty">이 학생의 쪽 정보가 없어요. (결과 파일에 쪽 번호가 없음)</div>'; return; }
  box.innerHTML = st.pages.map((p) => `<figure class="vw-page" data-p="${p}"><div class="vw-loading">${p}쪽 불러오는 중…</div><figcaption>${p}쪽</figcaption></figure>`).join('');
  box.scrollTop = 0;
  try {
    if (vw.docFid !== f.id) {
      if (vw.doc) { vw.doc.destroy(); vw.doc = null; }
      vw.docFid = null;
      const doc = await openPdf(f.file);
      if (token !== vw.token) { doc.destroy(); return; } // 그사이 다른 학생·학급으로 넘어감
      vw.doc = doc; vw.docFid = f.id;
    }
    const doc = vw.doc;
    const width = Math.max(320, box.clientWidth - 24) * vw.zoom;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const p of st.pages) {
      if (token !== vw.token) return;
      const fig = box.querySelector(`[data-p="${p}"]`);
      if (!fig) continue;
      if (p > doc.numPages) { fig.querySelector('.vw-loading').textContent = `${p}쪽이 PDF에 없어요`; continue; }
      const page = await doc.getPage(p);
      const vp1 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: (width * dpr) / vp1.width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
      canvas.style.width = `${Math.round(width)}px`;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      page.cleanup();
      if (token !== vw.token) return;
      fig.querySelector('.vw-loading')?.replaceWith(canvas);
    }
  } catch (e) {
    console.error(e);
    if (token === vw.token) box.innerHTML = '<div class="why-empty bad">답안지를 그리지 못했어요. PDF가 손상되었을 수 있어요.</div>';
  }
}
function initViewer() {
  $('#vw-close').addEventListener('click', closeViewer);
  viewerEl.addEventListener('click', (e) => { if (e.target === viewerEl) closeViewer(); });
  $('#vw-prev').addEventListener('click', () => moveViewer(-1));
  $('#vw-next').addEventListener('click', () => moveViewer(1));
  $('#vw-file').addEventListener('change', (e) => { vw.fid = e.target.value; vw.idx = studentsOf([vw.fid])[0]?.st.idx; renderViewer(); });
  $('#vw-student').addEventListener('change', (e) => { vw.idx = Number(e.target.value); renderViewer(); });
  const zoom = (z) => { vw.zoom = Math.min(2.5, Math.max(0.6, Math.round(z * 10) / 10)); $('#vw-zoom-v').textContent = `${Math.round(vw.zoom * 100)}%`; const v = viewerStudent(); if (v?.st) renderViewerPages(v.f, v.st); };
  $('#vw-zoom-out').addEventListener('click', () => zoom(vw.zoom - 0.2));
  $('#vw-zoom-in').addEventListener('click', () => zoom(vw.zoom + 0.2));
  $('#vw-why').addEventListener('click', (e) => {
    const td = e.target.closest('td[data-ed]');
    if (td && !td.querySelector('input')) startEdit(td, () => { renderViewerRight(); const v = viewerStudent(); if (v) $('#vw-student').innerHTML = v.order.map((o, i) => `<option value="${o.st.idx}"${o.st.idx === vw.idx ? ' selected' : ''}>${i + 1}. ${esc(stLabel(v.f, o.st))}</option>`).join(''); });
  });
  document.addEventListener('keydown', (e) => {
    if (viewerEl.hidden) return;
    if (e.key === 'Escape' && !e.target.closest?.('.cell-input')) { e.preventDefault(); closeViewer(); return; }
    if (e.target.closest?.('input, select, textarea')) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); moveViewer(1); }
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); moveViewer(-1); }
  });
  // 창 안에서만 Tab 이동
  viewerEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const items = [...viewerEl.querySelectorAll('button, select, input, [tabindex="0"]')].filter((x) => !x.disabled && x.offsetParent);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  let rt = 0;
  window.addEventListener('resize', () => { if (viewerEl.hidden) return; clearTimeout(rt); rt = setTimeout(() => { const v = viewerStudent(); if (v?.st) renderViewerPages(v.f, v.st); }, 250); });
}

// ── CSV(엑셀) 내려받기: 지금 보고 있는 범위만 ─────────────────────────────
function exportCsv() {
  const q = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const sel = validResult();
  const secs = sel.kind === 'all' ? state.sections : [secById(sel.sec)];
  const lines = [];
  for (const sec of secs) {
    let ids = filesOf(sec.id);
    if (sel.kind === 'file') ids = ids.filter((id) => id === sel.file);
    if (!ids.length) continue;
    const crit = sec.criteria;
    if (lines.length) lines.push([]);
    const rb = rubricOf(sec);
    lines.push(['영역', '학번', '이름', '학급', '쪽', ...crit.map((c) => (rb.mode === 'deduct' ? `${c.name}(감점)` : `${c.name}(${c.points})`)), `총점(${rb.max})`, '상태', '감점 근거']);
    for (const { f, st } of studentsOf(ids)) {
      const bad = isBad(f, st);
      const t = totalEff(f, st, sec);
      const id = idOf(f, st);
      lines.push([
        secName(sec), id ? `="${id}"` : '', nameOf(f, st), fileTitle(f), st.pageLabel,
        ...crit.map((c) => { const v = valOf(f, st, c); return v == null ? (bad ? BAD : '') : fmt(v); }),
        t == null ? (isWait(f, st) ? '' : BAD) : fmt(t),
        hasEdit(editOf(f, st)) ? '직접 수정' : bad ? `실패: ${st.reason || f.error}` : isWait(f, st) ? 'Claude 채점 전' : st.mode === 'text' ? '성공(데모 점수)' : '성공',
        (st.scores || []).map((x) => { const k = x.deductions?.length ? x.deductions.map((d) => d.keyword).join(', ') : x.score ? x.comment : ''; return k ? `${x.name}: ${k}` : ''; }).filter(Boolean).join(' / '),
      ]);
    }
    for (const id of ids) { const f = state.files.get(id); if (!f.result) lines.push([secName(sec), '', '', fileTitle(f), '', ...crit.map(() => ''), '', '대기']); }
  }
  if (!lines.length) { toast('내려받을 결과가 없어요.'); return; }
  const csv = '﻿' + lines.map((r) => r.map((v, i) => (i === 1 && String(v).startsWith('="') ? v : q(v))).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  const d = new Date();
  const part = sel.kind === 'all' ? '전체' : (secName(secById(sel.sec)) + (sel.kind === 'file' ? `_${fileTitle(state.files.get(sel.file))}` : '')).replace(/[\\/:*?"<>|]/g, '_');
  a.href = URL.createObjectURL(blob);
  a.download = `토론채점결과_${part}_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ── 이벤트 연결 (위임 방식: 목록이 커져도 가벼움) ────────────────────────────
function initEvents() {
  const input = $('#file-input');
  input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });

  const dz = $('#dropzone');
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; dz.classList.add('over'); });
  window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) dz.classList.remove('over'); });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); depth = 0; dz.classList.remove('over');
    addFiles(e.dataTransfer.files);
    if (state.view !== 'files') location.hash = '#files';
  });

  $('#files-sec-tabs').addEventListener('click', (e) => {
    const t = e.target.closest('[data-sec]');
    if (!t || t.dataset.sec === state.activeSec) return;
    state.activeSec = t.dataset.sec;
    formSec = null;
    persist();
    renderFiles();
  });

  $('#file-list').addEventListener('change', (e) => {
    const sel = e.target.closest('[data-move]');
    if (sel) moveFile(sel.dataset.move, sel.value);
  });
  $('#file-list').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-remove]');
    if (rm) { removeFile(rm.dataset.remove); return; }
    const lb = e.target.closest('[data-layout]');
    if (lb) { setLayout(lb.closest('[data-seg]').dataset.seg, lb.dataset.layout); return; }
    const ln = e.target.closest('[data-link]');
    if (ln) location.hash = `#results/${ln.dataset.link}`;
  });

  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-act="regrade"]')) regradeAll();
    if (e.target.closest('[data-act="toggle-why"]')) { state.showWhy = !state.showWhy; renderResults(); }
    const vb = e.target.closest('[data-view-st]');
    if (vb) { const [fid, idx] = vb.dataset.viewSt.split('|'); openViewer(fid, idx ? Number(idx) : null); }
    if (e.target.closest('[data-act="regrade-sec"]')) regradeAll(state.activeSec);
    const go = e.target.closest('[data-go-sec]');
    if (go && secById(go.dataset.goSec)) { state.activeSec = go.dataset.goSec; formSec = null; persist(); }
    if (!menu.hidden && !e.target.closest('#tab-menu') && !e.target.closest('#result-tabs')) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) {
      const b = $(`#result-tabs [data-rtab="${menuFor}"]`);
      closeMenu(); b?.focus();
    }
  });
  $('#regrade-all').addEventListener('click', () => regradeAll(state.activeSec));

  const clearBtn = $('#clear-all');
  let armed = 0;
  clearBtn.addEventListener('click', () => {
    if (!armed) {
      clearBtn.textContent = '한 번 더 누르면 이 영역 파일 모두 삭제';
      armed = setTimeout(() => { armed = 0; clearBtn.textContent = '전체 삭제'; }, 3000);
      return;
    }
    clearTimeout(armed); armed = 0; clearBtn.textContent = '전체 삭제';
    for (const id of filesOf(state.activeSec)) removeFile(id);
    toast(`‘${secName(activeSection())}’ 목록을 비웠어요.`);
  });

  $('#result-tabs').addEventListener('click', (e) => {
    const t = e.target.closest('[data-rtab]');
    if (!t) return;
    if (t.dataset.rtab === 'all') { setResult({ kind: 'all' }); return; }
    if (menuFor === t.dataset.rtab) { closeMenu(); return; }
    closeMenu();
    openMenu(t, t.dataset.rtab);
  });
  $('#result-tabs').addEventListener('scroll', () => { if (menuFor) placeMenu(); }, { passive: true });
  menu.addEventListener('click', (e) => {
    const s = e.target.closest('[data-pick-sec]');
    if (s) { setResult({ kind: 'sec', sec: s.dataset.pickSec }); return; }
    const f = e.target.closest('[data-pick-file]');
    if (f) { const file = state.files.get(f.dataset.pickFile); if (file) setResult({ kind: 'file', sec: file.sec, file: file.id }); }
  });
  menu.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...menu.querySelectorAll('button')];
    const i = items.indexOf(document.activeElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  });
  $('#result-body').addEventListener('click', (e) => {
    const td = e.target.closest('td[data-ed]');
    if (td && !td.querySelector('input')) { startEdit(td); return; }
    const op = e.target.closest('[data-open-file]');
    if (op) { const f = state.files.get(op.dataset.openFile); if (f) setResult({ kind: 'file', sec: f.sec, file: f.id }); }
  });
  $('#export-csv').addEventListener('click', exportCsv);
  $('#view-answers').addEventListener('click', () => openViewer());
  window.addEventListener('resize', () => { if (menuFor) placeMenu(); });

  // 올린 파일·결과는 자동 저장되므로 창을 닫을 때 경고하지 않는다. 저장 중이면 바로 마저 저장.
  window.addEventListener('pagehide', () => { if (saveTimer) { clearTimeout(saveTimer); saveFiles(); } });
}

// ── 설정 파일 내보내기 / 불러오기 ─────────────────────────────────────────────
// ※ 설정 항목을 추가·변경하면 SETTINGS_FILE_VERSION을 올리고 toSettingsFile()/fromSettingsFile()을 함께 고칠 것.
//   예전 버전 파일도 계속 불러올 수 있어야 함(없는 항목은 기본값).
export const SETTINGS_FILE_FORMAT = 'debate-pdf-grader-settings';
export const SETTINGS_FILE_VERSION = 2;
function toSettingsFile() {
  flushPendingInputs();
  return {
    format: SETTINGS_FILE_FORMAT,
    version: SETTINGS_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    idDigits: state.idDigits,
    sections: state.sections.map((s) => {
      const draft = store.get(draftKey(s.id));
      const out = { name: s.name, criteriaText: s.criteriaText, layoutDefault: s.layoutDefault, notes: s.notes, keywords: s.keywords || '' };
      if (typeof draft === 'string' && draft !== s.criteriaText) out.criteriaDraft = draft; // 저장 안 한 작성 중 내용
      return out;
    }),
  };
}
// 어떤 버전의 파일이든 현재 형식 {idDigits, sections:[{name, criteriaText, criteriaDraft, layoutDefault, notes, keywords}]}로 바꾼다
// v1 파일에는 keywords(파일 이름 키워드)가 없으므로 빈 값
function fromSettingsFile(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('설정 파일 형식이 아니에요.');
  const str = (v) => (typeof v === 'string' ? v : '');
  const sec = (x, i) => ({
    name: (str(x?.name).trim() || `평가 ${i + 1}`).slice(0, 30),
    criteriaText: str(x?.criteriaText),
    criteriaDraft: typeof x?.criteriaDraft === 'string' ? x.criteriaDraft : null,
    layoutDefault: ['auto', 'duplex', 'simplex'].includes(x?.layoutDefault) ? x.layoutDefault : 'auto',
    notes: str(x?.notes),
    keywords: str(x?.keywords).slice(0, 200),
  });
  let sections;
  if (Array.isArray(obj.sections)) {
    if (obj.format && obj.format !== SETTINGS_FILE_FORMAT) throw new Error('이 프로그램의 설정 파일이 아니에요.');
    if (Number(obj.version) > SETTINGS_FILE_VERSION) throw new Error('더 새 버전 프로그램에서 만든 파일이에요. 페이지를 새로고침(Ctrl+Shift+R)한 뒤 다시 불러와 주세요.');
    sections = obj.sections.slice(0, MAX_SECTIONS).map(sec);
  } else if ('criteriaText' in obj || 'criteria' in obj) {
    sections = [sec({ ...obj, name: '평가 1' }, 0)]; // 영역 탭이 생기기 전 형식
  } else throw new Error('설정 파일에서 평가 영역을 찾지 못했어요.');
  if (!sections.length) throw new Error('설정 파일에 평가 영역이 없어요.');
  return { idDigits: Number(obj.idDigits) === 4 ? 4 : 5, sections };
}
function exportSettings() {
  const data = JSON.stringify(toSettingsFile(), null, 2);
  const a = document.createElement('a');
  const d = new Date();
  a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  a.download = `토론채점기_설정_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`설정을 파일로 내보냈어요. (평가 영역 ${state.sections.length}개)`);
}
let pendingImport = null;
async function readSettingsFile(file) {
  const box = $('#import-notice');
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error('파일이 너무 커요. 내보낸 설정 파일(.json)을 골라 주세요.');
    let obj;
    try { obj = JSON.parse((await file.text()).replace(/^\uFEFF/, '')); } catch { throw new Error('설정 파일(.json)을 읽지 못했어요.'); }
    pendingImport = fromSettingsFile(obj);
    const names = pendingImport.sections.map((x) => `‘${esc(x.name)}’`).join(', ');
    const lost = state.sections.filter((s) => !pendingImport.sections.some((x) => x.name === s.name.trim()) && filesOf(s.id).length);
    box.innerHTML = `<span class="grow"><b>${esc(file.name)}</b> · 학번 ${pendingImport.idDigits}자리 · 평가 영역 ${pendingImport.sections.length}개 (${names})<br><span class="muted">지금 설정을 이 파일 내용으로 바꿔요. 이름이 같은 영역은 올린 파일이 그대로 남아요.${lost.length ? ` 파일에 없는 영역(${lost.map((s) => esc(secName(s))).join(', ')})과 그 영역에 올린 파일은 사라져요.` : ''}</span></span>
      <button type="button" class="btn small primary" data-import="apply">불러오기</button><button type="button" class="btn small ghost" data-import="cancel">취소</button>`;
    box.hidden = false;
  } catch (e) {
    pendingImport = null;
    box.hidden = true;
    toast(e.message || '설정 파일을 읽지 못했어요.');
  }
}
function applyImport() {
  const imp = pendingImport;
  pendingImport = null;
  $('#import-notice').hidden = true;
  if (!imp) return;
  clearTimeout(vTimer); clearTimeout(nTimer); clearTimeout(nameTimer);
  const used = new Set();
  const next = imp.sections.map((x) => {
    const keep = state.sections.find((s) => s.name.trim() === x.name && !used.has(s.id)); // 같은 이름이면 올린 파일 유지
    const id = keep ? keep.id : newSecId();
    used.add(id);
    const c = x.criteriaText.trim() ? compileCriteria(x.criteriaText) : { criteria: [], rubric: null };
    return { id, name: x.name, criteriaText: x.criteriaText, criteria: c.criteria, rubric: c.rubric, savedAt: c.criteria.length ? Date.now() : null, notes: x.notes, layoutDefault: x.layoutDefault, keywords: x.keywords, draft: x.criteriaDraft };
  });
  for (const s of state.sections) if (!used.has(s.id)) { for (const id of filesOf(s.id)) removeFile(id); store.del(draftKey(s.id)); draftAt.delete(s.id); }
  for (const s of next) {
    if (s.draft != null && s.draft !== s.criteriaText) store.set(draftKey(s.id), s.draft); else store.del(draftKey(s.id));
    draftAt.delete(s.id);
    delete s.draft;
  }
  state.idDigits = imp.idDigits;
  state.sections = next;
  state.activeSec = next[0].id;
  if (state.result.sec && !used.has(state.result.sec)) state.result = { kind: 'all' };
  document.querySelectorAll('input[name="idDigits"]').forEach((r) => { r.checked = Number(r.value) === state.idDigits; });
  formSec = null;
  sortFiles();
  persist();
  renderSettings();
  markStale();
  invalidate('files', 'results', 'badges');
  pump();
  toast(`설정을 불러왔어요. (평가 영역 ${next.length}개)`);
}
function initSettingsIO() {
  const fileIn = $('#settings-file');
  $('#settings-export').addEventListener('click', exportSettings);
  $('#settings-import').addEventListener('click', () => fileIn.click());
  fileIn.addEventListener('change', () => { const f = fileIn.files[0]; fileIn.value = ''; if (f) readSettingsFile(f); });
  $('#import-notice').addEventListener('click', (e) => {
    const b = e.target.closest('[data-import]');
    if (!b) return;
    if (b.dataset.import === 'apply') applyImport();
    else { pendingImport = null; $('#import-notice').hidden = true; }
  });
}

// ── Claude 채점 (API 키 없이: 요청 파일 → Claude가 채점 → 결과 파일) ─────────────────
const BRIDGE_KEY = 'dpg.bridge.v1';
const cc = {
  dir: null, perm: 'none', helperAt: 0, busy: false, timer: 0,
  pending: (store.get(BRIDGE_KEY)?.pending || []).filter((x) => x && x.id).slice(-20), // [{id, at, files}]
  imported: store.get(BRIDGE_KEY)?.imported || {},  // requestId/name -> lastModified
  progress: {},   // requestId -> status.json 내용
  requests: new Map(), // 이번 창에서 보낸 요청: requestId -> Map(fileId)
};
const saveBridge = () => store.set(BRIDGE_KEY, { pending: cc.pending, imported: cc.imported });

async function buildRequest(requestId) {
  const files = state.order.map((id) => state.files.get(id)).filter((f) => f.file && secById(f.sec)?.criteria.length);
  const secs = state.sections.filter((s) => files.some((f) => f.sec === s.id));
  const manifest = {
    format: bridge.REQUEST_FORMAT, version: bridge.REQUEST_VERSION, requestId, createdAt: new Date().toISOString(),
    instructions: 'GRADING.md 의 절차대로 채점하고, 같은 폴더에 result.json 을 쓰세요.',
    idDigits: state.idDigits,
    idRule: `학번은 ${state.idDigits}자리 = 학년 1자리 + 반 ${state.idDigits - 3}자리 + 번호 2자리 (예: ${state.idDigits === 5 ? '20301 = 2학년 03반 01번' : '2301 = 2학년 3반 01번'})`,
    sections: secs.map((s) => {
      const rb = rubricOf(s);
      return {
        id: s.id, name: secName(s), criteriaText: s.criteriaText, notes: s.notes, layoutDefault: s.layoutDefault,
        rubric: rb,
        items: s.criteria.map((c) => ({ name: c.name, points: rb.mode === 'deduct' ? null : c.points, deductions: (c.deductions || []).map((d) => ({ text: d.text, points: -d.pts, keyword: d.keyword || shortReason(d.text, c.name) })) })),
        gradingPrompt: buildGradingPrompt({ prompt: s.criteriaText, criteria: s.criteria, rubric: rb, notes: s.notes, idDigits: state.idDigits }),
      };
    }),
    files: [],
  };
  const entries = [];
  const used = new Set();
  for (const f of files) {
    const sec = secById(f.sec);
    let path = `pdf/${bridge.safeName(secName(sec))}/${bridge.safeName(f.name)}`;
    for (let k = 2; used.has(path); k++) path = `pdf/${bridge.safeName(secName(sec))}/${k}_${bridge.safeName(f.name)}`;
    used.add(path);
    const r = f.result && !isClaude(f) ? f.result : null;
    manifest.files.push({
      fileId: f.id, name: f.name, path, section: secName(sec), sectionId: sec.id,
      layout: r?.layout || (layoutChoice(f) === 'auto' ? null : layoutChoice(f)), layoutChosenByTeacher: layoutChoice(f) !== 'auto',
      pagesPerStudent: r?.per || (layoutChoice(f) === 'duplex' ? 2 : layoutChoice(f) === 'simplex' ? 1 : null),
      pages: r?.pages || null,
      // 프로그램이 미리 나눈 학생별 쪽 (참고용, 틀리면 Claude가 바로잡아도 됨)
      studentsHint: r ? r.students.map((st) => ({ pages: st.pages, studentId: st.studentId || '', name: st.name || '' })) : null,
    });
    entries.push({ name: path, file: f.file });
  }
  return { manifest, entries, count: files.length };
}

async function guideText() {
  try { const r = await fetch('./GRADING.md', { cache: 'no-cache' }); if (r.ok) return await r.text(); } catch { /* 오프라인 */ }
  return '# 채점 지침\n저장소의 GRADING.md 를 참고하세요.';
}

async function startClaudeGrading() {
  if (cc.busy) return;
  const requestId = bridge.newRequestId();
  const { manifest, entries, count } = await buildRequest(requestId);
  if (!count) { toast(state.files.size ? '채점 기준을 저장한 영역의 PDF가 없어요.' : '먼저 PDF를 올려 주세요.'); return; }
  cc.busy = true; renderClaude();
  try {
    const guide = await guideText();
    const json = JSON.stringify(manifest, null, 2);
    cc.requests.set(requestId, new Map(manifest.files.map((x) => [x.fileId, x])));
    if (cc.dir && cc.perm === 'granted') {
      const base = `${bridge.REQUESTS_DIR}/${requestId}`;
      for (const e of entries) await bridge.writeFile(cc.dir, `${base}/${e.name}`, e.file);
      await bridge.writeFile(cc.dir, `${base}/GRADING.md`, guide);
      await bridge.writeFile(cc.dir, `${base}/request.json`, json); // 마지막에 써야 도우미가 반쯤 쓴 요청을 집지 않음
      cc.pending.push({ id: requestId, at: Date.now(), files: count });
      saveBridge();
      toast(`채점 요청을 보냈어요. (PDF ${count}개)`);
      pollFolder();
    } else {
      const zipEntries = [{ name: 'request.json', data: json }, { name: 'GRADING.md', data: guide }];
      for (const e of entries) zipEntries.push({ name: e.name, data: new Uint8Array(await e.file.arrayBuffer()) });
      const blob = bridge.makeZip(zipEntries);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `채점요청_${requestId}.zip`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      cc.pending.push({ id: requestId, at: Date.now(), files: count, zip: true });
      saveBridge();
      toast('채점 요청 파일(zip)을 내려받았어요. Claude에게 전달한 뒤 결과 파일을 불러와 주세요.');
    }
  } catch (e) {
    console.error(e);
    toast(`요청을 만들지 못했어요: ${e.message || e}`);
  } finally { cc.busy = false; renderClaude(); }
}

// 결과 파일 → 결과표
const norm = (x) => String(x || '').replace(/\s+/g, '').toLowerCase();
function importResult(obj, sourceName = '') {
  const res = bridge.normalizeResult(obj);
  const reqMap = cc.requests.get(res.requestId);
  let filesDone = 0, students = 0, unknownSec = 0;
  for (const rf of res.files) {
    // 영역 찾기: 이번 요청의 영역 id → 영역 이름 → 지금 보고 있는 영역
    let sec = (rf.sectionId && secById(rf.sectionId)) || state.sections.find((s) => norm(secName(s)) === norm(rf.section));
    const fromReq = reqMap?.get(rf.fileId);
    if (!sec && fromReq) sec = secById(fromReq.sectionId);
    if (!sec) { sec = activeSection(); unknownSec++; }
    // 파일 찾기: 같은 요청의 fileId → 같은 영역의 같은 파일 이름 → 새로 만들기(결과만 있는 학급)
    let f = fromReq && state.files.get(rf.fileId);
    if (!f) f = [...state.files.values()].find((x) => x.sec === sec.id && norm(x.name) === norm(rf.name));
    if (!f) {
      const id = `f${++seq}`;
      f = { id, sec: sec.id, file: null, name: rf.name || `학급 ${id}`, size: 0, status: 'pending', result: null, error: '', sig: null, layout: null };
      state.files.set(id, f);
    }
    if (f.abort) { f.abort.abort(); f.abort = null; }
    const qi = queue.indexOf(f.id); if (qi >= 0) queue.splice(qi, 1);
    const crit = sec.criteria;
    const rb = rubricOf(sec);
    const sts = rf.students.map((s, i) => {
      const pick = (c, k) => s.scores.find((x) => x.name === c.name) || s.scores.find((x) => norm(x.name) === norm(c.name)) || (s.scores.length === crit.length ? s.scores[k] : null);
      const scores = crit.map((c, k) => { const x = pick(c, k); return { name: c.name, points: c.points, score: x?.score ?? null, comment: x?.comment || '', deductions: x?.deductions || [], answer: x?.answer || '' }; });
      const pages = s.pages;
      const base = { idx: i + 1, blank: s.status === 'blank', pages, pageLabel: pages.length ? (pages.length === 1 ? `${pages[0]}쪽` : `${pages[0]}~${pages[pages.length - 1]}쪽`) : '', studentId: s.studentId, name: s.name, mode: 'claude', textPreview: s.comment, comment: s.comment, answer: s.answer };
      if (s.status === 'unreadable') return { ...base, status: 'fail', reason: s.comment || '글씨를 판독할 수 없어요 (Claude)', scores, total: null };
      let total;
      if (s.status === 'blank') total = rb.blank ?? rb.floor ?? s.total ?? 0; // 백지: 기준의 백지 점수 → 최저점 → Claude가 적은 총점
      else total = scores.every((x) => x.score != null) ? computeTotal(rb, scores.map((x) => x.score)) : s.total;
      return { ...base, status: total == null ? 'fail' : 'success', reason: total == null ? '점수가 비어 있어요' : '', scores, total };
    });
    const ok = sts.filter((x) => x.status === 'success').length;
    const per = rf.layout === 'duplex' ? 2 : rf.layout === 'simplex' ? 1 : (sts[0]?.pages.length || f.result?.per || null);
    f.result = { pages: rf.pages || f.result?.pages || null, layout: rf.layout || (per > 2 ? 'set' : f.result?.layout) || null, per, layoutAuto: false, layoutReason: 'Claude가 판단', students: sts, source: 'claude', gradedAt: res.gradedAt, requestId: res.requestId };
    f.status = ok ? 'success' : 'fail';
    f.error = ok ? '' : (sts[0]?.reason || '채점 결과가 없어요');
    f.sig = fileSig(f);
    f.edits = null;
    filesDone++; students += sts.length;
  }
  sortFiles();
  invalidate('files', 'results', 'badges', 'sectabs');
  cc.pending = cc.pending.filter((p) => p.id !== res.requestId);
  saveBridge();
  toast(`Claude 채점 결과를 불러왔어요. (학급 ${filesDone}개 · 학생 ${students}명)${unknownSec ? ` · 영역을 못 찾은 ${unknownSec}개는 ‘${secName(activeSection())}’에 넣었어요` : ''}`);
  return res;
}
async function importResultFiles(list) {
  for (const file of list) {
    try { importResult(JSON.parse((await file.text()).replace(/^﻿/, '')), file.name); }
    catch (e) { toast(`${file.name}: ${e.message || '결과 파일을 읽지 못했어요.'}`); }
  }
  renderClaude();
}

// 연결한 폴더에 채점 도우미(더블클릭 한 번으로 켜는 파일)를 넣어 둔다
async function installHelper() {
  try {
    const get = async (u) => { const r = await fetch(u, { cache: 'no-cache' }); if (!r.ok) throw new Error(u); return new Uint8Array(await r.arrayBuffer()); };
    await bridge.writeFile(cc.dir, 'helper/grading-helper.ps1', await get('./helper/grading-helper.ps1'));
    await bridge.writeFile(cc.dir, 'helper/install-autostart.ps1', await get('./helper/install-autostart.ps1'));
    await bridge.writeFile(cc.dir, '채점 도우미 켜기.bat', await get('./helper/start-helper.bat'));
    await bridge.writeFile(cc.dir, '채점 도우미 끄기.bat', await get('./helper/stop-helper.bat'));
  } catch (e) { console.warn('도우미 파일을 넣지 못함', e); }
}
// 채점 폴더 연결 (Chrome/Edge)
async function connectFolder() {
  if (!bridge.folderSupported()) { toast('이 브라우저는 폴더 연결을 지원하지 않아요. 크롬이나 엣지에서 열어 주세요.'); return; }
  try {
    if (cc.dir && cc.perm !== 'granted') {
      cc.perm = await bridge.dirPermission(cc.dir, true);
      if (cc.perm === 'granted') { await installHelper(); renderClaude(); pollFolder(); return; }
    }
    const h = await window.showDirectoryPicker({ id: 'dpg-grading', mode: 'readwrite' });
    cc.dir = h; cc.perm = await bridge.dirPermission(h, true);
    await bridge.saveDirHandle(h);
    if (cc.perm === 'granted') await installHelper();
    toast(`‘${h.name}’ 폴더에 연결했어요.`);
  } catch (e) { if (e?.name !== 'AbortError') toast('폴더를 연결하지 못했어요.'); }
  renderClaude(); pollFolder();
}
async function pollFolder() {
  clearTimeout(cc.timer);
  if (!cc.dir || cc.perm !== 'granted') return;
  try {
    // 도우미가 살아 있는지 (도우미가 몇 초마다 helper.json 을 고침)
    try {
      const d = await cc.dir.getDirectoryHandle(bridge.REQUESTS_DIR);
      const hf = await (await d.getFileHandle('helper.json')).getFile();
      cc.helperAt = hf.lastModified;
      try { cc.helperErr = JSON.parse((await hf.text()).replace(/^\uFEFF/, '')).error || ''; } catch { cc.helperErr = ''; }
    } catch { cc.helperAt = 0; cc.helperErr = ''; }
    for (const p of cc.pending) {
      try {
        const d = await (await cc.dir.getDirectoryHandle(bridge.REQUESTS_DIR)).getDirectoryHandle(p.id);
        try { cc.progress[p.id] = JSON.parse(await (await (await d.getFileHandle('status.json')).getFile()).text()); } catch { /* 아직 없음 */ }
      } catch { /* 폴더 없음 */ }
    }
    for (const r of await bridge.findResults(cc.dir)) {
      const key = `${r.requestId}/${r.name}`;
      if (cc.imported[key] >= r.file.lastModified) continue;
      if (!cc.pending.some((p) => p.id === r.requestId) && cc.imported[key] == null && Object.keys(cc.imported).length && Date.now() - r.file.lastModified > 7 * 864e5) continue; // 오래된 남의 결과는 건너뜀
      cc.imported[key] = r.file.lastModified;
      saveBridge();
      try { importResult(JSON.parse((await r.file.text()).replace(/^﻿/, '')), r.name); }
      catch (e) { toast(`결과 파일 오류(${r.requestId}): ${e.message}`); }
    }
  } catch (e) { console.warn(e); }
  renderClaude();
  if (!document.hidden) cc.timer = setTimeout(pollFolder, cc.pending.length ? 3000 : 10000);
}

const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? '방금' : m < 60 ? `${m}분 전` : `${Math.round(m / 60)}시간 전`; };
function renderClaude() {
  const box = $('#claude-card');
  if (!box) return;
  const sup = bridge.folderSupported();
  const connected = cc.dir && cc.perm === 'granted';
  $('#cc-folder').innerHTML = connected
    ? `<span class="ok">● 채점 폴더: <b>${esc(cc.dir.name)}</b></span>`
    : cc.dir ? `<span class="warn">● ‘${esc(cc.dir.name)}’ 폴더 다시 허용이 필요해요</span>`
      : sup ? '<span class="muted">채점 폴더가 연결되지 않았어요 (연결하면 요청·결과가 자동으로 오가요)</span>'
        : '<span class="muted">이 브라우저는 폴더 연결이 안 돼요. 요청 파일(zip)을 내려받는 방식으로 진행해요.</span>';
  const cb = $('#cc-connect');
  cb.hidden = !sup;
  cb.textContent = connected ? '폴더 바꾸기' : cc.dir ? '폴더 다시 허용' : '채점 폴더 연결';
  const n = [...state.files.values()].filter((f) => f.file && secById(f.sec)?.criteria.length).length;
  const sb = $('#cc-send');
  sb.disabled = cc.busy || !n;
  sb.textContent = cc.busy ? '요청 만드는 중…' : connected ? `Claude 채점 시작 (PDF ${n}개)` : `채점 요청 파일 받기 (PDF ${n}개)`;
  const helperOn = connected && cc.helperAt && Date.now() - cc.helperAt < 30000;
  const lines = [];
  if (connected) {
    if (helperOn && cc.helperErr) lines.push(`<span class="bad">● 채점 도우미: ${esc(cc.helperErr)}</span>`);
    else lines.push(helperOn ? '<span class="ok">● 채점 도우미 켜짐(백그라운드) — ‘Claude 채점 시작’만 누르면 자동으로 채점해요</span>' : `<span class="muted">○ 채점 도우미가 아직 켜지지 않았어요. 연결한 폴더의 <b>‘채점 도우미 켜기.bat’을 처음 한 번만</b> 더블클릭해 주세요. 그 뒤로는 PC를 켤 때마다 창 없이 백그라운드에서 자동으로 켜져요.</span>`);
  }
  for (const p of cc.pending.slice(-3).reverse()) {
    const pr = cc.progress[p.id];
    const st = pr?.state === 'grading' ? `채점 중${pr.done != null && pr.total ? ` (${pr.done}/${pr.total})` : ''}${pr.message ? ` · ${esc(pr.message)}` : ''}` : pr?.state === 'error' ? `<span class="bad">오류: ${esc(pr.message || '')}</span>` : p.zip ? 'zip으로 받음 · 결과 파일을 기다리는 중' : '결과 기다리는 중';
    lines.push(`<span>요청 ${esc(p.id)} · PDF ${p.files}개 · ${ago(p.at)} · ${st}</span>`);
  }
  $('#cc-status').innerHTML = lines.join('<br>');
}

function initClaude() {
  $('#cc-connect').addEventListener('click', connectFolder);
  $('#cc-send').addEventListener('click', startClaudeGrading);
  const rf = $('#result-file');
  const pickResults = () => rf.click();
  $('#cc-import').addEventListener('click', pickResults);
  $('#import-result').addEventListener('click', pickResults);
  rf.addEventListener('change', () => { const l = [...rf.files]; rf.value = ''; if (l.length) importResultFiles(l); });
  $('#cc-pending-clear')?.addEventListener('click', () => { cc.pending = []; saveBridge(); renderClaude(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollFolder(); });
  bridge.loadDirHandle().then(async (h) => {
    if (!h) return renderClaude();
    cc.dir = h; cc.perm = await bridge.dirPermission(h, false);
    if (cc.perm === 'granted') installHelper(); // 도우미 파일을 늘 최신으로 (켜져 있는 도우미는 다음 PC 시작 때 새 버전)
    renderClaude(); pollFolder();
  });
  renderClaude();
}

// ── 올린 PDF·채점 결과 자동 저장 (이 컴퓨터 브라우저의 IndexedDB, 인터넷으로 나가지 않음) ──────
// meta: 파일 정보·결과·직접 고친 값 (바뀔 때만 다시 씀) / blob: PDF 원본 (올릴 때 한 번만 씀)
const DATA_DB = 'dpg-data';
let dataDb = null;
function openDataDb() {
  if (dataDb) return dataDb;
  dataDb = new Promise((resolve, reject) => {
    const r = indexedDB.open(DATA_DB, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('meta', { keyPath: 'id' }); r.result.createObjectStore('blob'); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }).catch((e) => { console.warn('자동 저장을 쓸 수 없어요', e); dataDb = null; return null; });
  return dataDb;
}
const savedMeta = new Map(); // id -> 마지막으로 저장한 JSON
const savedBlob = new Set(); // PDF를 이미 저장한 id
let saveTimer = 0, restoring = false;
const metaOf = (f) => ({ id: f.id, sec: f.sec, name: f.name, size: f.size, status: f.status === 'grading' ? 'pending' : f.status, result: f.result, error: f.error, sig: f.sig, layout: f.layout, edits: f.edits || null, hasFile: !!f.file });
function scheduleSave() { if (restoring) return; clearTimeout(saveTimer); saveTimer = setTimeout(saveFiles, 600); }
async function saveFiles() {
  saveTimer = 0;
  const db = await openDataDb();
  if (!db) return;
  const puts = [], blobs = [], dels = [];
  for (const f of state.files.values()) {
    const m = metaOf(f);
    const j = JSON.stringify(m);
    if (savedMeta.get(f.id) !== j) puts.push([f.id, m, j]);
    if (f.file && !savedBlob.has(f.id)) blobs.push(f);
  }
  for (const id of savedMeta.keys()) if (!state.files.has(id)) dels.push(id);
  if (!puts.length && !blobs.length && !dels.length) return;
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['meta', 'blob'], 'readwrite');
      for (const [, m] of puts) tx.objectStore('meta').put(m);
      for (const f of blobs) tx.objectStore('blob').put(f.file, f.id);
      for (const id of dels) { tx.objectStore('meta').delete(id); tx.objectStore('blob').delete(id); }
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
    for (const [id, , j] of puts) savedMeta.set(id, j);
    for (const f of blobs) savedBlob.add(f.id);
    for (const id of dels) { savedMeta.delete(id); savedBlob.delete(id); }
  } catch (e) {
    console.warn(e);
    toast(e?.name === 'QuotaExceededError' ? '저장 공간이 부족해 일부 PDF가 자동 저장되지 않았어요. 쓰지 않는 파일을 지워 주세요.' : '자동 저장 중 문제가 생겼어요.');
  }
}
async function restoreFiles() {
  const db = await openDataDb();
  if (!db) return 0;
  const [metas, blobs] = await new Promise((resolve, reject) => {
    const tx = db.transaction(['meta', 'blob'], 'readonly');
    const m = tx.objectStore('meta').getAll();
    const bk = tx.objectStore('blob').getAllKeys();
    tx.oncomplete = () => resolve([m.result || [], new Set(bk.result || [])]);
    tx.onerror = () => reject(tx.error);
  }).catch(() => [[], new Set()]);
  if (!metas.length) return 0;
  restoring = true;
  for (const m of metas) {
    if (state.files.has(m.id)) continue;
    const f = { ...m, sec: secById(m.sec) ? m.sec : state.sections[0].id, file: null, abort: null };
    delete f.hasFile;
    if (m.hasFile && blobs.has(m.id)) {
      f.file = await new Promise((resolve) => { const r = db.transaction('blob').objectStore('blob').get(m.id); r.onsuccess = () => resolve(r.result || null); r.onerror = () => resolve(null); });
      if (f.file && !(f.file instanceof File)) f.file = new File([f.file], m.name, { type: 'application/pdf' });
      if (f.file) savedBlob.add(m.id);
    }
    state.files.set(f.id, f);
    savedMeta.set(f.id, JSON.stringify(metaOf(f)));
    const n = Number(String(f.id).replace(/\D/g, '')); if (n > seq) seq = n;
    if (f.file && (f.status === 'pending' || !f.result)) { f.status = 'pending'; f.result = null; queue.push(f.id); }
  }
  restoring = false;
  sortFiles();
  invalidate('files', 'results', 'badges', 'sectabs');
  pump();
  return metas.length;
}

// ── 시작 ────────────────────────────────────────────────────────────────
persist(); // 예전 설정을 새 형식으로 옮겨 저장
initSettings();
initSettingsIO();
initEvents();
initClaude();
initViewer();
if (!location.hash && state.sections.some((s) => s.criteria.length)) history.replaceState(null, '', '#files');
route();
renderBadges();
restoreFiles().then((n) => { if (n) toast(`지난번에 올린 파일 ${n}개와 채점 결과를 불러왔어요.`); }).catch((e) => console.warn(e));
navigator.storage?.persist?.().catch(() => {}); // 브라우저가 저장한 PDF를 임의로 지우지 않도록 요청

// 첫 화면을 그린 뒤 브라우저가 한가할 때 PDF 엔진을 미리 데워 둔다 → 업로드 순간 렉 방지
const idle = (fn, t) => ('requestIdleCallback' in window ? requestIdleCallback(fn, { timeout: t }) : setTimeout(fn, t));
idle(() => loadPdfjs().catch(() => {}), 2500);

// 오프라인/재방문 속도를 위한 서비스 워커 (첫 화면 그린 뒤 여유 있을 때 등록)
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  idle(() => navigator.serviceWorker.register('./sw.js').catch(() => {}), 4000);
}
