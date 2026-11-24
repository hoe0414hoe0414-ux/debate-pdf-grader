import { parseCriteria, criteriaSignature, EXAMPLE_CRITERIA } from './criteria.js?v=4';
import { gradeFile, loadPdfjs, GradeError, extractStudentId, extractName } from './grader.js?v=4';

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
    criteria: Array.isArray(from.criteria) ? from.criteria.filter((c) => c && typeof c.name === 'string' && Number(c.points) > 0).map((c) => ({ name: c.name, points: Number(c.points), desc: String(c.desc || '') })) : [],
    savedAt: from.savedAt || null,
    notes: typeof from.notes === 'string' ? from.notes : '',
    layoutDefault: ['auto', 'duplex', 'simplex'].includes(from.layoutDefault) ? from.layoutDefault : 'auto',
  };
}

function loadSettings() {
  const v2 = store.get(KEY);
  if (v2 && Array.isArray(v2.sections) && v2.sections.length) {
    const seen = new Set();
    const sections = v2.sections.slice(0, MAX_SECTIONS).map((s, i) => makeSection((s && s.name) || `평가 ${i + 1}`, s || {}))
      .map((s) => { if (seen.has(s.id)) s.id = newSecId(); seen.add(s.id); return s; });
    return { idDigits: v2.idDigits === 4 ? 4 : 5, sections, activeSec: v2.activeSec };
  }
  // 예전 버전(영역 하나) 설정을 첫 번째 영역으로 옮긴다
  const v1 = store.get(OLD_KEY) || {};
  const sec = makeSection('평가 1', { ...v1, id: undefined });
  if (!sec.criteria.length && sec.criteriaText) sec.criteria = parseCriteria(sec.criteriaText).items.map(({ name, points, desc }) => ({ name, points, desc }));
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
    sections: state.sections.map(({ id, name, criteriaText, criteria, savedAt, notes, layoutDefault }) => ({ id, name, criteriaText, criteria, savedAt, notes, layoutDefault })),
  });
}
const secSig = (s) => `${state.idDigits}\u0003${s.criteriaText}\u0003${criteriaSignature(s.criteria)}\u0003${s.notes}`;
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
    const chips = r.items.map((it) => `<span class="chip">${esc(it.name)} <b>${fmtNum(it.points)}점</b></span>`).join('');
    lines.push(`<div class="ok">✓ 결과표에 쓸 채점 항목 ${r.items.length}개 · 총 ${fmtNum(r.total)}점${r.assumed ? ' (자동 지정)' : ''}</div><div class="chips">${chips}</div>`);
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
  sec.criteria = r.items.map(({ name, points, desc }) => ({ name, points, desc }));
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
  const opts = { criteria: sec.criteria, prompt: sec.criteriaText, idDigits: state.idDigits, notes: sec.notes, layout: layoutChoice(f) };
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
const totalOf = (crit) => crit.reduce((s, c) => s + c.points, 0);
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
      const cur = on && sel.kind === 'file' ? ` · ${esc(fileTitle(state.files.get(sel.file)))}` : on ? ' · 전체' : '';
      const dot = c.x ? 'fail' : c.s ? 'success' : '';
      return `<button type="button" class="tab sec-rtab" role="tab" data-rtab="${s.id}" aria-selected="${on}" aria-haspopup="menu"${menuFor === s.id ? ' aria-expanded="true"' : ''} title="${esc(secName(s))}: 눌러서 학급(파일) 고르기"><span class="tdot ${dot}"></span>${esc(secName(s))}${cur}${c.students ? ` <small>${c.students}명</small>` : ''} <span class="caret" aria-hidden="true">▾</span></button>`;
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

function scoreCells(st, crit) {
  if (st.status !== 'success') return crit.map(() => `<td class="num bad">${BAD}</td>`).join('') + `<td class="num total bad">${BAD}</td>`;
  return crit.map((c) => { const v = scoreOf(st, c); return v == null ? '<td class="num pending">–</td>' : `<td class="num">${fmt(v)}</td>`; }).join('')
    + `<td class="num total">${fmt(st.total)}${st.mode === 'scan-demo' ? '<span class="demo-tag">데모</span>' : ''}</td>`;
}

const FOOT = `<p class="muted" style="margin:0">※ 빨간색 ${BAD}는 AI가 학생이 쓴 글을 해석하지 못한 경우예요. 원본 PDF를 직접 확인해 주세요. ‘데모’ 표시는 스캔본에 임시 점수를 보여 준 것입니다. 줄을 누르면 그 학급(파일)의 상세 결과가 열려요.</p>`;

// 한 영역의 모든 학생을 한 표로 (영역마다 채점 항목이 달라서 표를 영역별로 나눈다)
function renderSectionTable(sec) {
  const ids = filesOf(sec.id);
  const crit = sec.criteria;
  const c = counts(sec.id);
  const title = `<div class="sec-title"><h2>${esc(secName(sec))}</h2><span class="muted">${ids.length ? `학급(파일) ${ids.length}개 · 학생 ${c.students}명` : '올린 파일 없음'}</span></div>`;
  if (!ids.length) return `${title}<div class="empty">이 영역에 올린 파일이 없어요. <a href="#files" data-go-sec="${sec.id}">업로드 파일</a>에서 올려 주세요.</div>`;
  if (!crit.length) return `${title}<div class="empty">‘${esc(secName(sec))}’의 채점 기준이 아직 저장되지 않았어요. <a href="#settings" data-go-sec="${sec.id}">설정</a>에서 저장하면 바로 채점돼요.</div>`;
  const head = `<tr><th>학번</th><th>이름</th><th>학급(파일)</th><th>쪽</th>${crit.map((x) => `<th class="num">${esc(x.name)} (${fmt(x.points)})</th>`).join('')}<th class="num">총점 (${fmt(totalOf(crit))})</th></tr>`;
  const rows = [];
  for (const id of ids) {
    const f = state.files.get(id);
    if (!f.result) {
      const label = f.status === 'grading' ? '채점 중…' : '대기 중';
      rows.push(`<tr class="clickable" data-open-file="${id}"><td>–</td><td>–</td><td>${esc(f.name)}</td><td>–</td>${crit.map(() => `<td class="num pending">${label}</td>`).join('')}<td class="num pending">${label}</td></tr>`);
      continue;
    }
    for (const st of f.result.students) {
      rows.push(`<tr class="clickable" data-open-file="${id}"><td>${esc(st.studentId || '–')}</td><td>${esc(studentLabel(f, st) || '–')}</td><td>${esc(f.name)}</td><td>${esc(st.pageLabel || '–')}</td>${scoreCells(st, crit)}</tr>`);
    }
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

  if (sts.length === 1) {
    const st = sts[0];
    const modeLabel = !st.mode ? '–' : st.mode === 'text' ? '글자 PDF' : st.mode === 'ai' ? 'AI 판독' : '스캔본 (데모 점수)';
    const top = `<div class="detail-grid">
      ${stat('학번', esc(st.studentId || '찾지 못함'))}
      ${stat('이름', esc(st.name || '찾지 못함'))}
      ${stat('총점', st.status !== 'success' ? BAD : `${fmt(st.total)} / ${fmt(totalOf(crit))}`, st.status !== 'success' ? 'bad' : 'good')}
      ${stat('판독 방식', `<span style="font-size:15px">${modeLabel}${r.pages ? ` · ${r.pages}쪽 · ${layoutTxt}` : ''}</span>`)}
    </div>`;
    const rows = crit.map((c) => {
      const s = st.scores?.find((x) => x.name === c.name);
      const val = st.status !== 'success' ? `<td class="num bad">${BAD}</td>` : s ? `<td class="num total">${fmt(s.score)}</td>` : '<td class="num pending">–</td>';
      return `<tr><td>${esc(c.name)}</td><td class="num">${fmt(c.points)}</td>${val}<td class="wrap">${esc(s?.comment || c.desc || '')}</td></tr>`;
    }).join('');
    const table = `<div class="table-wrap"><table><thead><tr><th>채점 항목</th><th class="num">배점</th><th class="num">점수</th><th>근거</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    const preview = st.textPreview ? `<details class="preview"><summary>AI가 읽은 본문 미리보기</summary><pre>${esc(st.textPreview)}</pre></details>` : '';
    return `<div class="stack">${title}${reason}${top}${table}${preview}</div>`;
  }

  // 한 파일에 학생이 여러 명 (학급 전체를 한 번에 스캔한 경우)
  const ok = sts.filter((x) => x.status === 'success').length;
  const top = `<div class="detail-grid">
    ${stat('학생 수', `${sts.length}명`)}
    ${stat('채점 완료', `${ok}명`, 'good')}
    ${stat('채점 불가', `${sts.length - ok}명`, sts.length - ok ? 'bad' : '')}
    ${stat('나눈 방식', `<span style="font-size:15px">${layoutTxt} · ${r.pages}쪽</span>`)}
  </div>`;
  const head = `<tr><th>#</th><th>쪽</th><th>학번</th><th>이름</th>${crit.map((c) => `<th class="num">${esc(c.name)} (${fmt(c.points)})</th>`).join('')}<th class="num">총점 (${fmt(totalOf(crit))})</th></tr>`;
  const rows = sts.map((st) => `<tr><td>${st.idx}</td><td>${esc(st.pageLabel)}</td><td>${esc(st.studentId || '–')}</td><td>${esc(studentLabel(f, st) || '–')}</td>${scoreCells(st, crit)}</tr>`).join('');
  const hint = r.layoutAuto ? `<p class="muted" style="margin:0">학생 나누기가 틀렸다면 <a href="#files" data-go-sec="${sec.id}">업로드 파일</a>에서 이 파일의 ‘양면/단면’ 버튼을 눌러 바꿔 주세요. 판단 근거: ${esc(r.layoutReason)}</p>` : '';
  return `<div class="stack">${title}${reason}${top}<div class="table-wrap"><table><thead>${head}</thead><tbody>${rows}</tbody></table></div>${hint}</div>`;
}

// ── 결과 영역 드롭다운 (영역 이름을 누르면 학급(파일) 고르기) ─────────────────
const menu = $('#tab-menu');
let menuFor = null;
function menuHtml(secId) {
  const sec = secById(secId);
  const ids = filesOf(secId);
  const sel = state.result;
  const item = (attr, label, on, extra = '') => `<button type="button" role="menuitemradio" aria-checked="${on}" ${attr}>${label}${extra}</button>`;
  return item(`data-pick-sec="${secId}"`, `<b>‘${esc(secName(sec))}’ 전체 학생</b>`, sel.kind === 'sec' && sel.sec === secId, ` <small>${counts(secId).students}명</small>`)
    + (ids.length ? '<div class="menu-sep" role="separator"></div><div class="menu-label">학급(파일)별</div>' : '<div class="menu-empty">아직 올린 파일이 없어요</div>')
    + ids.map((id) => {
      const f = state.files.get(id);
      const n = f.result?.students.length;
      const dot = f.status === 'success' ? 'success' : f.status === 'fail' ? 'fail' : '';
      return item(`data-pick-file="${id}"`, `<span class="tdot ${dot}"></span><span class="mname">${esc(fileTitle(f))}</span>`, sel.kind === 'file' && sel.file === id, n ? ` <small>${n}명</small>` : f.status === 'grading' ? ' <small>채점 중</small>' : '');
    }).join('');
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
    lines.push(['영역', '학번', '이름', '학급(파일)', '쪽', ...crit.map((c) => `${c.name}(${c.points})`), `총점(${totalOf(crit)})`, '상태']);
    for (const id of ids) {
      const f = state.files.get(id);
      if (!f.result) { lines.push([secName(sec), '', '', f.name, '', ...crit.map(() => ''), '', '대기']); continue; }
      for (const st of f.result.students) {
        const bad = st.status !== 'success';
        lines.push([
          secName(sec), st.studentId ? `="${st.studentId}"` : '', studentLabel(f, st), f.name, st.pageLabel,
          ...crit.map((c) => (bad ? BAD : fmt(scoreOf(st, c)))),
          bad ? BAD : fmt(st.total),
          bad ? `실패: ${st.reason || f.error}` : st.mode === 'scan-demo' ? '성공(데모 점수)' : '성공',
        ]);
      }
    }
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
    const tr = e.target.closest('tr[data-open-file]');
    if (tr) { const f = state.files.get(tr.dataset.openFile); if (f) setResult({ kind: 'file', sec: f.sec, file: f.id }); }
  });
  $('#export-csv').addEventListener('click', exportCsv);
  window.addEventListener('resize', () => { if (menuFor) placeMenu(); });

  window.addEventListener('beforeunload', (e) => {
    if (state.files.size) { e.preventDefault(); e.returnValue = ''; }
  });
}

// ── 시작 ────────────────────────────────────────────────────────────────
persist(); // 예전 설정을 새 형식으로 옮겨 저장
initSettings();
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
