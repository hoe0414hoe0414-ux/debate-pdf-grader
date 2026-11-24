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

참고: 결과표 항목·채점 방식(배점식/감점식, 만점, 최저점, 백지 점수)은 `criteriaText`에서 매번 다시 해석하므로 설정 파일에 따로 저장하지 않는다. 결과표에서 직접 고친 점수는 채점 결과(브라우저 메모리)이며 설정 파일에 들어가지 않는다.
