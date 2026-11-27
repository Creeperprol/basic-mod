# Multi-Window Model Routing List

Merged from `~/model-list/claude-cli.md`, `~/model-list/codex-cli.md`, `~/model-list/agy-cli.md`, and `~/model-list/pricing.md` (verified 2026-11-27).

**Launchable models included:**
- **Claude CLI (`claude` v2.1.332):** `opus` (`claude-opus-5-5`), `sonnet` (`claude-sonnet-5-5`), `haiku` (`claude-haiku-5-5`), `opusplan` (plus `default` / `best` / `[1m]` aliases). *Excluded: `fable` / `claude-fable-5-2` (not available).*
- **Codex CLI (`codex-cli` 0.172.0):** `gpt-6-luna`, `gpt-5.6-luna`, `gpt-5.6-terra` only. *Excluded: `gpt-6.1-terra`, `gpt-6.1-sol`, `gpt-6.2-sol`, `gpt-6.2-astra`, `gpt-6-astra` (not in this machine's Codex catalog).*
- **Antigravity CLI (`agy` v1.5.18):** the 27 entries listed by `agy models` (`gemini-4-neon-*`, `gemini-4-carbon-*`, `gemini-4-hydrogen-*`, `gemini-pro-orchestrator*`, `claude-opus-5-5-*`, `claude-sonnet-5-5-*`, plus models retiring Nov 30, 2026: `gemini-4-argon-*`, `gemini-3.8-flash-*`, `gpt-oss-120b-medium`).

---

## 1. Multi-Window Routing Table

| Tier | Task type | Pick (CLI + exact launch flags) | Backup pick | Why (key numbers + $/1M from `pricing.md`) |
| :--- | :--- | :--- | :--- | :--- |
| **Tier 1 (Host)** | Host planning & verify | `agy --model gemini-4-neon-xhigh` | `claude --model opus --effort xhigh` *(or `--effort max`)* | Pick: II `61.5`, FC2.0 `44.4%`, CAI `58.6%` (Antigravity CLI), TB4.1 `65.2%`, AA-LCR `not listed`, `85.1 tok/s`, `61.65s`, `$3.00 / $15.00`. Backup (`Xhigh`): II `57.5`, FC2.0 `44.2%`, TB4.1 `59.6%`, AA-LCR `84.7%`, `111.8 tok/s`, `83.63s`, `$4.00 / $20.00` (`Max`: II `59.1`, FC2.0 `46.9%`, CAI `58.2%`, `340.35s`). |
| **Tier 1 (Worker)** | Hard code edits | `claude --model opus --effort xhigh` *(use `--effort max` for toughest bugs)* | `agy --model gemini-4-neon-xhigh` *(or `agy --model gemini-4-carbon-high`)* | Pick (`Xhigh`): FC2.0 `44.2%`, II `57.5`, TB4.1 `59.6%`, AA-LCR `84.7%`, `111.8 tok/s`, `83.63s`, `$4.00 / $20.00` (`Max`: FC2.0 `46.9%`, CAI `58.2%`, `340.35s`). Backup (`Neon Xhigh`): FC2.0 `44.4%`, CAI `58.6%`, II `61.5`, TB4.1 `65.2%`, `$3.00 / $15.00` (`Carbon High`: FC2.0 `40.6%`, TB4.1 `66.2%`, `$4.00 / $20.00`). |
| **Tier 2 (Standard)** | Medium code edits | `agy --model gemini-4-hydrogen-high` | `claude --model sonnet --effort xhigh` *(or `--effort high` for speed)* | Pick: II `51.0`, FC2.0 `36.3%`, TB4.1 `56.1%`, AA-LCR `not listed`, `184.0 tok/s`, `17.26s`, `$1.50 / $7.50`. Backup (`Xhigh`): II `49.9`, FC2.0 `35.6%`, TB4.1 `56.6%`, AA-LCR `79.7%`, `148.9 tok/s`, `38.03s`, `$2.00 / $10.00` (`High`: II `41.5`, FC2.0 `25.5%`, `12.91s`). |
| **Tier 2 (Exec)** | Running commands/tests (execution) | `agy --model gemini-4-hydrogen-high` | `claude --model sonnet --effort xhigh` *(escalate to `--effort max` or `agy --model gemini-4-neon-xhigh`)* | Pick: TB4.1 `56.1%`, II `51.0`, FC2.0 `36.3%`, `184.0 tok/s`, `17.26s`, `$1.50 / $7.50`. Backup (`Sonnet Xhigh`): TB4.1 `56.6%`, `148.9 tok/s`, `38.03s`, `$2.00 / $10.00` (`Sonnet Max`: TB4.1 `65.2%`, `255.00s`; `Neon Xhigh`: TB4.1 `65.2%`, `$3.00 / $15.00`). |
| **Tier 3 (Cheap)** | Read / audit / summarize | `claude --model haiku --effort high` *(or `--effort medium` for quick summaries)* | `codex -m gpt-6-luna -c model_reasoning_effort="medium"` *(or `"high"`)* | Pick (`Haiku High`): II `30.0`, FC2.0 `23.2%`, AA-LCR `77.3%`, `230.8 tok/s`, `20.84s`, `$0.10 / $0.50` (`Medium`: II `24.6`, AA-LCR `77.3%`, `9.88s`). Backup (`Luna Medium`): II `18.5`, AA-LCR `78.3%`, `115.8 tok/s`, `5.09s`, `$0.10 / $0.50` (`High`: II `21.5`, AA-LCR `79.3%`, `8.97s`). |
| **Tier 3 (Long Ctx)** | Long-file reading | `claude --model haiku --effort max` *(or `--effort high` when latency matters)* | `codex -m gpt-6-luna -c model_reasoning_effort="max"` *(or `"high"`)* | Pick (`Haiku Max`): AA-LCR `82.7%`, II `36.5`, `258.2 tok/s`, `179.73s`, 1M ctx, `$0.10 / $0.50` (`High`: AA-LCR `77.3%`, `20.84s`). Backup (`Luna Max`): AA-LCR `83.3%`, II `27.9`, `129.1 tok/s`, `63.84s`, 1M ctx (`272k` default in Codex CLI), `$0.10 / $0.50` (`High`: `79.3%`, `8.97s`). |
| **Tier 4 (Fastest)** | Light chores | `claude --model haiku --effort low` | `codex -m gpt-6-luna -c model_reasoning_effort="low"` *(or `agy --model gemini-4-hydrogen-low`)* | Pick (`Haiku Low`): II `18.6`, FC2.0 `8.0%`, TB4.1 `12.6%`, AA-LCR `72.0%`, `222.1 tok/s`, `6.92s`, `$0.10 / $0.50`. Backup (`Luna Low`): II `9.7`, FC2.0 `2.2%`, TB4.1 `0.0%`, AA-LCR `74.0%`, `104.7 tok/s`, `2.04s`, `$0.10 / $0.50` (`Hydrogen Low`: II `26.9`, `6.09s`, `$1.50 / $7.50`). |
| **Special (`agy`)** | Image making (`agy`) | `agy --model gemini-4-hydrogen-low` *(uses `agy` built-in `image-generator` subagent)* | `agy --model gemini-4-hydrogen-medium` *(or `agy --model gemini-4-neon-medium`)* | `agy models` has no dedicated image-gen slug; image-gen scores & $/image are `not listed` in `pricing.md`. Driving the `image-generator` subagent with `Hydrogen Low` (`151.6 tok/s`, `6.09s`, `$1.50 / $7.50` text) minimizes wrapper token cost. |

*(Legacy/unlisted models: `gpt-5.6-luna`, `gpt-5.6-terra`, `opusplan`, `gemini-pro-orchestrator*`, and `gpt-oss-120b-medium` have `not listed` benchmark scores in `pricing.md`.)*

---

## 2. Effort Levels per CLI (Exact Flag Values)

| CLI | Flag syntax | Exact effort values allowed | Notes / model-specific limits |
| :--- | :--- | :--- | :--- |
| **Claude CLI** (`claude` v2.1.332) | `--effort <level>` *(or `CLAUDE_CODE_EFFORT_LEVEL=<level>`)* | `low`, `medium`, `high`, `xhigh`, `max`, `ultracode` | Applies to `opus` (`claude-opus-5-5`), `sonnet` (`claude-sonnet-5-5`), `haiku` (`claude-haiku-5-5`), `opusplan`; default is `medium` on 5.5 (`ultracode` sets `xhigh` + Ultracode workflows). |
| **Codex CLI** (`codex-cli` 0.172.0) | `-c model_reasoning_effort="<level>"` *(or `--config ...`)* | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` | `gpt-6-luna` and `gpt-5.6-luna` support `low`, `medium` *(default)*, `high`, `xhigh`, `max` (no `ultra`; API also allows `none`). `gpt-5.6-terra` additionally supports `ultra`. |
| **Antigravity CLI** (`agy` v1.5.18) | `--effort <level>` OR `-<level>` suffix in `--model` | `low`, `medium`, `high`, `xhigh`, `max` | `low`/`medium`/`high` on Neon, Carbon, Hydrogen, Claude 5.5, Argon, 3.8 Flash; `xhigh` only on `gemini-4-neon` & `gemini-4-hydrogen` in `agy models`; no `-max` variant listed in `agy models`; `gpt-oss-120b-medium` is fixed `medium`; Orchestrators ignore `--effort`. |

---

## 3. Orchestrator Flow

1. **Plan & verify on Tier 1:** The host runs on `agy --model gemini-4-neon-xhigh` (or `claude --model opus --effort xhigh`) to decompose work, write clear file/interface contracts, and verify final outputs/tests.
2. **Execute on the cheapest capable tier:** Delegate read/audit/summarize panes to Tier 3 (`haiku` or `gpt-6-luna`), command/test runs to Tier 2 (`gemini-4-hydrogen-high` or `sonnet`), and hard edits to Tier 1/2.
3. **Fail fast and report:** Workers must not spin on blocked tasks, missing access, or repeated test failures—stop immediately and send a concise `link_report` / `link_tell` with the exact error and what was tried.
4. **Escalate one tier after 2 failed checks:** If a worker fails two verification/test attempts on the same subtask, stop that tier and re-assign the task one tier up (e.g., Tier 3 -> Tier 2 `hydrogen-high`/`sonnet-xhigh` -> Tier 1 `opus-xhigh`/`neon-xhigh`).

---

## 4. Notes & Guardrails

- **Expiring `agy` models (Nov 30, 2026):** `gemini-3.8-flash-{low,medium,high}`, `gemini-4-argon-{low,medium,high}` (plus `gemini-pro-orchestrator-argon`), and `gpt-oss-120b-medium` are scheduled for removal on **November 30, 2026** per `~/model-list/agy-cli.md`—do not hardcode them into durable multi-window scripts.
- **Keep `gpt-6-luna` off command-heavy work:** Per `~/model-list/pricing.md`, `GPT-6 Luna` scores only **0.0%–12.6%** on Terminal-Bench 4.1 (`0.0%` Low, `2.5%` Medium, `5.1%` High, `8.1%` Xhigh, `12.6%` Max). Use it only for read/audit/summarize/extraction chores, and route test/command execution to `gemini-4-hydrogen-high` (`56.1%`) or `claude --model sonnet --effort xhigh` (`56.6%`).
- **Unavailable models excluded:** `Claude Fable 5.2` (not available to user) and `GPT-6.1 Terra` / `GPT-6.1 Sol` / `GPT-6.2 Sol` / `GPT-6.2 Astra` (not present in this machine's Codex CLI catalog) are intentionally omitted from launch commands.
