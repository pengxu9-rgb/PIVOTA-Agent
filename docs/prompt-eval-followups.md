# Prompt Evaluation – Follow-ups & Continuity

This document is a lightweight manual test suite to verify that the agent:
- Preserves the user’s primary goal across follow-ups
- Treats follow-ups as refinements (not new tasks)
- Handles meta templates safely (asks to confirm goal switch)
- Responds in the user’s language (EN/FR/JA/ES)

## How to use

- Run each scenario as a multi-turn chat.
- Check the “Expected” section for pass/fail criteria.
- If a scenario requires shopping data, the agent should call `pivota_shopping_tool` rather than inventing results.

---

## Scenario 1 (EN) – Follow-up refinement stays on goal

**User (turn 1):** “Next week I’m recreating a Ningning-inspired makeup look. Can you recommend brushes that match that style?”

**Assistant (turn 1):** Asks 1–2 clarifying questions (e.g. budget, what base products the user uses), then recommends brush types and a compact set.

**User (turn 2):** “I usually use cushion foundation and pressed powder.”

**Expected**
- Continues refining the original “Ningning-inspired makeup look + brushes” goal.
- Does not reset into a generic shopping intake form unless the user asked.
- Uses the new constraint (cushion/pressed powder) to adjust brush types (e.g. base, powder, blending).

---

## Scenario 2 (JA) – Clarification answers do not trigger a restart

**User (turn 1):** 「来週、特定のアイドル風メイクを描くので、そのメイクに合うブラシをおすすめして。」

**Assistant (turn 1):** 1–2個だけ確認（予算、普段のベース等）→ 続けて提案。

**User (turn 2):** 「予算は1万円くらい。普段はクッションファンデ。」

**Expected**
- 日本語で回答し続ける。
- 既に聞いた内容を繰り返し続けない。
- “同じ目的の続き”として提案を具体化する。

---

## Scenario 3 (ES) – Constraint update, same mission

**User (turn 1):** “Busco una chaqueta minimalista para ir al trabajo, menos de 120€.”

**Assistant (turn 1):** Calls tool (or asks 1–2 clarifiers if missing shipping country), shows a short list.

**User (turn 2):** “Mejor si es impermeable y sube el presupuesto a 160€.”

**Expected**
- Sigue en español.
- Trata el turno 2 como refinamiento (impermeable + nuevo presupuesto), vuelve a buscar/filtrar.

---

## Scenario 4 (FR) – Tiered output only when asked

**User (turn 1):** “Je veux une routine simple: 3 pinceaux maximum pour un teint propre au quotidien.”

**Assistant (turn 1):** Proposes up to 3 brush types and explains what each one does.

**User (turn 2):** “Tu peux aussi me faire 3 niveaux: débutant / bureau / avancé ?”

**Expected**
- Répond en français.
- Produit bien une sortie en 3 niveaux (le user l’a demandé).
- Reste cohérent avec l’objectif “teint propre au quotidien”.

---

## Scenario 5 (EN) – User pastes a meta template (goal-switch check)

**User (turn 1):** “Help me pick skincare for oily skin under $50.”

**Assistant (turn 1):** Asks 1–2 clarifiers, then proceeds (tool if needed).

**User (turn 2):** Pastes a rubric/template for A/B/C tiers and intake questions, without explicitly saying they want to change tasks.

**Expected**
- Does not silently switch into “designing a rubric”.
- Restates current goal in 1 sentence and asks:
  - “Do you want to switch to designing a framework, or continue refining your skincare picks?”
- If the user says “continue”, the agent proceeds with skincare picks using the new constraints.

---

## Scenario 6 (Mixed languages) – Choose dominant language or ask

**User (turn 1):** “Quiero una mochila para laptop. Budget $80. 日本でも買えると嬉しい。”

**Expected**
- Responds in Spanish (dominant) or asks which language to use if genuinely unclear.
- Keeps the same mission; uses constraints (laptop, $80, availability in Japan).

---

## Scenario 7 (Explicit goal change) – Clean reset when user asks

**User (turn 1):** “Find running shoes under $100.”

**User (turn 2):** “Ignore that. Now I need a phone case for iPhone 15.”

**Expected**
- Acknowledges goal change and resets constraints accordingly.
- Does not keep applying old constraints from the previous mission.

---

## Scenario 8 (Tool grounding) – No fabricated catalog facts

**User (turn 1):** “Show me 5 options and their exact prices and delivery dates.”

**Expected**
- Calls `pivota_shopping_tool` (or asks 1–2 clarifiers required to search).
- Does not invent prices/ETAs.

