# 작업 규칙 (토론 PDF 채점 판독기)

- 순수 HTML/CSS/JS(ES 모듈), 빌드 도구 없음. GitHub Pages로 배포(main 브랜치).
- API 키·비밀값은 이 공개 저장소에 절대 넣지 않는다. 학생 PDF는 브라우저 안에서만 처리한다.
- 앱 파일을 바꾸면 `index.html`과 `app.js`의 `?v=N` 버전 쿼리를 함께 올린다(캐시 갱신).

## 설정 파일 내보내기/불러오기 양식 (반드시 함께 수정)

설정 화면의 ‘설정 내보내기 / 설정 불러오기’는 `app.js`의 `toSettingsFile()` / `fromSettingsFile()`이 담당한다.
**설정 항목(학번 자릿수, 평가 영역의 이름·채점 기준·양면/단면·판독 참고 사항 등)을 추가·변경·삭제할 때마다:**

1. `SETTINGS_FILE_VERSION`을 1 올린다.
2. `toSettingsFile()`에 새 항목을 넣는다.
3. `fromSettingsFile()`에서 새 항목을 읽되, 예전 버전 파일에 그 항목이 없으면 기본값을 쓴다. 예전 파일은 계속 불러올 수 있어야 한다.
4. 아래 표와 README의 ‘설정 파일’ 절을 고친다.

| 버전 | 내용 |
|---|---|
| 1 | `format`, `version`, `exportedAt`, `idDigits`(4/5), `sections[]` = `{name, criteriaText, criteriaDraft?, layoutDefault(auto/duplex/simplex), notes}`. 영역 탭 이전 형식(`{idDigits, criteriaText, notes}`)도 ‘평가 1’로 불러옴. |
| 2 | v1 + `sections[].keywords`(파일 이름 키워드, 쉼표 구분 문자열 — 업로드 PDF를 영역에 자동 분류. 예: `1차시, 입론`). v1 파일은 빈 값. |

참고: 결과표 항목·채점 방식(배점식/감점식, 만점, 최저점, 백지 점수)은 `criteriaText`에서 매번 다시 해석하므로 설정 파일에 따로 저장하지 않는다. 결과표에서 직접 고친 점수는 채점 결과(브라우저 메모리)이며 설정 파일에 들어가지 않는다.

## Claude 채점 요청/결과 양식 (반드시 함께 수정)

API 키 없이 Claude(구독)가 채점한다. 앱이 요청(`request.json` + PDF)을 만들고 Claude가 `GRADING.md` 대로 `result.json`을 쓴다. 코드는 `bridge.js`(양식·zip·폴더)와 `app.js`의 `buildRequest()` / `importResult()`.
요청·결과 항목을 바꾸면 `REQUEST_VERSION` / `RESULT_VERSION`을 올리고, `normalizeResult()`가 예전 결과 파일도 읽게 하며, `GRADING.md`, `examples/result.example.json`, 아래 표를 함께 고친다.

| 양식 | 버전 | 내용 |
|---|---|---|
| 요청 | 1 | `format`, `version`, `requestId`, `createdAt`, `idDigits`, `idRule`, `sections[]`={id,name,criteriaText,notes,layoutDefault,rubric,items[],gradingPrompt}, `files[]`={fileId,name,path,section,sectionId,layout,pages,studentsHint} |
| 요청 | 2 | v1 + `items[].deductions[].keyword`(감점 규칙의 짧은 키워드 제안), `files[].pagesPerStudent`(프로그램이 찾은 한 학생의 쪽수), `files[].layout`에 `set`(3쪽 이상 세트) 가능 |
| 결과 | 1 | `format`, `version`, `requestId`, `gradedAt`, `grader`, `files[]`={fileId,name,section,sectionId,pages,layout,students[]={pages,studentId,name,status(ok/unreadable/blank),scores[]={name,score,comment},total,comment}} |
| 결과 | 2 | v1 + `scores[].deductions[]`={keyword,points}(감점 핵심 키워드), `scores[].answer`(그 항목에 학생이 쓴 답, 마크다운), `students[].answer`(답안 전체, 선택). v1 파일은 빈 값으로 읽음. |

채점 폴더 구조: `<연결 폴더>/채점요청/<requestId>/{request.json, GRADING.md, pdf/…, status.json, result.json}`, 도우미 신호 `채점요청/helper.json`. 도우미: `helper/grading-helper.ps1`(+`start-helper.bat`, 폴더 연결 시 자동 복사)이 `claude -p`로 채점.
