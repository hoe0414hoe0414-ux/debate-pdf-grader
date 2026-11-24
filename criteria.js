// 채점 기준 해석기
// 채점 기준은 AI에게 주는 지시문(프롬프트)처럼 자유롭게 씁니다. 글 전체가 그대로 AI에게 전달되고,
// 여기서는 결과표의 열(채점 항목과 배점)만 뽑아냅니다. 형식이 달라도 저장을 막지 않습니다.
//
// 인식하는 배점 표기 예:
//   1. 사회 문제 탐색 : 30점 만점        가) 근거의 타당성 (40점)
//   - 반론 대응 – 30점                    주장의 명확성 | 30 | 설명   (예전 형식도 그대로 됨)

export const MAX_ITEMS = 30;
const MAX_NAME = 40;
const MAX_POINTS = 1000;

export const EXAMPLE_CRITERIA = [
  '## 평가 : 찬반 토론 입론서 작성',
  '',
  '## 토론 주제',
  '1번 : 국가는 국민의 생체 데이터를 빅데이터로 수집 및 활용해야 한다.',
  '2번 : 완전 자율주행 자동차의 상용화를 허용해야 한다.',
  '',
  '## 채점 기준',
  '1. 주장의 명확성 : 30점 만점',
  '자신의 입장(찬성/반대)이 분명하게 드러나고 토론 주제에서 벗어나지 않는가.',
  '',
  '2. 근거의 타당성 : 40점 만점',
  '통계, 사례, 전문가 의견 등 믿을 만한 근거가 주장을 충분히 뒷받침하는가.',
  '',
  '3. 반론 대응 : 30점 만점',
  '예상되는 반론을 언급하고 논리적으로 반박하는가.',
  '',
  '## 참고',
  '글씨를 알아볼 수 없는 부분은 추측하지 말고 판독 불가로 표시할 것.',
].join('\n');

const LEVEL_WORDS = /^(상|중|하|최상|최하|중상|중하|우수|보통|미흡|매우\s*우수|매우\s*미흡|잘함|보통임|노력\s*요함|[A-F][+-]?|[0-9]+\s*단계)$/;
const TOTAL_WORDS = /^(총점|합계|총|만점|배점|전체|계)$/;
const SCORE_RE = /(\d+(?:\.\d+)?)\s*점/;
// 줄 앞의 번호·기호 (1. / 1) / (1) / 가. / ① / - / * / ## …)
const LEAD_RE = /^\s*(?:#{1,6}\s*)?(?:[-*•·▶▷◆◇■□○●]\s*)?(?:\(?\d{1,2}[.)]|\(?[가-하][.)]|[①-⑳]|\d{1,2}\s*번\s*[.:)]?)?\s*/;
const NUM_HEAD_RE = /^\s*(?:\(?\d{1,2}[.)]|[①-⑳]|\(?[가-하][.)])\s*(\S.*)$/;
// 감점 규칙: “-4점”, “4점 감점”, “감점 4점”
const DEDUCT_RE = /(?:^|[^\w.])[-−–](\d+(?:\.\d+)?)\s*점|(\d+(?:\.\d+)?)\s*점\s*(?:감점|차감)|(?:감점|차감)\s*(\d+(?:\.\d+)?)\s*점/;
// 항목이 아니라 채점 규칙인 줄에 들어가는 말
const RULE_WORDS = /(기본\s*점수|백지|이하|미만|이상|초과|최저|최하|최소|최고|감점|가점|차감|경우|표기|부여|처리|간주)/;
// 항목 설명이 아니라 공통 안내인 구역 제목
const NOTE_HEAD = /(유의|주의|참고|비고|안내|공통|예외)/;

function cleanName(s) {
  return s.replace(LEAD_RE, '').replace(/[\s:：\-–—~(\[（【,]+$/g, '').replace(/^[\s:：\-–—]+/, '').replace(/\*\*/g, '').trim();
}
const num = (x) => Number(x);

/**
 * 채점 기준 해석. 두 가지 방식을 알아본다.
 *  - 배점식: “1. 주장의 명확성 : 30점” 처럼 항목마다 배점 → 항목 점수의 합이 총점
 *  - 감점식: 항목(“1. 주장”) 아래 “-4점” 같은 감점 규칙 → 만점에서 감점을 뺀 값이 총점
 * 공통 규칙: 최저점(“48점 이하로 내려가면 48점으로 표기”), 백지 점수(“백지 … 48점”), 만점(“만점 100점”)
 */
export function parseCriteria(src) {
  const text = String(src ?? '').replace(/\r\n?/g, '\n').replace(/[​-‍﻿]/g, '');
  const lines = text.split('\n');
  const errors = [];
  const warnings = [];
  const scored = [];      // 배점이 붙은 항목
  const heads = [];       // 번호만 붙은 항목 후보 (감점식에서 사용)
  let current = null;
  let inNotes = false;
  let mentionedTotal = null;
  let floor = null, blank = null, maxScore = null;
  let deductCount = 0;
  const orphanDeductions = [];

  const uniq = (list, name) => {
    let n = name.slice(0, MAX_NAME);
    let k = 2;
    while (list.some((it) => it.name === n)) n = `${name.slice(0, MAX_NAME - 4)} (${k++})`;
    return n;
  };
  const pushScored = (name, points, lineNo) => {
    current = { name: uniq(scored, name), points, desc: '', line: lineNo, deductions: [] };
    scored.push(current); heads.push(current);
  };

  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const line = raw.trim();
    if (!line) return;

    // 제목(##)은 새 구역 → 앞 항목의 설명을 끝냄
    if (/^#{1,6}(\s|$)/.test(line)) {
      current = null;
      inNotes = NOTE_HEAD.test(line);
      const mx = line.match(/만점\s*[:：]?\s*(\d+(?:\.\d+)?)\s*점|(\d+(?:\.\d+)?)\s*점\s*만점/);
      if (mx) maxScore = num(mx[1] || mx[2]);
      return;
    }

    // ── 공통 규칙 (어디에 있든 읽음) ──
    let rule = false;
    const fl = line.match(/(\d+(?:\.\d+)?)\s*점\s*(?:이하|미만)[^\n]*?(\d+(?:\.\d+)?)\s*점\s*(?:으로|로)/)
      || line.match(/(?:최저|최하|최소)\s*점?\s*(?:수)?\s*(?:은|는|:|：)?\s*()(\d+(?:\.\d+)?)\s*점/);
    if (fl) { floor = num(fl[2]); rule = true; }
    if (/백지|무응답|미제출/.test(line)) { const b = line.match(SCORE_RE); if (b) { blank = num(b[1]); rule = true; } }
    const mx = line.match(/(?:만점|총점|기본\s*점수)\s*(?:은|는|이|:|：)?\s*(\d+(?:\.\d+)?)\s*점(?!\s*(?:이하|미만|이상))/) || line.match(/^[^0-9]{0,6}(\d+(?:\.\d+)?)\s*점\s*만점\s*$/);
    if (mx && !rule && !/백지|이하|미만/.test(line)) {
      const name = cleanName(line.slice(0, line.indexOf(mx[0])));
      if (!name || TOTAL_WORDS.test(name.replace(/\s/g, '')) || /^(총점|합계|만점|기본\s*점수)/.test(name) || /(만점|총점)/.test(mx[0])) {
        if (!name || /^(총점|합계|만점|기본|배점|전체)/.test(name.replace(/\s/g, '')) || /만점은|만점:|총점은|총점:/.test(line.replace(/\s/g, ''))) {
          if (/^\s*(?:[-*•]\s*)?(?:총점|합계|만점|기본\s*점수|배점)/.test(line) || !name) { maxScore = num(mx[1]); mentionedTotal = num(mx[1]); rule = true; }
        }
      }
    }
    if (rule) return;

    // ── 감점 규칙 ──
    const dm = line.match(DEDUCT_RE);
    if (dm) {
      const pts = num(dm[1] || dm[2] || dm[3]);
      if (pts > 0 && pts <= MAX_POINTS) {
        deductCount++;
        const d = { text: line.replace(/^[-*•·▶▷]\s*/, ''), pts };
        if (current) { current.deductions.push(d); current.desc = (current.desc ? `${current.desc}\n` : '') + line; }
        else if (!inNotes) orphanDeductions.push(d);
        return;
      }
    }

    // ── 예전 형식: 항목명 | 배점 | 설명 ──
    if (/[|｜]/.test(line)) {
      const [name, pts, ...rest] = line.split(/[|｜]/).map((x) => x.trim());
      const n = Number(String(pts || '').replace(/\s|점/g, ''));
      if (name && n > 0 && n <= MAX_POINTS) { pushScored(cleanName(name) || name, n, lineNo); current.desc = rest.join(' | ').trim(); return; }
    }

    // ── 배점이 붙은 항목: “1. 항목 : 30점” ──
    const m = line.match(SCORE_RE);
    if (m && !inNotes) {
      const name = cleanName(line.slice(0, m.index));
      const pts = num(m[1]);
      if (TOTAL_WORDS.test(name.replace(/\s/g, '')) || /^(총점|합계)/.test(name)) { mentionedTotal = pts; return; }
      const isSubRule = (current && /^[-*•·▶▷]/.test(line)) || /(하면|이면|되면|으면|쓰면|있으면|없으면|경우|때|마다)$/.test(name) || name.split(/\s+/).length > 6 || RULE_WORDS.test(name);
      const isHeader = !isSubRule && name.length >= 2 && name.length <= MAX_NAME && !LEVEL_WORDS.test(name) && pts > 0 && pts <= MAX_POINTS;
      if (isHeader) { pushScored(name, pts, lineNo); return; }
    }

    // ── 번호만 붙은 짧은 제목: “1. 주장” (감점식 항목 후보) ──
    const h = !inNotes && line.match(NUM_HEAD_RE);
    if (h && !SCORE_RE.test(line)) {
      const name = cleanName(line);
      if (name.length >= 1 && name.length <= 25 && name.split(/\s+/).length <= 5 && !/[.。]$|(다|요|함|음|것)$/.test(name) && !RULE_WORDS.test(name)) {
        current = { name: uniq(heads, name), points: null, desc: '', line: lineNo, deductions: [] };
        heads.push(current);
        return;
      }
    }
    if (current) current.desc = (current.desc ? `${current.desc}\n` : '') + line;
  });

  if (!text.trim()) errors.push({ line: 0, msg: '채점 기준이 비어 있어요. AI에게 설명하듯 자유롭게 적어 주세요.' });

  let items;
  let mode = 'add';
  let assumed = false;
  if (deductCount > 0) {
    mode = 'deduct';
    items = heads.filter((it) => it.deductions.length || it.points != null);
    if (orphanDeductions.length) items.push({ name: uniq(items, '기타 감점'), points: null, desc: '', line: 0, deductions: orphanDeductions });
    if (maxScore == null) {
      const sum = items.reduce((s, it) => s + (it.points || 0), 0);
      if (items.length && items.every((it) => it.points != null)) maxScore = sum;
      else {
        maxScore = 100; assumed = true;
        warnings.push('감점식 기준인데 만점을 찾지 못해 100점에서 감점해요. “만점 : 80점”처럼 적어 주세요.');
      }
    }
  } else {
    items = scored;
    if (!items.length && text.trim()) {
      items = [{ name: '종합 점수', points: 100, desc: text.trim(), line: 0, deductions: [] }];
      assumed = true;
      warnings.push('배점(예: “30점”)이나 감점(예: “-4점”)을 찾지 못해 100점 만점 한 항목으로 채점해요. “1. 항목 이름 : 30점”처럼 적어 주세요.');
    }
    const sum = Math.round(items.reduce((s, it) => s + it.points, 0) * 100) / 100;
    if (mentionedTotal != null && !assumed && Math.abs(mentionedTotal - sum) > 0.001) {
      warnings.push(`글에 적힌 총점(${mentionedTotal}점)과 항목 배점의 합(${sum}점)이 달라요. 확인해 주세요.`);
    }
    maxScore = sum;
  }
  if (items.length > MAX_ITEMS) {
    warnings.push(`항목이 ${items.length}개라 앞의 ${MAX_ITEMS}개만 결과표 열로 써요.`);
    items.length = MAX_ITEMS;
  }
  if (floor != null && floor > maxScore) { warnings.push(`최저점(${floor}점)이 만점(${maxScore}점)보다 커요. 확인해 주세요.`); }
  const rubric = { mode, max: maxScore, floor, blank };
  return {
    items: items.map(({ name, points, desc, line, deductions }) => ({ name, points: points ?? 0, desc: desc.trim(), line, deductions })),
    rubric, errors, warnings, total: maxScore, assumed, ok: errors.length === 0,
  };
}

// 항목 점수로 총점 계산 (감점식: 만점 + 감점 합(음수), 최저점 적용)
export function computeTotal(rubric, values) {
  const r = rubric || { mode: 'add' };
  if (values.some((v) => v == null || Number.isNaN(v))) return null;
  let t = r.mode === 'deduct' ? r.max + values.reduce((s, v) => s + Math.min(0, v), 0) : values.reduce((s, v) => s + v, 0);
  if (r.mode === 'deduct') t = Math.min(r.max, t);
  if (r.floor != null) t = Math.max(r.floor, t);
  return Math.max(0, Math.round(t * 2) / 2);
}

export const defaultRubric = (items) => ({ mode: 'add', max: items.reduce((s, c) => s + (c.points || 0), 0), floor: null, blank: null });

// 저장된 기준이 바뀌었는지 판단할 때 쓰는 지문
export function criteriaSignature(items) {
  return items.map((it) => `${it.name}\u0001${it.points}\u0001${it.desc}`).join('\u0002');
}
