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

function cleanName(s) {
  return s.replace(LEAD_RE, '').replace(/[\s:：\-–—~(\[（【,]+$/g, '').replace(/^[\s:：\-–—]+/, '').replace(/\*\*/g, '').trim();
}

export function parseCriteria(src) {
  const text = String(src ?? '').replace(/\r\n?/g, '\n').replace(/[​-‍﻿]/g, '');
  const lines = text.split('\n');
  const errors = [];
  const warnings = [];
  const items = [];
  let current = null;
  let mentionedTotal = null;

  const pushItem = (name, points, lineNo) => {
    let n = name.slice(0, MAX_NAME);
    let k = 2;
    while (items.some((it) => it.name === n)) n = `${name.slice(0, MAX_NAME - 4)} (${k++})`;
    current = { name: n, points, desc: '', line: lineNo };
    items.push(current);
  };

  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const line = raw.trim();
    if (!line) return;

    // 예전 형식: 항목명 | 배점 | 설명
    if (/[|｜]/.test(line) && !line.startsWith('#')) {
      const [name, pts, ...rest] = line.split(/[|｜]/).map((x) => x.trim());
      const num = Number(String(pts || '').replace(/\s|점/g, ''));
      if (name && num > 0 && num <= MAX_POINTS) { pushItem(cleanName(name) || name, num, lineNo); current.desc = rest.join(' | ').trim(); return; }
    }

    const m = line.match(SCORE_RE);
    if (m) {
      const before = line.slice(0, m.index);
      const name = cleanName(before);
      const pts = Number(m[1]);
      if (TOTAL_WORDS.test(name.replace(/\s/g, '')) || /^(총점|합계)/.test(name)) { mentionedTotal = pts; return; }
      // 항목 아래의 세부 규칙(예: “- 근거 3개 이상이면 10점”, “상 : 30점”)은 설명으로 둔다
      const isSubRule = (current && /^[-*•·▶▷]/.test(line)) || /(하면|이면|되면|으면|쓰면|있으면|없으면|경우|때|마다)$/.test(name) || name.split(/\s+/).length > 6;
      const isHeader = !isSubRule && name.length >= 2 && name.length <= MAX_NAME && !LEVEL_WORDS.test(name) && pts > 0 && pts <= MAX_POINTS;
      if (isHeader) { pushItem(name, pts, lineNo); return; }
    }
    // 제목(##)은 새 구역 → 앞 항목의 설명을 끝냄
    if (/^#{1,6}(\s|$)/.test(line)) { current = null; return; }
    if (current) current.desc = (current.desc ? `${current.desc}\n` : '') + line;
  });

  if (!text.trim()) errors.push({ line: 0, msg: '채점 기준이 비어 있어요. AI에게 설명하듯 자유롭게 적어 주세요.' });

  let assumed = false;
  if (!items.length && text.trim()) {
    items.push({ name: '종합 점수', points: 100, desc: text.trim(), line: 0 });
    assumed = true;
    warnings.push('배점(예: “30점”)을 찾지 못해 100점 만점 한 항목으로 채점해요. 항목별 점수를 보려면 “1. 항목 이름 : 30점”처럼 적어 주세요.');
  }
  if (items.length > MAX_ITEMS) {
    warnings.push(`배점이 붙은 줄이 ${items.length}개라 앞의 ${MAX_ITEMS}개만 결과표 열로 써요.`);
    items.length = MAX_ITEMS;
  }
  const total = Math.round(items.reduce((s, it) => s + it.points, 0) * 100) / 100;
  if (mentionedTotal != null && !assumed && Math.abs(mentionedTotal - total) > 0.001) {
    warnings.push(`글에 적힌 총점(${mentionedTotal}점)과 항목 배점의 합(${total}점)이 달라요. 확인해 주세요.`);
  }
  return { items: items.map(({ name, points, desc, line }) => ({ name, points, desc: desc.trim(), line })), errors, warnings, total, assumed, ok: errors.length === 0 };
}

// 저장된 기준이 바뀌었는지 판단할 때 쓰는 지문
export function criteriaSignature(items) {
  return items.map((it) => `${it.name}\u0001${it.points}\u0001${it.desc}`).join('\u0002');
}
