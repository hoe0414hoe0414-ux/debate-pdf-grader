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
   - `layout`이 `duplex`(양면)면 2쪽 = 학생 1명(앞면에만 학번·이름), `simplex`(단면)면 1쪽 = 학생 1명.
   - `layout`이 비어 있으면 직접 판단한다. `studentsHint`가 있으면 참고하되, 틀리면 바로잡는다.
4. 학생마다:
   - **학번**: `idRule`을 따른다(예: 5자리 20301 = 2학년 03반 01번). “2학년 3반 1번”처럼 쓰여 있으면 학번으로 바꾼다.
   - **이름**: 글자가 불명확하면 가장 비슷한 글자로 적는다.
   - **점수**: 그 영역의 `criteriaText`(선생님 기준 전문)와 `gradingPrompt`를 그대로 따른다. `items[].name`과 **똑같은 이름**으로 항목별 점수를 적는다.
     - `rubric.mode`가 `deduct`(감점식)이면 항목 점수 = 그 항목에서 감점한 합계를 **음수**로(감점 없으면 0). 총점 = `rubric.max` + 감점 합계, `rubric.floor`보다 낮으면 `rubric.floor`.
     - `add`(배점식)이면 항목 점수 = 0 ~ 배점.
     - `comment`에 어떤 규칙을 왜 적용했는지 짧게 근거를 적는다(예: “주장2 누락 −4”).
   - 글씨를 알아볼 수 없어 판독이 불가하면 `status: "unreadable"`(결과표에 ‘채점 불가’로 표시). 백지면 `status: "blank"`(총점 = `rubric.blank`).
5. 모두 끝나면 같은 폴더에 `result.json`을 쓰고(아래 양식), `status.json`을 `{"state":"done"}`으로 고친다.
6. 학생 개인정보가 담긴 PDF와 결과를 이 폴더 밖이나 인터넷으로 보내지 않는다. PDF는 고치지 않는다.

## result.json 양식 (version 1)

```json
{
  "format": "debate-pdf-grader-result",
  "version": 1,
  "requestId": "request.json의 requestId 그대로",
  "gradedAt": "2026-11-24T12:00:00+09:00",
  "grader": "Claude",
  "files": [
    {
      "fileId": "request.json의 fileId 그대로",
      "name": "request.json의 name 그대로",
      "section": "request.json의 section 그대로",
      "sectionId": "request.json의 sectionId 그대로",
      "pages": 6,
      "layout": "duplex",
      "students": [
        {
          "pages": [1, 2],
          "studentId": "20301",
          "name": "김토론",
          "status": "ok",
          "scores": [ { "name": "주장", "score": -4, "comment": "주장2 누락" } ],
          "total": 96,
          "comment": "전체 평 (선택)"
        }
      ]
    }
  ]
}
```

- `status`: `ok` | `unreadable` | `blank`
- `total`은 참고용입니다. 프로그램이 항목 점수와 기준(만점·최저점)으로 다시 계산합니다.
- 예시: [`examples/result.example.json`](examples/result.example.json)

## Claude 채팅으로 할 때

선생님이 이 폴더(또는 zip)를 주며 “채점해줘”라고 하면 위 절차대로 하고, 결과를 `result.json`으로 저장하거나 파일로 건넵니다. 선생님은 프로그램의 **결과 파일 불러오기**로 읽어 들입니다.
