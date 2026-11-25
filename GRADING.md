# Claude 채점 지침 (토론 PDF 채점 판독기)

이 폴더는 ‘토론 PDF 채점 판독기’가 만든 **채점 요청**입니다. API를 쓰지 않고 Claude(Claude Code 또는 Claude 채팅)가 직접 채점합니다.
선생님이 적은 채점 기준을 **한 글자도 바꾸지 말고 그대로** 따르세요.

## 폴더 구성

```
request.json          요청 내용 (영역별 채점 기준, 파일 목록)
GRADING.md            이 지침
pdf/<영역 이름>/*.pdf  학생 답안지 (파일 1개 = 학급 1개, 손글씨 스캔본이 많음)
status.json           (Claude가 씀) 진행 상황
result.json           (Claude가 씀) 채점 결과 ← 프로그램이 이 파일을 읽어 결과표를 만듦
```

## 절차

1. `request.json`을 읽는다. `files[]`의 각 항목은 `section`(영역 이름)에 해당하는 `sections[]`의 기준으로 채점한다. 영역마다 기준이 다르니 섞지 않는다.
2. 시작할 때 `status.json`에 `{"state":"grading","done":0,"total":<학생 수 추정 또는 파일 수>,"message":"시작"}`를 쓰고, 학급(파일) 하나를 끝낼 때마다 `done`과 `message`를 고친다.
3. 각 PDF를 쪽별로 본다(Read 도구로 PDF를 직접 읽거나, 쪽을 이미지로 바꿔 본다). 학생 나누기:
   - 한 학생의 답안지는 **같은 양식이 몇 쪽마다 반복되는지**로 나눈다. 전체 쪽수 = 학생 수가 아니다.
   - `pagesPerStudent`가 있으면 그 쪽수만큼 묶는다(2 = 양면, 1 = 단면, 3 이상 = 여러 쪽 세트). `studentsHint`는 프로그램이 미리 나눈 쪽 번호다.
   - 둘 다 참고용이다. 실제로 보니 다르면(예: 앞면 학번 칸이 2쪽이 아니라 3쪽마다 나옴) 바로잡고, 결과의 `pages`에 실제 쪽 번호를 적는다.
4. 학생마다:
   - **학번·이름은 반드시 답안지에서 읽어 적는다.** 보통 첫 쪽 위쪽 학번·이름 칸에 있다. 비워 두면 결과표에 ‘판독 전’으로 남는다.
     - 학번은 `idRule`을 따른다(예: 5자리 20301 = 2학년 03반 01번). “2학년 3반 1번”처럼 쓰여 있으면 학번으로 바꾼다.
     - 이름 글자가 불명확하면 가장 비슷한 글자로 적는다. 학번만 보이면 학번만 적는다.
   - **점수**: 그 영역의 `criteriaText`(선생님 기준 전문)와 `gradingPrompt`를 그대로 따른다. `items[].name`과 **똑같은 이름**으로 항목별 점수를 적는다.
     - `rubric.mode`가 `deduct`(감점식)이면 항목 점수 = 그 항목에서 감점한 합계를 **음수**로(감점 없으면 0). 총점 = `rubric.max` + 감점 합계, `rubric.floor`보다 낮으면 `rubric.floor`.
     - `add`(배점식)이면 항목 점수 = 0 ~ 배점.
   - **감점 근거는 짧은 키워드로**: 기준 문장을 통째로 옮기지 않는다. `deductions`에 적용한 규칙마다 `{"keyword": "주장 누락", "points": -2}`처럼 2~8글자 핵심어와 점수를 적는다. `items[].deductions[].keyword`에 제안 키워드가 있으면 그것을 쓴다.
       - 예: 기준 “찬성 또는 반대 의견이 누락되어 있는 경우(-2점)” → `주장 누락`
     - 필요하면 `comment`에 한 줄로 구체 사정을 덧붙인다(예: “주장2 출처 없음”).
   - **학생 답안**: 항목마다 `answer`에 그 항목에 해당하는 학생 답을 옮겨 적는다. 마크다운으로 정리한다(줄글로 이어 붙이지 않기): 여러 개면 `- ` 목록이나 `1. ` 번호, 핵심 표현은 `**굵게**`, 인용은 `> `. 알아보기 힘든 글자는 `[?]`.
   - 글씨를 알아볼 수 없어 판독이 불가하면 `status: "unreadable"`(결과표에 ‘채점 불가’로 표시). 백지면 `status: "blank"`(총점 = `rubric.blank`).
5. 모두 끝나면 같은 폴더에 `result.json`을 쓰고(아래 양식), `status.json`을 `{"state":"done"}`으로 고친다.
6. 학생 개인정보가 담긴 PDF와 결과를 이 폴더 밖이나 인터넷으로 보내지 않는다. PDF는 고치지 않는다.

## result.json 양식 (version 2)

```json
{
  "format": "debate-pdf-grader-result",
  "version": 2,
  "requestId": "request.json의 requestId 그대로",
  "gradedAt": "2026-11-25T12:00:00+09:00",
  "grader": "Claude",
  "files": [
    {
      "fileId": "request.json의 fileId 그대로",
      "name": "request.json의 name 그대로",
      "section": "request.json의 section 그대로",
      "sectionId": "request.json의 sectionId 그대로",
      "pages": 54,
      "layout": "duplex",
      "students": [
        {
          "pages": [1, 2],
          "studentId": "10101",
          "name": "김토론",
          "status": "ok",
          "scores": [
            {
              "name": "나의 주장",
              "score": -2,
              "deductions": [ { "keyword": "주장 누락", "points": -2 } ],
              "comment": "",
              "answer": "- 입장: (표시 없음)\n- 원자력 발전은 필요하다"
            }
          ],
          "total": 98,
          "comment": "전체 평 (선택)"
        }
      ]
    }
  ]
}
```

- `status`: `ok` | `unreadable` | `blank`
- `layout`: `duplex`(2쪽=1명) | `simplex`(1쪽=1명) | `set`(3쪽 이상 세트 — 학생마다 `pages`로 구분)
- `total`은 참고용입니다. 프로그램이 항목 점수와 기준(만점·최저점)으로 다시 계산합니다.
- 버전 1 결과(`deductions`·`answer` 없음)도 계속 읽을 수 있습니다.
- 예시: [`examples/result.example.json`](examples/result.example.json)

## Claude 채팅으로 할 때

선생님이 이 폴더(또는 zip)를 주며 “채점해줘”라고 하면 위 절차대로 하고, 결과를 `result.json`으로 저장하거나 파일로 건넵니다. 선생님은 프로그램의 **결과 파일 불러오기**로 읽어 들입니다.
