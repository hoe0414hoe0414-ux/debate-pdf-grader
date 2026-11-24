// 채점 기준 파서. 프로그램의 핵심 입력이므로 모든 오류를 줄 번호와 함께 알려 준다.
// 형식: 항목명 | 배점 | 설명(선택)   ·   '#'으로 시작하는 줄은 메모

export const MAX_ITEMS = 30;
const MAX_NAME = 40;
const MAX_POINTS = 1000;

export const EXAMPLE_CRITERIA = [
  '# 예시입니다. 학교 기준에 맞게 고쳐 쓰세요.',
  '주장의 명확성 | 30 | 자신의 입장(찬성/반대)이 분명하게 드러나는가',
  '근거의 타당성 | 40 | 통계, 사례, 전문가 의견 등 근거가 주장을 충분히 뒷받침하는가',
  '반론 대응 | 30 | 예상되는 반론을 언급하고 논리적으로 반박하는가',
].join('\n');

export function parseCriteria(src) {
  const items = [];
  const errors = [];
  const warnings = [];
  const seen = new Map();
  const text = String(src ?? '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');

  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const line = raw.replace(/[​-‍﻿]/g, '').trim();
    if (!line || line.startsWith('#')) return;

    const parts = line.split(/[|｜]/).map((s) => s.trim());
    if (parts.length < 2) {
      errors.push({ line: lineNo, msg: `${lineNo}번째 줄: ‘|’로 항목명과 배점을 나눠 주세요. (예: 주장의 명확성 | 30 | 설명)` });
      return;
    }
    const [name, pointsRaw, ...rest] = parts;
    const desc = rest.join(' | ').trim();

    if (!name) {
      errors.push({ line: lineNo, msg: `${lineNo}번째 줄: 항목명이 비어 있어요.` });
      return;
    }
    if (name.length > MAX_NAME) {
      errors.push({ line: lineNo, msg: `${lineNo}번째 줄: 항목명은 ${MAX_NAME}자 이내로 줄여 주세요.` });
      return;
    }
    const cleaned = pointsRaw.replace(/\s|점/g, '');
    if (!/^\d+(\.\d+)?$/.test(cleaned)) {
      errors.push({ line: lineNo, msg: `${lineNo}번째 줄: 배점 ‘${pointsRaw || '(비어 있음)'}’은 숫자가 아니에요. (예: 30)` });
      return;
    }
    const points = Number(cleaned);
    if (!(points > 0) || points > MAX_POINTS) {
      errors.push({ line: lineNo, msg: `${lineNo}번째 줄: 배점은 0보다 크고 ${MAX_POINTS} 이하여야 해요.` });
      return;
    }
    const key = name.replace(/\s+/g, '').toLowerCase();
    if (seen.has(key)) {
      errors.push({ line: lineNo, msg: `${lineNo}번째 줄: ‘${name}’ 항목이 ${seen.get(key)}번째 줄과 겹쳐요.` });
      return;
    }
    seen.set(key, lineNo);
    if (!desc) warnings.push(`${lineNo}번째 줄: 설명이 없어요. 설명이 있으면 AI가 더 정확하게 채점해요.`);
    items.push({ name, points, desc, line: lineNo });
  });

  if (!items.length && !errors.length) errors.push({ line: 0, msg: '채점 항목이 하나도 없어요. 한 줄 이상 입력해 주세요.' });
  if (items.length > MAX_ITEMS) errors.push({ line: 0, msg: `항목은 최대 ${MAX_ITEMS}개까지 쓸 수 있어요. (지금 ${items.length}개)` });

  const total = Math.round(items.reduce((s, it) => s + it.points, 0) * 100) / 100;
  return { items, errors, warnings, total, ok: errors.length === 0 };
}

// 저장된 기준이 바뀌었는지 판단할 때 쓰는 지문
export function criteriaSignature(items) {
  return items.map((it) => `${it.name}\u0001${it.points}\u0001${it.desc}`).join('\u0002');
}
