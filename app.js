import { parseCriteria, criteriaSignature, EXAMPLE_CRITERIA } from './criteria.js';
import { gradeFile, loadPdfjs, GradeError, extractStudentId, extractName } from './grader.js';

const LAYOUTS = { auto: '자동', duplex: '양면', simplex: '단면' };

const $ = (s) => document.querySelector(s);
const fmtNum = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });
const CONCURRENCY = 2;
const MAX_FILE_MB = 80;

// ── 저장소 (브라우저 저장이 막혀 있어도 앱은 동작) ──────────────────────────
const KEY = 'dpg.settings.v1';
const DRAFT_KEY = 'dpg.criteriaDraft.v1';
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* 무시 */ } },
};

// ── 상태 ────────────────────────────────────────────────────────────────
const saved = store.get(KEY) || {};
const state = {
  idDigits: saved.idDigits === 4 ? 4 : 5,
  criteriaText: typeof saved.criteriaText === 'string' ? saved.criteriaText : '',
  criteria: Array.isArray(saved.criteria) ? saved.criteria : [],
  savedAt: saved.savedAt || null,
  notes: typeof saved.notes === 'string' ? saved.notes : '',
  layoutDefault: ['auto', 'duplex', 'simplex'].includes(saved.layoutDefault) ? saved.layoutDefault : 'auto',
  files: new Map(),   // id -> 파일 항목
  order: [],          // 정렬된 id 목록
  resultTab: 'all',
  view: 'settings',
};
let seq = 0;
let listVersion = 0; // 파일 추가/삭제 때만 증가
const queue = [];
let running = 0;

function persist() {
  return store.set(KEY, { idDigits: state.idDigits, criteriaText: state.criteriaText, criteria: state.criteria, savedAt: state.savedAt, notes: state.notes, layoutDefault: state.layoutDefault });
}
const settingsSig = () => `${state.idDigits}\u0003${state.criteriaText}\u0003${criteriaSignature(state.criteria)}\u0003${state.notes}`;
// 파일마다 고른 양면/단면 (null이면 설정의 기본값을 따름)
const layoutChoice = (f) => f.layout || state.layoutDefault;
const fileSig = (f) => `${settingsSig()}\u0003${layoutChoice(f)}`;
const isStale = (f) => !!f.sig && f.sig !== fileSig(f);

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
  if (v === 'results' && sub) state.resultTab = state.files.has(sub) ? sub : 'all';
  state.view = v;
  document.querySelectorAll('.view').forEach((el) => { el.hidden = el.dataset.view !== v; });
  document.querySelectorAll('.nav-item').forEach((el) => {
    const on = el.dataset.view === v;
    el.classList.toggle('active', on);
    if (on) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
  });
  if (v === 'files') renderFiles();
  if (v === 'results') renderResults();
  if (v === 'settings') renderCriteriaState();
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

// ── 설정 화면 ────────────────────────────────────────────────────────────
const ta = $('#criteria');
let draftAt = null; // 임시 저장 시각 (-1: 브라우저가 저장을 막음)
const notes = $('#reading-notes');

function initSettings() {
  document.querySelectorAll('input[name="idDigits"]').forEach((r) => {
    r.checked = Number(r.value) === state.idDigits;
    r.addEventListener('change', () => {
      state.idDigits = Number(r.value);
      persist();
      markStale();
      toast(`학번을 ${state.idDigits}자리로 저장했어요.`);
    });
  });
  document.querySelectorAll('input[name="layoutDefault"]').forEach((r) => {
    r.checked = r.value === state.layoutDefault;
    r.addEventListener('change', () => {
      state.layoutDefault = r.value;
      persist();
      markStale();
      toast(`양면/단면 기본값을 ‘${LAYOUTS[r.value]}’(으)로 저장했어요.`);
    });
  });
  const draft = store.get(DRAFT_KEY);
  ta.value = typeof draft === 'string' ? draft : state.criteriaText;
  if (typeof draft === 'string' && draft !== state.criteriaText) draftAt = Date.now();
  notes.value = state.notes;

  // 작성 중인 내용은 자동으로 임시 저장 (새로고침·창 닫기에도 유지)
  let vTimer = 0;
  const persistDraft = () => {
    if (ta.value === state.criteriaText) { store.del(DRAFT_KEY); draftAt = null; }
    else if (store.set(DRAFT_KEY, ta.value)) draftAt = Date.now();
    else draftAt = -1;
  };
  ta.addEventListener('input', () => {
    $('#criteria-save').disabled = !ta.value.trim(); // 저장 버튼은 즉시 반응
    clearTimeout(vTimer); vTimer = setTimeout(() => { persistDraft(); renderCriteriaState(); }, 300);
  });
  // 포커스가 빠지거나 창을 닫을 때는 저장만 한다 (화면을 다시 그리면 누르려던 버튼이 움직일 수 있음)
  ta.addEventListener('blur', persistDraft);
  window.addEventListener('pagehide', persistDraft);
  document.addEventListener('visibilitychange', () => { if (document.hidden) persistDraft(); });
  // Tab 키로 | 구분자 사이를 쉽게 쓰도록 하지 않음(접근성 유지). Ctrl/Cmd+S 저장 지원.
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveCriteria(); }
  });
  let nTimer = 0;
  notes.addEventListener('input', () => {
    clearTimeout(nTimer);
    nTimer = setTimeout(() => { state.notes = notes.value; persist(); markStale(); }, 400);
  });

  $('#criteria-save').addEventListener('click', saveCriteria);
  $('#criteria-revert').addEventListener('click', () => {
    clearTimeout(vTimer);
    ta.value = state.criteriaText; store.del(DRAFT_KEY); draftAt = null; renderCriteriaState(); toast('저장된 기준으로 되돌렸어요.');
  });
  $('#criteria-example').addEventListener('click', () => {
    clearTimeout(vTimer);
    if (ta.value.trim() && ta.value !== EXAMPLE_CRITERIA) {
      ta.value = `${ta.value.replace(/\s+$/, '')}\n\n${EXAMPLE_CRITERIA}`;
      toast('예시를 기존 내용 아래에 붙였어요. 겹치는 부분은 지워 주세요.');
    } else ta.value = EXAMPLE_CRITERIA;
    if (store.set(DRAFT_KEY, ta.value)) draftAt = Date.now();
    renderCriteriaState();
    ta.focus();
  });
  renderCriteriaState();
}

const hhmm = (t) => new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
function renderCriteriaState() {
  const r = parseCriteria(ta.value);
  const box = $('#criteria-validation');
  const lines = [];
  if (r.ok) {
    const chips = r.items.map((it) => `<span class="chip">${esc(it.name)} <b>${fmtNum(it.points)}점</b></span>`).join('');
    lines.push(`<div class="ok">✓ 결과표에 쓸 채점 항목 ${r.items.length}개 · 총 ${fmtNum(r.total)}점${r.assumed ? ' (자동 지정)' : ''}</div><div class="chips">${chips}</div>`);
    lines.push('<div class="muted">적은 글 전체가 AI에게 채점 지시문으로 그대로 전달돼요.</div>');
  }
  r.errors.forEach((e) => lines.push(`<div class="err">✕ ${esc(e.msg)}</div>`));
  r.warnings.slice(0, 3).forEach((w) => lines.push(`<div class="warn">! ${esc(w)}</div>`));
  box.innerHTML = lines.join('');

  const st = $('#criteria-state');
  const isDirty = ta.value !== state.criteriaText;
  st.className = 'save-state' + (isDirty ? ' dirty' : state.savedAt ? ' saved' : '');
  if (isDirty) st.textContent = draftAt === -1 ? '이 브라우저는 임시 저장이 막혀 있어요 · ‘기준 저장’을 눌러 주세요' : draftAt ? `작성 중 · ${hhmm(draftAt)} 임시 저장됨 · 채점에 쓰려면 ‘기준 저장’` : '작성 중';
  else st.textContent = state.savedAt ? `저장됨 · ${new Date(state.savedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : '아직 저장 안 됨';
  $('#criteria-save').disabled = !r.ok || (!isDirty && !!state.savedAt);
  $('#criteria-revert').disabled = !isDirty || !state.savedAt;
}

function saveCriteria() {
  const r = parseCriteria(ta.value);
  if (!r.ok) { renderCriteriaState(); toast('채점 기준이 비어 있어요.'); return; }
  const before = criteriaSignature(state.criteria);
  state.criteriaText = ta.value;
  state.criteria = r.items.map(({ name, points, desc }) => ({ name, points, desc }));
  state.savedAt = Date.now();
  const ok = persist();
  store.del(DRAFT_KEY);
  renderCriteriaState();
  draftAt = null;
  toast(ok ? `채점 기준을 저장했어요. (채점 항목 ${r.items.length}개)` : '저장했지만 이 브라우저는 저장소가 막혀 있어 새로고침하면 사라져요.');
  if (before !== criteriaSignature(state.criteria)) markStale();
  pump();
}

function markStale() {
  invalidate('files', 'results');
}

// ── 파일 업로드 ───────────────────────────────────────────────────────────
function addFiles(list) {
  const incoming = [...list];
  let added = 0, dup = 0, skipped = 0, big = 0;
  const keys = new Set([...state.files.values()].map((f) => `${f.name}\u0000${f.size}`));
  for (const file of incoming) {
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    if (!isPdf) { skipped++; continue; }
    if (file.size > MAX_FILE_MB * 1024 * 1024) { big++; continue; }
    const k = `${file.name}\u0000${file.size}`;
    if (keys.has(k)) { dup++; continue; }
    keys.add(k);
    const id = `f${++seq}`;
    state.files.set(id, { id, file, name: file.name, size: file.size, status: 'pending', result: null, error: '', sig: null, layout: null });
    added++;
    queue.push(id);
  }
  if (added) sortFiles();
  const msg = [];
  if (added) msg.push(`${added}개 추가`);
  if (dup) msg.push(`중복 ${dup}개 제외`);
  if (skipped) msg.push(`PDF가 아닌 파일 ${skipped}개 제외`);
  if (big) msg.push(`${MAX_FILE_MB}MB 초과 ${big}개 제외`);
  if (msg.length) toast(msg.join(' · '));
  invalidate('files', 'results', 'badges');
  if (added) { loadPdfjs().catch(() => {}); pump(); }
}
function sortFiles() {
  listVersion++;
  state.order = [...state.files.keys()].sort((a, b) => collator.compare(state.files.get(a).name, state.files.get(b).name));
}
function removeFile(id) {
  const f = state.files.get(id);
  if (!f) return;
  f.abort?.abort();
  state.files.delete(id);
  state.order = state.order.filter((x) => x !== id);
  listVersion++;
  const qi = queue.indexOf(id); if (qi >= 0) queue.splice(qi, 1);
  if (state.resultTab === id) state.resultTab = 'all';
  invalidate('files', 'results', 'badges');
}

// ── 채점 대기열 (동시에 2개씩, 화면은 멈추지 않음) ──────────────────────────
function canGrade() { return state.criteria.length > 0; }
function pump() {
  if (!canGrade()) { invalidate('files'); return; }
  while (running < CONCURRENCY && queue.length) {
    const id = queue.shift();
    const f = state.files.get(id);
    if (!f || f.status === 'grading') continue;
    run(f);
  }
}
async function run(f) {
  running++;
  const ctrl = new AbortController();
  f.abort = ctrl; f.status = 'grading'; f.error = '';
  invalidate('files', 'badges');
  const sig = fileSig(f);
  const opts = { criteria: state.criteria, prompt: state.criteriaText, idDigits: state.idDigits, notes: state.notes, layout: layoutChoice(f) };
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
  const next = value === state.layoutDefault ? null : value;
  if (layoutChoice(f) === value && f.layout === next) return;
  f.layout = next;
  if (canGrade()) regradeOne(f); else invalidate('files');
}
function regradeAll() {
  if (!canGrade()) { toast('채점 기준을 먼저 저장해 주세요.'); return; }
  for (const id of state.order) {
    const f = state.files.get(id);
    if (f.status === 'grading') continue;
    f.status = 'pending'; f.result = null; f.error = '';
    if (!queue.includes(id)) queue.push(id);
  }
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
    default: return canGrade() ? '대기 중' : '기준 저장 후 채점';
  }
}
function counts() {
  let s = 0, x = 0, p = 0, students = 0;
  for (const f of state.files.values()) {
    if (f.status === 'success') s++; else if (f.status === 'fail') x++; else p++;
    if (f.result) students += f.result.students.length;
  }
  return { s, x, p, n: state.files.size, students };
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
  const c = counts();
  $('#files-summary').textContent = c.n ? `파일 ${c.n}개 · 학생 ${c.students}명 · 성공 ${c.s} · 실패 ${c.x}${c.p ? ` · 대기/진행 ${c.p}` : ''}` : '아직 올린 파일이 없어요.';
  $('#regrade-all').hidden = !c.n;
  $('#clear-all').hidden = !c.n;

  const notice = $('#files-notice');
  const stale = [...state.files.values()].some(isStale);
  if (!canGrade() && c.n) {
    notice.innerHTML = '채점 기준이 아직 저장되지 않아 채점을 시작하지 않았어요. <a href="#settings">설정으로 이동</a>';
    notice.hidden = false;
  } else if (stale) {
    notice.innerHTML = '설정이 바뀌었어요. 새 기준으로 점수를 다시 매기려면 <button type="button" class="btn small" data-act="regrade">다시 채점</button>';
    notice.hidden = false;
  } else notice.hidden = true;

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
  if (ul.dataset.v === String(listVersion)) {
    for (const li of ul.children) {
      const f = state.files.get(li.dataset.id);
      const key = rowKey(f);
      if (li.dataset.k !== key) { li.className = `file-row ${f.status}`; li.dataset.k = key; li.innerHTML = rowHtml(f); }
    }
    return;
  }
  ul.innerHTML = state.order.map((id) => {
    const f = state.files.get(id);
    return `<li class="file-row ${f.status}" data-id="${id}" data-k="${esc(rowKey(f))}">${rowHtml(f)}</li>`;
  }).join('');
  ul.dataset.v = String(listVersion);
}
function renderBadges() {
  const c = counts();
  const bf = $('#badge-files'), br = $('#badge-results');
  bf.hidden = !c.n; bf.textContent = c.n;
  br.hidden = !c.students; br.textContent = c.students;
}

// ── 결과 화면 렌더링 ──────────────────────────────────────────────────────
const fmt = (n) => (n == null ? '' : Number.isInteger(n) ? String(n) : n.toFixed(1));
const total = () => state.criteria.reduce((s, c) => s + c.points, 0);
const BAD = '(채점 불가)';
const scoreOf = (st, crit) => { const hit = st.scores?.find((x) => x.name === crit.name); return hit ? hit.score : undefined; };
const studentLabel = (f, st) => st.name || (f.result.students.length > 1 ? `학생 ${st.idx}` : '');

function renderResults() {
  const tabs = $('#result-tabs');
  const body = $('#result-body');
  const ids = state.order;
  $('#export-csv').hidden = !ids.length;

  const anyStale = ids.some((id) => isStale(state.files.get(id)));
  const notice = $('#results-notice');
  notice.hidden = !anyStale;
  if (anyStale) notice.innerHTML = '설정이 바뀌어 일부 점수는 이전 기준으로 매겨졌어요. <button type="button" class="btn small" data-act="regrade">새 기준으로 다시 채점</button>';

  if (!ids.length) {
    tabs.innerHTML = '';
    body.innerHTML = '<div class="empty">아직 채점한 파일이 없어요. <a href="#files">업로드 파일</a>에서 PDF를 올려 주세요.</div>';
    return;
  }
  if (state.resultTab !== 'all' && !state.files.has(state.resultTab)) state.resultTab = 'all';

  tabs.innerHTML = [`<button type="button" class="tab" role="tab" data-tab="all" aria-selected="${state.resultTab === 'all'}">전체 결과표</button>`]
    .concat(ids.map((id) => {
      const f = state.files.get(id);
      const cls = f.status === 'success' ? 'success' : f.status === 'fail' ? 'fail' : '';
      const n = f.result?.students.length;
      return `<button type="button" class="tab" role="tab" data-tab="${id}" aria-selected="${state.resultTab === id}" title="${esc(f.name)}"><span class="tdot ${cls}"></span>${esc(f.name.replace(/\.pdf$/i, ''))}${n > 1 ? ` <small class="muted">${n}명</small>` : ''}</button>`;
    })).join('');
  // 선택된 탭이 보이도록 탭 줄만 가로로 이동 (페이지 전체는 움직이지 않음)
  const sel = tabs.querySelector('[aria-selected="true"]');
  if (sel) {
    const l = sel.offsetLeft - tabs.offsetLeft, r = l + sel.offsetWidth;
    if (l < tabs.scrollLeft) tabs.scrollLeft = l - 8;
    else if (r > tabs.scrollLeft + tabs.clientWidth) tabs.scrollLeft = r - tabs.clientWidth + 8;
  }

  // 채점 중 표가 다시 그려져도 보고 있던 스크롤 위치를 유지
  const prev = body.querySelector('.table-wrap');
  const keep = prev && body.dataset.tab === state.resultTab ? [prev.scrollTop, prev.scrollLeft] : null;
  body.innerHTML = state.resultTab === 'all' ? renderAllTable(ids) : renderDetail(state.files.get(state.resultTab));
  body.dataset.tab = state.resultTab;
  const next = body.querySelector('.table-wrap');
  if (keep && next) { next.scrollTop = keep[0]; next.scrollLeft = keep[1]; }
}

function scoreCells(st) {
  const crit = state.criteria;
  if (st.status !== 'success') return crit.map(() => `<td class="num bad">${BAD}</td>`).join('') + `<td class="num total bad">${BAD}</td>`;
  return crit.map((c) => { const v = scoreOf(st, c); return v == null ? '<td class="num pending">–</td>' : `<td class="num">${fmt(v)}</td>`; }).join('')
    + `<td class="num total">${fmt(st.total)}${st.mode === 'scan-demo' ? '<span class="demo-tag">데모</span>' : ''}</td>`;
}

function renderAllTable(ids) {
  const crit = state.criteria;
  if (!crit.length) return '<div class="empty">채점 기준이 없어요. <a href="#settings">설정</a>에서 기준을 저장해 주세요.</div>';
  const head = `<tr><th>학번</th><th>이름</th><th>파일</th><th>쪽</th>${crit.map((c) => `<th class="num">${esc(c.name)} (${fmt(c.points)})</th>`).join('')}<th class="num">총점 (${fmt(total())})</th></tr>`;
  const rows = [];
  for (const id of ids) {
    const f = state.files.get(id);
    if (!f.result) {
      const label = f.status === 'grading' ? '채점 중…' : '대기 중';
      rows.push(`<tr class="clickable" data-tab="${id}"><td>–</td><td>–</td><td>${esc(f.name)}</td><td>–</td>${crit.map(() => `<td class="num pending">${label}</td>`).join('')}<td class="num pending">${label}</td></tr>`);
      continue;
    }
    for (const st of f.result.students) {
      rows.push(`<tr class="clickable" data-tab="${id}"><td>${esc(st.studentId || '–')}</td><td>${esc(studentLabel(f, st) || '–')}</td><td>${esc(f.name)}</td><td>${esc(st.pageLabel || '–')}</td>${scoreCells(st)}</tr>`);
    }
  }
  return `<div class="table-wrap"><table><thead>${head}</thead><tbody>${rows.join('')}</tbody></table></div>
    <p class="muted" style="margin:0">※ 빨간색 ${BAD}는 AI가 학생이 쓴 글을 해석하지 못한 경우예요. 원본 PDF를 직접 확인해 주세요. ‘데모’ 표시는 스캔본에 임시 점수를 보여 준 것입니다. 양면은 2쪽(앞+뒤)을 학생 1명으로 채점해요.</p>`;
}

function renderDetail(f) {
  const r = f.result;
  const stat = (k, v, cls = '') => `<div class="stat"><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`;
  if (f.status !== 'success' && f.status !== 'fail') {
    return `<div class="empty">${f.status === 'grading' ? '채점 중이에요…' : '아직 채점하지 않았어요.'}</div>`;
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
      ${stat('총점', st.status !== 'success' ? BAD : `${fmt(st.total)} / ${fmt(total())}`, st.status !== 'success' ? 'bad' : 'good')}
      ${stat('판독 방식', `<span style="font-size:15px">${modeLabel}${r.pages ? ` · ${r.pages}쪽 · ${layoutTxt}` : ''}</span>`)}
    </div>`;
    const rows = state.criteria.map((c) => {
      const s = st.scores?.find((x) => x.name === c.name);
      const val = st.status !== 'success' ? `<td class="num bad">${BAD}</td>` : s ? `<td class="num total">${fmt(s.score)}</td>` : '<td class="num pending">–</td>';
      return `<tr><td>${esc(c.name)}</td><td class="num">${fmt(c.points)}</td>${val}<td class="wrap">${esc(s?.comment || c.desc || '')}</td></tr>`;
    }).join('');
    const table = `<div class="table-wrap"><table><thead><tr><th>채점 항목</th><th class="num">배점</th><th class="num">점수</th><th>근거</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    const preview = st.textPreview ? `<details class="preview"><summary>AI가 읽은 본문 미리보기</summary><pre>${esc(st.textPreview)}</pre></details>` : '';
    return `<div class="stack">${reason}${top}${table}${preview}</div>`;
  }

  // 한 파일에 학생이 여러 명 (반 전체를 한 번에 스캔한 경우)
  const ok = sts.filter((x) => x.status === 'success').length;
  const top = `<div class="detail-grid">
    ${stat('학생 수', `${sts.length}명`)}
    ${stat('채점 완료', `${ok}명`, 'good')}
    ${stat('채점 불가', `${sts.length - ok}명`, sts.length - ok ? 'bad' : '')}
    ${stat('나눈 방식', `<span style="font-size:15px">${layoutTxt} · ${r.pages}쪽</span>`)}
  </div>`;
  const crit = state.criteria;
  const head = `<tr><th>#</th><th>쪽</th><th>학번</th><th>이름</th>${crit.map((c) => `<th class="num">${esc(c.name)} (${fmt(c.points)})</th>`).join('')}<th class="num">총점 (${fmt(total())})</th></tr>`;
  const rows = sts.map((st) => `<tr><td>${st.idx}</td><td>${esc(st.pageLabel)}</td><td>${esc(st.studentId || '–')}</td><td>${esc(studentLabel(f, st) || '–')}</td>${scoreCells(st)}</tr>`).join('');
  const hint = r.layoutAuto ? `<p class="muted" style="margin:0">학생 나누기가 틀렸다면 <a href="#files">업로드 파일</a>에서 이 파일의 ‘양면/단면’ 버튼을 눌러 바꿔 주세요. 판단 근거: ${esc(r.layoutReason)}</p>` : '';
  return `<div class="stack">${reason}${top}<div class="table-wrap"><table><thead>${head}</thead><tbody>${rows}</tbody></table></div>${hint}</div>`;
}

// ── CSV(엑셀) 내보내기 ────────────────────────────────────────────────────
function exportCsv() {
  const q = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const crit = state.criteria;
  const rows = [['학번', '이름', '파일', '쪽', ...crit.map((c) => `${c.name}(${c.points})`), `총점(${total()})`, '상태']];
  for (const id of state.order) {
    const f = state.files.get(id);
    if (!f.result) { rows.push(['', '', f.name, '', ...crit.map(() => ''), '', '대기']); continue; }
    for (const st of f.result.students) {
      const bad = st.status !== 'success';
      rows.push([
        st.studentId ? `="${st.studentId}"` : '', studentLabel(f, st), f.name, st.pageLabel,
        ...crit.map((c) => (bad ? BAD : fmt(scoreOf(st, c)))),
        bad ? BAD : fmt(st.total),
        bad ? `실패: ${st.reason || f.error}` : st.mode === 'scan-demo' ? '성공(데모 점수)' : '성공',
      ]);
    }
  }
  const csv = '﻿' + rows.map((r) => r.map((v, i) => (i === 0 && String(v).startsWith('="') ? v : q(v))).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  const d = new Date();
  a.href = URL.createObjectURL(blob);
  a.download = `토론채점결과_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.csv`;
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
  });
  $('#regrade-all').addEventListener('click', regradeAll);

  const clearBtn = $('#clear-all');
  let armed = 0;
  clearBtn.addEventListener('click', () => {
    if (!armed) {
      clearBtn.textContent = '한 번 더 누르면 모두 삭제';
      armed = setTimeout(() => { armed = 0; clearBtn.textContent = '전체 삭제'; }, 3000);
      return;
    }
    clearTimeout(armed); armed = 0; clearBtn.textContent = '전체 삭제';
    for (const id of [...state.order]) removeFile(id);
    toast('목록을 모두 비웠어요.');
  });

  $('#result-tabs').addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]');
    if (!t) return;
    selectTab(t.dataset.tab);
  });
  $('#result-body').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-tab]');
    if (tr) selectTab(tr.dataset.tab);
  });
  $('#export-csv').addEventListener('click', exportCsv);

  window.addEventListener('beforeunload', (e) => {
    if (state.files.size) { e.preventDefault(); e.returnValue = ''; }
  });
}
function selectTab(tab) {
  state.resultTab = tab;
  const h = tab === 'all' ? '#results' : `#results/${tab}`;
  if (location.hash !== h) history.replaceState(null, '', h);
  renderResults();
}

// ── 시작 ────────────────────────────────────────────────────────────────
initSettings();
initEvents();
if (!location.hash && state.criteria.length) history.replaceState(null, '', '#files');
route();
renderBadges();

// 첫 화면을 그린 뒤 브라우저가 한가할 때 PDF 엔진을 미리 데워 둔다 → 업로드 순간 렉 방지
const idle = (fn, t) => ('requestIdleCallback' in window ? requestIdleCallback(fn, { timeout: t }) : setTimeout(fn, t));
idle(() => loadPdfjs().catch(() => {}), 2500);

// 오프라인/재방문 속도를 위한 서비스 워커 (첫 화면 그린 뒤 여유 있을 때 등록)
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  idle(() => navigator.serviceWorker.register('./sw.js').catch(() => {}), 4000);
}
