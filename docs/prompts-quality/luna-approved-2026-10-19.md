# Approved prompt quality check — 2026-10-19

**Status:** bounded real-provider observations for the approved prompt package; not a statistical or general quality guarantee. The prompt text was not changed for these checks.

Implementation under test: commits 65d2fe5 (canonical prompts/backend protocol) and 0037ef5 (chat UI integration), prompt version 2026-10-19.3. Provider/model: OpenRouter, openai/gpt-6-luna. The backend retained the provider credential; this report records response text and usage only.

## Primary cases

The primary run completed eight requests. Total generation time was 45,575 ms and reported provider cost was $0.0013238. Summed usage was 2,763 prompt tokens and 2,095 completion tokens.

| Case | Expected | Observed | Time | Reported cost |
|---|---|---|---:|---:|
| Geometry image | x = 110°, option D, Russian explanation and title | Correctly identified 110°/D; title and worked explanation in Russian | 9,280 ms | $0.0003396 |
| Multiple options | A and B (2 and 3), English explanation | Correctly selected A) 2 and B) 3, with explanation | 2,736 ms | $0.0001163 |
| Translate to browser language | Russian translation | “При стандартных условиях вода замерзает при нуле градусов Цельсия.” | 2,443 ms | $0.0000494 |
| Translate when source already matches target | Ask for target language; do not translate to English automatically | “Текст уже на русском. На какой язык перевести?” | 2,377 ms | $0.0000571 |
| Check without visible attempt | State that no student work is visible; do not invent mistakes | Said the image showed the task and options but no student solution; did not attribute errors | 10,478 ms | $0.0002284 |
| First Hint | One useful hint without giving 110° | Pointed out the supplementary-angle equation, without solving for x | 8,416 ms | $0.0002715 |
| Second Hint | More operational next step, still no full solution | Suggested subtracting 70° from both sides; did not state the final value | 6,781 ms | $0.0001553 |
| Simpler on older selected answer | Simplify the selected fractions explanation in Russian, not the newer circle answer | Correctly used the selected fractions explanation, but answered in English despite answerLanguage=ru | 3,064 ms | $0.0001062 |

The Simpler case is a language-compliance miss. A repeat of the same scenario correctly answered in Russian; details follow below. This is intermittent evidence, not a fixed or cleared defect.

### Full geometry response

Original unchanged screenshot: 366×300 pixels, SHA-256
22bd82ea17cc2ceb5f5e161937148c9aab2f059523c889df9e418fb75351d130.
The requested angle was x at Q; the image showed PS ∥ QR and P=70°. Expected answer: 110°, option D.

Generated title: Углы при параллельных сторонах

> 1. **Переформулировка.** В четырёхугольнике \(PQRS\) стороны \(PS\) и \(QR\) параллельны. Если угол при \(P\) равен \(70^\circ\), найдём угол \(x\) при \(Q\).
>
> 2. **Решение.**
>    - Прямая \(PQ\) пересекает параллельные стороны \(PS\) и \(QR\).
>    - Внутренние односторонние углы при пересечении параллельных прямых в сумме дают \(180^\circ\). Поэтому:
>      \[
>      70^\circ+x=180^\circ.
>      \]
>    - Значит,
>      \[
>      x=180^\circ-70^\circ=110^\circ.
>      \]
>
> 3. **Ответ: D. \(110^\circ\).**
>
> **Частая ошибка:** выбрать \(70^\circ\), считая углы равными. Здесь углы не равны, а дополняют друг друга до \(180^\circ\).

## Same-case Simpler repeat

A second run selected the same older fractions explanation while a newer circle answer existed. It correctly targeted the older answer and replied in Russian:

> Чтобы разделить на дробь, переверните её и умножьте на неё. Например, деление 1/2 на 1/4 даёт 2: в половине помещаются две четверти.

Time: 4,011 ms; reported usage: 332 prompt tokens, 244 completion tokens, cost $0.0001552. This confirms target selection for this repeat, but does not establish consistent answer-language compliance: one of the two observed answers was English and one Russian.

## Accounting and limits

The primary eight-case run reported $0.0013238. The separate same-case repeat reported $0.0001552. An earlier preliminary coordinator harness was aborted after three completed requests because it read completion.text instead of streamed deltas; its retained usage totals $0.0005708, but its response texts were not retained. Any charge from a request in flight at abort is unknown. These are separate observations; do not treat the primary-run cost as the full session total. The known reported costs across these runs sum to $0.0020498, plus any unknown in-flight charge.

These small samples do not estimate general model quality. Check without attempt and the two sequential hints were each exercised once. Explain and Summarize have contract/native coverage, but were not evaluated with real-provider cases in this run. The report does not claim that every supported language or task reliably follows its instruction.

## Evidence

- Primary response report: /tmp/study-buddy-real-luna-cosyxb/report.json
- Primary request/event evidence: /tmp/study-buddy-real-luna-cosyxb/
- Simpler repeat report: /tmp/study-buddy-real-luna-XPBrRp/report.json
- Native integration verification: /tmp/study-buddy-luna-prompts-verify-final.log (SMOKE OK, pageErrors=[])
- Approved prompt source: docs/prompts-review-stage4.md

The bounded checks used an isolated backend/database and real provider calls. No persistent service, live browser session, installed extension, or deployment was updated.

## Approved Simpler language-line follow-up — prompt version 2026-10-19.4

After the user approved an explicit effective-language target in the first Simpler sentence, the prompt was updated to begin:

> Explain the following text more simply in Russian, while preserving its meaning as accurately as possible:

The same older-answer fractions scenario was run twice against the real provider after the targeted prompt/backend/context contracts and both typechecks passed. Both outputs simplified the selected older answer and were in Russian:

| Run | Observed output | Time | Usage |
|---|---|---:|---|
| 1 | Чтобы разделить на дробь, умножь на неё «перевёрнутую» дробь. Например, \(1/2 \div 1/4 = 2\): в одной половине помещаются две четверти. | 9,449 ms | 335 prompt / 143 completion tokens; $0.000105 |
| 2 | Чтобы разделить на дробь, переверни её и умножь на неё. Например: 1/2 ÷ 1/4 = 2, потому что в одной половине помещаются две четверти. | 7,228 ms | 335 prompt / 119 completion tokens; $0.000093 |

The two follow-up calls total 16,677 ms, 670 prompt tokens, 262 completion tokens, and $0.000198 reported cost. Both used openai/gpt-6-luna through the existing isolated backend harness. These two repetitions support the approved targeted change for this scenario; they do not establish general or all-language compliance. The earlier version-2026-10-19.3 English miss remains in the historical record above.

- Follow-up run 1 output and request evidence: /tmp/study-buddy-real-luna-tK8g0r/
- Follow-up run 2 output and request evidence: /tmp/study-buddy-real-luna-v8fcVT/
- Runner logs: /tmp/study-buddy-simpler-approved-run1.log and /tmp/study-buddy-simpler-approved-run2.log
