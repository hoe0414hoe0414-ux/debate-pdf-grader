import { parseCriteria, criteriaSignature, EXAMPLE_CRITERIA } from './criteria.js';
import { gradeFile, loadPdfjs, GradeError, extractStudentId, extractName } from './grader.js';

const $ = (s) => document.querySelector(s);
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
  return store.set(KEY, { idDigits: state.idDigits, criteriaText: state.criteriaText, criteria: state.criteria, savedAt: state.savedAt, notes: state.notes });
}
const settingsSig = () => `${state.idDigits}\u0003${criteriaSignature(state.criteria)}\u0003${state.notes}`;

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
  const draft = store.get(DRAFT_KEY);
  ta.value = typeof draft === 'string' ? draft : state.criteriaText;
  notes.value = state.notes;

  let vTimer = 0;
  ta.addEventListener('input', () => {
    clearTimeout(vTimer);
    vTimer = setTimeout(() => { store.set(DRAFT_KEY, ta.value); renderCriteriaState(); }, 150);
  });
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
    ta.value = state.criteriaText; store.del(DRAFT_KEY); renderCriteriaState(); toast('저장된 기준으로 되돌렸어요.');
  });
  $('#criteria-example').addEventListener('click', () => {
    if (ta.value.trim() && ta.value !== EXAMPLE_CRITERIA) {
      ta.value = `${ta.value.replace(/\s+$/, '')}\n\n${EXAMPLE_CRITERIA}`;
      toast('예시를 기존 내용 아래에 붙였어요. 겹치는 항목은 지워 주세요.');
    } else ta.value = EXAMPLE_CRITERIA;
    store.set(DRAFT_KEY, ta.value);
    renderCriteriaState();
    ta.focus();
  });
  renderCriteriaState();
}

function renderCriteriaState() {
  const r = parseCriteria(ta.value);
  const box = $('#criteria-validation');
  const lines = [];
  if (r.ok) lines.push(`<div class="ok">✓ 항목 ${r.items.length}개 · 총점 ${r.total}점</div>`);
  r.errors.slice(0, 8).forEach((e) => lines.push(`<div class="err">✕ ${esc(e.msg)}</div>`));
  if (r.errors.length > 8) lines.push(`<div class="err">… 오류 ${r.errors.length - 8}개 더</div>`);
  if (r.ok) r.warnings.slice(0, 3).forEach((w) => lines.push(`<div class="warn">! ${esc(w)}</div>`));
  box.innerHTML = lines.join('');

  const st = $('#criteria-state');
  const isDirty = ta.value !== state.criteriaText;
  st.className = 'save-state' + (isDirty ? ' dirty' : state.savedAt ? ' saved' : '');
  st.textContent = isDirty ? '저장되지 않은 변경 있음' : state.savedAt ? `저장됨 · ${new Date(state.savedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : '아직 저장 안 됨';
  $('#criteria-save').disabled = !r.ok;
  $('#criteria-revert').disabled = !isDirty || !state.savedAt;
}

function saveCriteria() {
  const r = parseCriteria(ta.value);
  if (!r.ok) { renderCriteriaState(); toast('채점 기준에 오류가 있어 저장하지 않았어요. 빨간 안내를 확인해 주세요.'); return; }
  const before = criteriaSignature(state.criteria);
  state.criteriaText = ta.value;
  state.criteria = r.items.map(({ name, points, desc }) => ({ name, points, desc }));
  state.savedAt = Date.now();
  const ok = persist();
  store.del(DRAFT_KEY);
  renderCriteriaState();
  toast(ok ? `채점 기준 ${r.items.length}개 항목을 저장했어요.` : '저장했지만 이 브라우저는 저장소가 막혀 있어 새로고침하면 사라져요.');
  if (before !== criteriaSignature(state.criteria)) markStale();
  pump();
}

function markStale() {
  const sig = settingsSig();
  let any = false;
  for (const f of state.files.values()) if (f.result && f.sig !== sig) any = true;
  invalidate('files', 'results');
  return any;
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
    state.files.set(id, { id, file, name: file.name, size: file.size, status: 'pending', result: null, error: '', sig: null });
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
  const sig = settingsSig();
  const opts = { criteria: state.criteria, idDigits: state.idDigits, notes: state.notes };
  try {
    const res = await gradeFile(f.file, opts, ctrl.signal);
    if (state.files.get(f.id) !== f) return; // 도중에 삭제됨
    f.result = res; f.sig = sig; f.status = res.status; f.error = res.reason || '';
  } catch (e) {
    if (e?.name === 'AbortError' || state.files.get(f.id) !== f) return;
    // 열지 못한 파일도 파일명에서 학번·이름은 찾아 표에 보여 준다
    f.result = { studentId: extractStudentId(f.name, opts.idDigits), name: extractName(f.name, ''), scores: null, total: null, mode: null, pages: null };
    f.sig = sig; f.status = 'fail';
    f.error = e instanceof GradeError ? e.message : '읽는 중 문제가 생겼어요';
    if (!(e instanceof GradeError)) console.error(e);
  } finally {
    running--;
    f.abort = null;
    invalidate('files', 'results', 'badges');
    // 다음 작업은 다음 틱에 시작해 화면이 숨 쉴 틈을 준다
    setTimeout(pump, 0);
  }
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
    case 'success': return '채점 완료 · 결과 보기';
    case 'fail': return `채점 실패 · ${f.error || '판독 불가'}`;
    case 'grading': return '채점 중…';
    default: return canGrade() ? '대기 중' : '기준 저장 후 채점';
  }
}
function counts() {
  let s = 0, x = 0, p = 0;
  for (const f of state.files.values()) { if (f.status === 'success') s++; else if (f.status === 'fail') x++; else p++; }
  return { s, x, p, n: state.files.size };
}
function renderFiles() {
  const c = counts();
  $('#files-summary').textContent = c.n ? `파일 ${c.n}개 · 성공 ${c.s} · 실패 ${c.x}${c.p ? ` · 대기/진행 ${c.p}` : ''}` : '아직 올린 파일이 없어요.';
  $('#regrade-all').hidden = !c.n;
  $('#clear-all').hidden = !c.n;

  const notice = $('#files-notice');
  const sig = settingsSig();
  const stale = [...state.files.values()].some((f) => f.result && f.sig !== sig || (f.status === 'fail' && f.sig && f.sig !== sig));
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
    return `<span class="dot"></span>
      <span class="name" title="${esc(f.name)}">${esc(f.name)}</span>
      <span class="size">${fmtSize(f.size)}</span>
      ${link ? `<button type="button" class="status" data-link="${f.id}">${esc(statusText(f))}</button>` : `<span class="status">${esc(statusText(f))}</span>`}
      <button type="button" class="remove" data-remove="${f.id}" aria-label="${esc(f.name)} 업로드 취소" title="업로드 취소">${X_ICON}</button>`;
  };
  // 목록 구성이 그대로면 상태가 바뀐 줄만 고친다 (파일이 수백 개여도 렉 없음)
  if (ul.dataset.v === String(listVersion)) {
    for (const li of ul.children) {
      const f = state.files.get(li.dataset.id);
      const key = `${f.status}|${statusText(f)}`;
      if (li.dataset.k !== key) { li.className = `file-row ${f.status}`; li.dataset.k = key; li.innerHTML = rowHtml(f); }
    }
    return;
  }
  ul.innerHTML = state.order.map((id) => {
    const f = state.files.get(id);
    return `<li class="file-row ${f.status}" data-id="${id}" data-k="${esc(`${f.status}|${statusText(f)}`)}">${rowHtml(f)}</li>`;
  }).join('');
  ul.dataset.v = String(listVersion);
}
function renderBadges() {
  const c = counts();
  const bf = $('#badge-files'), br = $('#badge-results');
  bf.hidden = !c.n; bf.textContent = c.n;
  br.hidden = !(c.s + c.x); br.textContent = c.s + c.x;
}

// ── 결과 화면 렌더링 ──────────────────────────────────────────────────────
const fmt = (n) => (n == null ? '' : Number.isInteger(n) ? String(n) : n.toFixed(1));
const total = () => state.criteria.reduce((s, c) => s + c.points, 0);
const BAD = '(채점 불가)';

function scoreFor(f, crit) {
  const r = f.result;
  if (!r || !r.scores) return null;
  const hit = r.scores.find((x) => x.name === crit.name);
  return hit ? hit.score : undefined;
}

function renderResults() {
  const tabs = $('#result-tabs');
  const body = $('#result-body');
  const ids = state.order;
  $('#export-csv').hidden = !ids.length;

  const sig = settingsSig();
  const anyStale = ids.some((id) => { const f = state.files.get(id); return f.sig && f.sig !== sig; });
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
      return `<button type="button" class="tab" role="tab" data-tab="${id}" aria-selected="${state.resultTab === id}" title="${esc(f.name)}"><span class="tdot ${cls}"></span>${esc(f.name.replace(/\.pdf$/i, ''))}</button>`;
    })).join('');
  const sel = tabs.querySelector('[aria-selected="true"]');
  if (sel) sel.scrollIntoView({ block: 'nearest', inline: 'nearest' });

  body.innerHTML = state.resultTab === 'all' ? renderAllTable(ids) : renderDetail(state.files.get(state.resultTab));
}

function renderAllTable(ids) {
  const crit = state.criteria;
  const head = `<tr><th>학번</th><th>이름</th><th>파일</th>${crit.map((c) => `<th class="num">${esc(c.name)} (${fmt(c.points)})</th>`).join('')}<th class="num">총점 (${fmt(total())})</th></tr>`;
  const rows = ids.map((id) => {
    const f = state.files.get(id);
    const r = f.result;
    let cells;
    if (f.status === 'fail') {
      cells = crit.map(() => `<td class="num bad">${BAD}</td>`).join('') + `<td class="num total bad">${BAD}</td>`;
    } else if (f.status === 'success') {
      cells = crit.map((c) => { const v = scoreFor(f, c); return v == null ? '<td class="num pending">–</td>' : `<td class="num">${fmt(v)}</td>`; }).join('')
        + `<td class="num total">${fmt(r.total)}${r.mode === 'scan-demo' ? '<span class="demo-tag">데모</span>' : ''}</td>`;
    } else {
      const label = f.status === 'grading' ? '채점 중…' : '대기 중';
      cells = crit.map(() => `<td class="num pending">${label}</td>`).join('') + `<td class="num pending">${label}</td>`;
    }
    return `<tr class="clickable" data-tab="${id}"><td>${esc(r?.studentId || '–')}</td><td>${esc(r?.name || '–')}</td><td>${esc(f.name)}</td>${cells}</tr>`;
  }).join('');
  if (!crit.length) return '<div class="empty">채점 기준이 없어요. <a href="#settings">설정</a>에서 기준을 저장해 주세요.</div>';
  return `<div class="table-wrap"><table><thead>${head}</thead><tbody>${rows}</tbody></table></div>
    <p class="muted" style="margin:0">※ 빨간색 ${BAD}는 AI가 학생이 쓴 글을 해석하지 못한 경우예요. 원본 PDF를 직접 확인해 주세요. ‘데모’ 표시는 스캔본에 임시 점수를 보여 준 것입니다.</p>`;
}

function renderDetail(f) {
  const r = f.result;
  const stat = (k, v, cls = '') => `<div class="stat"><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`;
  if (f.status !== 'success' && f.status !== 'fail') {
    return `<div class="empty">${f.status === 'grading' ? '채점 중이에요…' : '아직 채점하지 않았어요.'}</div>`;
  }
  const modeLabel = !r?.mode ? '–' : r.mode === 'text' ? '글자 PDF (본문 판독)' : r.mode === 'ai' ? 'AI 판독' : '스캔본 (데모 점수)';
  const top = `<div class="detail-grid">
    ${stat('학번', esc(r?.studentId || '찾지 못함'))}
    ${stat('이름', esc(r?.name || '찾지 못함'))}
    ${stat('총점', f.status === 'fail' ? BAD : `${fmt(r.total)} / ${fmt(total())}`, f.status === 'fail' ? 'bad' : 'good')}
    ${stat('판독 방식', `<span style="font-size:15px">${modeLabel}${r?.pages ? ` · ${r.pages}쪽` : ''}</span>`)}
  </div>`;
  const reason = f.status === 'fail' ? `<div class="notice warn">채점 실패: ${esc(f.error || '판독 불가')}</div>` : '';
  const rows = state.criteria.map((c) => {
    const s = r?.scores?.find((x) => x.name === c.name);
    const val = f.status === 'fail' ? `<td class="num bad">${BAD}</td>` : s ? `<td class="num total">${fmt(s.score)}</td>` : '<td class="num pending">–</td>';
    return `<tr><td>${esc(c.name)}</td><td class="num">${fmt(c.points)}</td>${val}<td class="wrap">${esc(s?.comment || c.desc || '')}</td></tr>`;
  }).join('');
  const table = `<div class="table-wrap"><table><thead><tr><th>채점 항목</th><th class="num">배점</th><th class="num">점수</th><th>근거</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  const preview = r?.textPreview ? `<details class="preview"><summary>AI가 읽은 본문 미리보기</summary><pre>${esc(r.textPreview)}</pre></details>` : '';
  return `<div class="stack">${reason}${top}${table}${preview}</div>`;
}

// ── CSV(엑셀) 내보내기 ────────────────────────────────────────────────────
function exportCsv() {
  const q = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const crit = state.criteria;
  const rows = [['학번', '이름', '파일', ...crit.map((c) => `${c.name}(${c.points})`), `총점(${total()})`, '상태']];
  for (const id of state.order) {
    const f = state.files.get(id); const r = f.result;
    const bad = f.status === 'fail';
    rows.push([
      r?.studentId ? `="${r.studentId}"` : '', r?.name || '', f.name,
      ...crit.map((c) => (bad ? BAD : fmt(scoreFor(f, c)) || '')),
      bad ? BAD : r ? fmt(r.total) : '',
      bad ? `실패: ${f.error}` : f.status === 'success' ? (r.mode === 'scan-demo' ? '성공(데모 점수)' : '성공') : '대기',
    ]);
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
