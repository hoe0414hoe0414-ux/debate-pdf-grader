import { parseCriteria, criteriaSignature, computeTotal, defaultRubric, EXAMPLE_CRITERIA } from './criteria.js?v=7';
import { gradeFile, loadPdfjs, GradeError, extractStudentId, extractName } from './grader.js?v=7';

const LAYOUTS = { auto: '자동', duplex: '양면', simplex: '단면' };
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
    sections: state.sections.map(({ id, name, criteriaText, criteria, savedAt, notes, layoutDefault }) => ({ id, name, criteriaText, criteria: criteria.map(({ name: n, points }) => ({ name: n, points })), savedAt, notes, layoutDefault })),
  });
}
const secSig = (s) => `${state.idDigits}\u0003${s.criteriaText}\u0003${criteriaSignature(s.criteria)}\u0003${JSON.stringify(s.rubric)}\u0003${s.notes}`;
// 파일마다 고른 양면/단면 (null이면 그 영역의 기본값을 따름)
const layoutChoice = (f) => f.layout || secById(f.sec)?.layoutDefault || 'auto';
const fileSig = (f) => `${secSig(secById(f.sec))}\u0003${layoutChoice(f)}`;
const isStale = (f) => !!f.sig && !!secById(f.sec) && f.sig !== fileSig(f);

// ── 렌더링 예약 (한 프레임에 한 번만 다시 그림) ──────────────────────────────
const dirty = new Set();
let rafId = 0;
function invalidate(...parts) {
  parts.forEach((p) => dirty.add(p));
  if (!rafId) rafId = requestAnimationFrame(flush);
}
function flush() {
  rafId = 0;
  const d = new Set(dirty); dirty.clear();
  if (d.has('badges')) renderBadges();
  // 숨겨진 화면은 그리지 않고, 화면을 열 때(route) 그린다
  if (d.has('files') && state.view === 'files') renderFiles();
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
  commitName();
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
function addFiles(list, secId = state.activeSec) {
  const incoming = [...list];
  let added = 0, dup = 0, skipped = 0, big = 0;
  const keys = new Set([...state.files.values()].filter((f) => f.sec === secId).map((f) => `${f.name}\u0000${f.size}`));
  for (const file of incoming) {
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    if (!isPdf) { skipped++; continue; }
    if (file.size > MAX_FILE_MB * 1024 * 1024) { big++; continue; }
    const k = `${file.name}\u0000${file.size}`;
    if (keys.has(k)) { dup++; continue; }
    keys.add(k);
    const id = `f${++seq}`;
    state.files.set(id, { id, sec: secId, file, name: file.name, size: file.size, status: 'pending', result: null, error: '', sig: null, layout: null });
    added++;
    queue.push(id);
  }
  if (added) sortFiles();
  const msg = [];
  if (added) msg.push(`‘${secName(secById(secId))}’에 ${added}개 추가`);
  if (dup) msg.push(`중복 ${dup}개 제외`);
  if (skipped) msg.push(`PDF가 아닌 파일 ${skipped}개 제외`);
  if (big) msg.push(`${MAX_FILE_MB}MB 초과 ${big}개 제외`);
  if (msg.length) toast(msg.join(' · '));
  invalidate('files', 'results', 'badges');
  if (added) { loadPdfjs().catch(() => {}); pump(); }
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
    const ok = res.students.filter((st) => st.status === 'success').length;
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
    if (f.status === 'grading') { f.abort?.abort(); f.abort = null; running = Math.max(0, running); }
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
      const bad = st.filter((x) => x.status !== 'success').length;
      return `채점 완료 · 학생 ${st.length}명${bad ? ` (채점 불가 ${bad}명)` : ''} · 결과 보기`;
    }
    case 'fail': return `채점 실패 · ${f.error || '판독 불가'}`;
    case 'grading': return '채점 중…';
    default: return canGradeFile(f) ? '대기 중' : '기준 저장 후 채점';
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
  const detected = f.result?.layoutAuto ? f.result.layout : null;
  const btn = (v) => {
    const label = v === 'auto' && detected ? `자동(${LAYOUTS[detected]})` : LAYOUTS[v];
    const tip = v === 'auto' ? (f.result?.layoutReason ? `자동 판단: ${f.result.layoutReason}` : '파일을 보고 양면/단면을 자동으로 판단') : v === 'duplex' ? '양면: 2쪽(앞+뒤)을 학생 1명으로 채점' : '단면: 1쪽을 학생 1명으로 채점';
    return `<button type="button" data-layout="${v}" aria-pressed="${cur === v}" title="${esc(tip)}">${esc(label)}</button>`;
  };
  return `<span class="seg" role="group" aria-label="양면/단면" data-seg="${f.id}">${btn('auto')}${btn('duplex')}${btn('simplex')}</span>`;
}
function rowKey(f) { return `${f.status}|${statusText(f)}|${layoutChoice(f)}|${f.result?.layout || ''}`; }

function renderFiles() {
  const sec = activeSection();
  const tabsHtml = secTabsHtml(sec.id, false) + '<a class="sec-tab add" href="#settings" title="설정에서 평가 영역 추가">+ 영역 추가</a>';
  const tabsEl = $('#files-sec-tabs');
  if (tabsEl.dataset.h !== tabsHtml) { tabsEl.innerHTML = tabsHtml; tabsEl.dataset.h = tabsHtml; }
  $('#dz-title').textContent = `‘${secName(sec)}’ PDF를 여기로 끌어다 놓으세요`;

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
    const pages = f.result?.pages ? `${f.result.pages}쪽` : fmtSize(f.size);
    return `<span class="dot"></span>
      <span class="name" title="${esc(f.name)}">${esc(f.name)}</span>
      ${layoutSeg(f)}
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
const studentLabel = (f, st) => st.name || (f.result.students.length > 1 ? `학생 ${st.idx}` : '');

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
const isBad = (f, st) => st.status !== 'success' && !hasEdit(editOf(f, st));
const critHead = (sec, c) => (rubricOf(sec).mode === 'deduct' ? `${esc(c.name)} (감점)` : `${esc(c.name)} (${fmt(c.points)})`);
const totalHead = (sec) => { const r = rubricOf(sec); return `총점 (${fmt(r.max)}${r.mode === 'deduct' ? '점 만점' : ''}${r.floor != null ? `, 최저 ${fmt(r.floor)}` : ''})`; };
const fmtScore = (sec, v) => (v == null ? '' : rubricOf(sec).mode === 'deduct' && v < 0 ? `−${fmt(-v)}` : fmt(v));
// 학번 순 정렬 (학번이 없으면 맨 뒤, 같으면 학급·순서대로)
function byStudentId(a, b) {
  const ia = idOf(a.f, a.st), ib = idOf(b.f, b.st);
  if (!ia !== !ib) return ia ? -1 : 1;
  return collator.compare(ia, ib) || collator.compare(a.f.name, b.f.name) || a.st.idx - b.st.idx;
}
const studentsOf = (ids) => ids.flatMap((id) => { const f = state.files.get(id); return f.result ? f.result.students.map((st) => ({ f, st })) : []; }).sort(byStudentId);
const fileTitle = (f) => f.name.replace(/\.pdf$/i, '');

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
  const bad = isBad(f, st);
  const cells = crit.map((c, i) => {
    const v = valOf(f, st, c);
    const orig = st.status === 'success' ? fmtScore(sec, scoreOf(st, c)) : BAD;
    if (v == null) return edCell(f, st, `s:${c.name}`, bad || st.status !== 'success' ? BAD : '–', `num ${bad || st.status !== 'success' ? 'bad' : 'pending'}`, orig);
    return edCell(f, st, `s:${c.name}`, fmtScore(sec, v), 'num', orig);
  }).join('');
  const t = totalEff(f, st, sec);
  const origT = st.status === 'success' ? fmt(st.total) : BAD;
  const tag = st.mode === 'scan-demo' && !hasEdit(editOf(f, st)) ? '<span class="demo-tag">데모</span>' : '';
  return cells + (t == null ? edCell(f, st, 'total', BAD, 'num total bad', origT) : edCell(f, st, 'total', `${fmt(t)}${tag}`, 'num total', origT));
}
const idCells = (f, st) => edCell(f, st, 'id', esc(idOf(f, st) || '–'), '', st.studentId || '없음') + edCell(f, st, 'name', esc(nameOf(f, st) || '–'), '', st.name || '없음');

const FOOT = `<p class="muted" style="margin:0">※ 빨간색 ${BAD}는 AI가 학생이 쓴 글을 해석하지 못한 경우예요. 원본 PDF를 직접 확인해 주세요. ‘데모’ 표시는 스캔본에 임시 점수를 보여 준 것입니다. 점수·학번·이름 칸을 누르면 직접 고칠 수 있어요(고친 칸은 노란색). 학급 이름을 누르면 그 학급의 점수표가 열려요.</p>`;

// 한 영역의 모든 학생을 한 표로 (영역마다 채점 항목이 달라서 표를 영역별로 나눈다)
function renderSectionTable(sec) {
  const ids = filesOf(sec.id);
  const crit = sec.criteria;
  const c = counts(sec.id);
  const title = `<div class="sec-title"><h2>${esc(secName(sec))}</h2><span class="muted">${ids.length ? `학급 ${ids.length}개 · 학생 ${c.students}명` : '올린 파일 없음'}</span></div>`;
  if (!ids.length) return `${title}<div class="empty">이 영역에 올린 파일이 없어요. <a href="#files" data-go-sec="${sec.id}">업로드 파일</a>에서 올려 주세요.</div>`;
  if (!crit.length) return `${title}<div class="empty">‘${esc(secName(sec))}’의 채점 기준이 아직 저장되지 않았어요. <a href="#settings" data-go-sec="${sec.id}">설정</a>에서 저장하면 바로 채점돼요.</div>`;
  const head = `<tr><th>학번</th><th>이름</th><th>학급</th><th>쪽</th>${crit.map((x) => `<th class="num">${critHead(sec, x)}</th>`).join('')}<th class="num">${totalHead(sec)}</th></tr>`;
  const rows = studentsOf(ids).map(({ f, st }) => `<tr>${idCells(f, st)}<td><button type="button" class="linkish" data-open-file="${f.id}">${esc(fileTitle(f))}</button></td><td>${esc(st.pageLabel || '–')}</td>${scoreCells(f, st, sec)}</tr>`);
  for (const id of ids) {
    const f = state.files.get(id);
    if (f.result) continue;
    const label = f.status === 'grading' ? '채점 중…' : '대기 중';
    rows.push(`<tr><td>–</td><td>–</td><td><button type="button" class="linkish" data-open-file="${id}">${esc(fileTitle(f))}</button></td><td>–</td>${crit.map(() => `<td class="num pending">${label}</td>`).join('')}<td class="num pending">${label}</td></tr>`);
  }
  return `${title}<div class="table-wrap"><table><thead>${head}</thead><tbody>${rows.join('')}</tbody></table></div>`;
}

function renderAllSections() {
  const used = state.sections.filter((s) => filesOf(s.id).length);
  if (!used.length) return '<div class="empty">아직 채점한 파일이 없어요.</div>';
  return `<div class="stack">${used.map((s) => `<section class="stack sec-block">${renderSectionTable(s)}</section>`).join('')}${FOOT}</div>`;
}

function renderDetail(f) {
  const sec = secById(f.sec);
  const r = f.result;
  const crit = sec.criteria;
  const stat = (k, v, cls = '') => `<div class="stat"><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`;
  const title = `<div class="sec-title"><h2>${esc(secName(sec))} · ${esc(fileTitle(f))}</h2></div>`;
  if (f.status !== 'success' && f.status !== 'fail') {
    return `<div class="stack">${title}<div class="empty">${f.status === 'grading' ? '채점 중이에요…' : canGradeFile(f) ? '아직 채점하지 않았어요.' : '이 영역의 채점 기준을 저장하면 채점돼요.'}</div></div>`;
  }
  const reason = f.status === 'fail' ? `<div class="notice warn">채점 실패: ${esc(f.error || '판독 불가')}</div>` : '';
  const layoutTxt = r.layout ? `${LAYOUTS[r.layout]}${r.layoutAuto ? ' (자동 판단)' : ' (직접 지정)'}` : '–';
  const sts = r.students;

  // 학급(파일 1개)의 학생별 점수표
  const ok = sts.filter((x) => !isBad(f, x)).length;
  const top = `<div class="detail-grid">
    ${stat('학생 수', `${sts.length}명`)}
    ${stat('채점 완료', `${ok}명`, 'good')}
    ${stat('채점 불가', `${sts.length - ok}명`, sts.length - ok ? 'bad' : '')}
    ${stat('나눈 방식', `<span style="font-size:15px">${r.pages ? `${layoutTxt} · ${r.pages}쪽` : '–'}</span>`)}
  </div>`;
  const head = `<tr><th>학번</th><th>이름</th><th>쪽</th>${crit.map((c) => `<th class="num">${critHead(sec, c)}</th>`).join('')}<th class="num">${totalHead(sec)}</th><th>채점 근거</th></tr>`;
  const why = (st) => (st.scores || []).filter((x) => x.comment && x.score != null && !(rubricOf(sec).mode === 'deduct' && x.score === 0)).map((x) => `${x.name}: ${x.comment}`).join(' · ');
  const rows = studentsOf([f.id]).map(({ st }) => `<tr>${idCells(f, st)}<td>${esc(st.pageLabel || '–')}</td>${scoreCells(f, st, sec)}<td class="wrap why">${esc(st.status === 'success' ? why(st) : st.reason || '')}</td></tr>`).join('');
  const hint = r.layoutAuto ? `<p class="muted" style="margin:0">학생 나누기가 틀렸다면 <a href="#files" data-go-sec="${sec.id}">업로드 파일</a>에서 이 파일의 ‘양면/단면’ 버튼을 눌러 바꿔 주세요. 판단 근거: ${esc(r.layoutReason)}</p>` : '';
  return `<div class="stack">${title}${reason}${top}<div class="table-wrap"><table><thead>${head}</thead><tbody>${rows}</tbody></table></div>${hint}</div>`;
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
function startEdit(td) {
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
    lines.push(['영역', '학번', '이름', '학급', '쪽', ...crit.map((c) => (rb.mode === 'deduct' ? `${c.name}(감점)` : `${c.name}(${c.points})`)), `총점(${rb.max})`, '상태']);
    for (const { f, st } of studentsOf(ids)) {
      const bad = isBad(f, st);
      const t = totalEff(f, st, sec);
      const id = idOf(f, st);
      lines.push([
        secName(sec), id ? `="${id}"` : '', nameOf(f, st), fileTitle(f), st.pageLabel,
        ...crit.map((c) => { const v = valOf(f, st, c); return v == null ? (bad ? BAD : '') : fmt(v); }),
        t == null ? BAD : fmt(t),
        hasEdit(editOf(f, st)) ? '직접 수정' : bad ? `실패: ${st.reason || f.error}` : st.mode === 'scan-demo' ? '성공(데모 점수)' : '성공',
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
  window.addEventListener('resize', () => { if (menuFor) placeMenu(); });

  window.addEventListener('beforeunload', (e) => {
    if (state.files.size) { e.preventDefault(); e.returnValue = ''; }
  });
}

// ── 설정 파일 내보내기 / 불러오기 ─────────────────────────────────────────────
// ※ 설정 항목을 추가·변경하면 SETTINGS_FILE_VERSION을 올리고 toSettingsFile()/fromSettingsFile()을 함께 고칠 것.
//   예전 버전 파일도 계속 불러올 수 있어야 함(없는 항목은 기본값).
export const SETTINGS_FILE_FORMAT = 'debate-pdf-grader-settings';
export const SETTINGS_FILE_VERSION = 1;
function toSettingsFile() {
  flushPendingInputs();
  return {
    format: SETTINGS_FILE_FORMAT,
    version: SETTINGS_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    idDigits: state.idDigits,
    sections: state.sections.map((s) => {
      const draft = store.get(draftKey(s.id));
      const out = { name: s.name, criteriaText: s.criteriaText, layoutDefault: s.layoutDefault, notes: s.notes };
      if (typeof draft === 'string' && draft !== s.criteriaText) out.criteriaDraft = draft; // 저장 안 한 작성 중 내용
      return out;
    }),
  };
}
// 어떤 버전의 파일이든 현재 형식 {idDigits, sections:[{name, criteriaText, criteriaDraft, layoutDefault, notes}]}로 바꾼다
function fromSettingsFile(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('설정 파일 형식이 아니에요.');
  const str = (v) => (typeof v === 'string' ? v : '');
  const sec = (x, i) => ({
    name: (str(x?.name).trim() || `평가 ${i + 1}`).slice(0, 30),
    criteriaText: str(x?.criteriaText),
    criteriaDraft: typeof x?.criteriaDraft === 'string' ? x.criteriaDraft : null,
    layoutDefault: ['auto', 'duplex', 'simplex'].includes(x?.layoutDefault) ? x.layoutDefault : 'auto',
    notes: str(x?.notes),
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
    return { id, name: x.name, criteriaText: x.criteriaText, criteria: c.criteria, rubric: c.rubric, savedAt: c.criteria.length ? Date.now() : null, notes: x.notes, layoutDefault: x.layoutDefault, draft: x.criteriaDraft };
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

// ── 시작 ────────────────────────────────────────────────────────────────
persist(); // 예전 설정을 새 형식으로 옮겨 저장
initSettings();
initSettingsIO();
initEvents();
if (!location.hash && state.sections.some((s) => s.criteria.length)) history.replaceState(null, '', '#files');
route();
renderBadges();

// 첫 화면을 그린 뒤 브라우저가 한가할 때 PDF 엔진을 미리 데워 둔다 → 업로드 순간 렉 방지
const idle = (fn, t) => ('requestIdleCallback' in window ? requestIdleCallback(fn, { timeout: t }) : setTimeout(fn, t));
idle(() => loadPdfjs().catch(() => {}), 2500);

// 오프라인/재방문 속도를 위한 서비스 워커 (첫 화면 그린 뒤 여유 있을 때 등록)
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  idle(() => navigator.serviceWorker.register('./sw.js').catch(() => {}), 4000);
}
