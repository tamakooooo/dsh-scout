# dsh-scout

> A recruiting workbench plugin for DeepSeek Harness. It drives a real, already-logged-in
> Chrome through the employer console, with **TypeSafe Jev** choosing each step, a human
> authorizing anything that spends quota, and every action verified before it counts.

The roadmap lives in [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md) (v0.6 — **planned
work, not yet implemented**).

A DSH **Host bundle** that gives the agent a real Chrome window to drive, with
**TypeSafe Jev (System One)** choosing each step instead of a chat model.

Two independent pieces, neither with a package dependency:

- **Browser engine** — raw CDP over the DevTools WebSocket (`node:child_process`,
  global `fetch`, global `WebSocket`).
- **Decision layer** — `POST {baseUrl}/systemone` on CommandCode's Provider API,
  `model: typesafe/jev`. Jev answers calibrated probabilities over typed questions
  and never generates text.

Because nothing is imported from a Harness package, the bundle installs and
activates with no dependency resolution step.

## Tools

| Tool | Purpose |
|---|---|
| `browser_open` | Launch (or reuse) a browser session and navigate to a URL. |
| `browser_snapshot` | Read the page as bounded text: URL, title, numbered interactive elements, visible text, scroll position. |
| `browser_act` | Pursue a natural-language goal; Jev picks one action and one target per step; returns a per-step trace with probabilities. |
| `browser_jev` | Ask explicit `noul` / `choice` / `score` questions about the current page. |
| `browser_close` | Close one session, or every session this plugin opened. |

## How a step is decided

`browser_snapshot` stamps every interactive element that survives a visibility
filter with `data-dsh-jev-ref` (`e1`, `e2`, …). That list is the **entire** action
target vocabulary, so Jev can never invent a selector.

One step is **two** requests, not five.

The first carries every question the page state can answer, because TypeSafe evaluates all
questions in a request in parallel and adding questions barely moves the response time:

| Question | Kind | Meaning |
|---|---|---|
| `page_status` | `choice` | ready / loading / login_required / blocked / error_page / unrelated |
| `goal_reached` | `noul` | Is the goal already achieved on this page? |
| `next_action` | `choice` | click / type / press_enter / scroll_down / scroll_up / back / wait / finish / give_up |
| `target_click`, `target_type`, `target_press_enter` | `choice` | One option per element ref, plus `none` — one question per targeted action |

The target depends on which action is chosen, and that is what the documented fan-out
pattern is for: ask the target **for every targeted action** in the same request, then use
only the answer belonging to the action that was chosen and ignore the rest. Each question
names its own action, so the model never needs to see the others' answers. Asking them
separately cost three round trips per step, each re-sending the whole state.

The second request rates the exact action/target/input that would execute
(`confidence`: Guessing → Plausible → Fairly sure → Certain). It stays separate for two
reasons: it is conditioned on a target that does not exist until the first request is
answered, and it is a 0–3 soundness score rather than the 0–1 `confidence` the answers
carry — so batching must not silently rescale the gate that reads it.

Jev cannot author text or URLs. Literal text is supplied by the caller through
`browser_act`'s `text` argument, and URLs through `browser_open`. Actions that need
a target (`click`, `type`, `press_enter`) require one of the enumerated refs.

The loop stops and reports a reason rather than guessing:
`done`, `gave_up`, `low_confidence`, `stalled`, `no_target`, `needs_text`,
`needs_confirmation`, `result_unconfirmed`, `risk_page_detected`, `action_failed`,
`max_steps`, `error`, `aborted`.

## Element labels

A target is only as useful as its label. The decision layer picks among the refs the
snapshot enumerated, so ten buttons all labelled "打招呼" give it nothing to choose
between — and a wrong pick can spend a real credit, such as a phone-number reveal.

Labels are built in two passes, because only ambiguity should pay for extra work:

1. **Own label** — `aria-label`, `title`, `placeholder`, `alt`, a bound `<label>`, the
   element's text, or its current value. Unambiguous controls stop here, so ordinary
   navigation links keep exactly the text they show.
2. **Context, for empty or repeated labels only** — a *semantic* from a descendant
   `aria-label`/`title` or an SVG sprite id (`<use href="#icon-phone">` → `phone`), plus
   the *record* the element belongs to: walk up to the nearest ancestor holding 2–14
   controls, then take the most identifying short text inside it.

That turns a card full of anonymous buttons into `梁先生 · 打电话`, `梁先生 · 打招呼`,
`梁先生 · button`.

### What a live page taught this code

The first version passed its synthetic fixture and then **half-failed on a real employer
console**. Probing the live DOM — read-only, over CDP, against the browser already
logged in — produced four corrections, each now pinned by
`test/fixtures/cards-nested.html`:

| Assumption | Reality | Rule now |
|---|---|---|
| A record holds exactly one name element | A real card matched **11** — `talent-basic-info__name`, `..._name--inner`, a title, company and job names | Prefer a class/id that says "name", then take the shortest text of 2–24 characters |
| Six ancestors reach the name | The greeting button sat three wrappers deeper than the phone button, putting the name at the **seventh** | Walk ten levels; the control-count window is what bounds it |
| A class keyword names the action | `resume-button` / `resume-action` are component names, so every button on the card read `resume` | Trust only an explicit `icon-*` segment, and reject generic ones (`icon-btn`) |
| The `name` attribute is a label | A radio group's `name` was the generated token `rg-04khvrdsa` | Reject generated identifiers, fall through to context |

A signal-free icon button now reads `梁先生 · button`. That is deliberately plain: it says
*which record*, and admits it does not know *what the button does*, rather than inventing
a confident wrong answer. When the page genuinely offers no text at all — the two radios
above have none — the label stays `(no label)` instead of guessing.

### Making a label unique, in three stages

Uniqueness matters twice over: it is how the decision layer picks, and it is what the
confirmation gate compares. Labels are sharpened only as far as a collision demands:

1. **The record** — a per-record action, or a repeated label, gains its record's name:
   `饶先生 · 打招呼`.
2. **The discriminator** — if that is *still* shared, the record contributes one coarser
   handle, its age: `王先生 42岁 · 打招呼` beside `王先生 37岁 · 打招呼`. On a live page with
   three candidates surnamed 王, this was what separated them.
3. **Document order** — if it is *still* shared, the label is numbered: `· button #1` and
   `· button #2`. Two icon-only buttons inside one card carry no text, no accessible name
   and no sprite, so position is the only honest handle left; `#2` claims nothing beyond
   "the second of these".

`(no label)` is deliberately never numbered. It is a statement of fact, and numbering it
would dress it up as a label while adding no information.

On the live employer console this took one snapshot from 18 unique labels out of 40 to
**40 out of 40**, with nothing invented from a component class.

### A duplicated action is dropped, not labelled

The console renders each card action as a BEM block wrapping its own element —
`<button class="resume-btn-small">` around `<button class="resume-btn-small__icon">`. One
action, drawn twice.

Left alone, the inner copy is not merely redundant, it is a **silently different target**.
It carries no text, so it earns a positional label (`… · button #2`), and the confirmation
gate matches on labels. Clicking that ref really does greet the candidate, while the gate
sees a label with no consequential word in it and lets the action through — a
confirmation bypass produced by a naming rule.

So a `<button>` inside a `<button>` is dropped: invalid HTML, the click bubbles to the
outer one, and the surviving copy keeps the label that matters. The rule is deliberately
narrow — a `<button>` inside an `<a>` is *kept*, because "card link with its own action"
is the ordinary pattern where the inner control is a genuinely different target.

On the live page this removed 14 of 40 elements, all duplicates, and every card action
became a clean `饶先生 · 打电话` / `饶先生 · 打招呼` pair.

The fixture that guards this builds its nesting **in script**, not markup, and that detail
is the point: `<button>` inside `<button>` is invalid HTML, so the *parser* closes the
outer button and the two end up as siblings. Only a DOM built by script holds the nesting
— which is how the real console produces it, and why a markup-only fixture would silently
fail to reproduce the bug it exists to catch.

## State that lives in styling, not in text

Two facts about a page are not words, and a text-only state cannot express either. Both
are now reported rather than left to be inferred, because a decision layer asked a question
its input could not answer will answer anyway.

**Which one is current** — `[selected]` on a collected element, and a
`current selection:` line in the state. This is not decoration: on the employer console the
active job is a `<div>` with no interactive role, so it never enters the element list at
all, and six job titles read alike. Asked which job it was looking at, the decision layer
answered **测试工程师 with 0.83** while the DOM said
`job-pane__item--active` → `质量工程师`. It was not a close call; there was simply no
evidence in the state, so it guessed.

The whole document is scanned instead of just the collected elements, and that is the point
— a per-element marker cannot reach an element that was never collected. ARIA
(`aria-selected`, `aria-current`, `aria-checked`) wins where present because it is a
declaration rather than a styling habit; otherwise class tokens are matched whole, so
`container` is never read as `on` and `inactive` never as `active`, and the BEM shapes
(`--active`, `_active`, `is-active`) are accepted.

The scan reports `--active` on a **carousel** too, and that was a real false positive:
`km-carousel__item-wrapper--active` is the frame currently on screen, which is automatic
and is not a choice anyone made. The rotator is named and excluded — a categorised false
positive rather than a length cutoff, which would also have dropped the genuinely long job
titles.

**Whether a click would reach it** — `[covered]` on an element whose own centre point
answers with something else. Visibility is not reachability: an element under an open
dropdown is sized, opaque, rendered and completely unreachable, and that difference lives
only in geometry. A real page had a mega-menu open over the middle of the list, and nothing
in the text said so.

Coverage is measured with `elementFromPoint` at the element's centre, so it is per
snapshot and per scroll position. Off-screen elements are deliberately *not* reported as
covered — that is a different problem with a different fix.

Both markers are appended **after** the label-uniqueness passes, so they can never change
how a label was resolved.

## Screenshots

`browser_snapshot({ screenshot: true })` attaches a PNG of the page; `full_page: true`
captures the whole scrollable document instead of the viewport. `browser_act` takes the
same flag and attaches the state the run ended in, so the outcome can be checked rather
than inferred from the trace.

The capture is `Page.captureScreenshot`; the bytes are committed through the harness
attachment store and returned as an image content block, exactly as the shipped
`read_image` tool does it.

**The capability gate is not optional.** Emitting an image block on a route whose model
does not declare image input fails the *whole request*, which breaks the session rather
than one call — the same class of failure as a malformed tool schema. So the gate is
copied from `read_image`: the active route is resolved through `ctx.llm`, and a model
that does not declare `image` in `inputModalities` gets an actionable refusal instead of a
broken session.

The gate resolves through the model declaration, not through the model's actual ability,
and those are different things. `deepseek/deepseek-v4.1-flash` on this route accepts images
— a direct `image_url` request answers 200 — but the provider's `/models` endpoint
publishes no modality field at all, so nothing could discover it: `input` has to be
declared on the model entry in the profile patch. It now is, and screenshots work.

Worth knowing because the failure mode is confusing in both directions: an undeclared but
capable model refuses, and a declared but incapable one fails every request rather than
one call.

## Tabs

A session tracks every page the browser holds, not just the one it opened. The list is
rebuilt on each call from `Target.getTargets` — which the session already had to call to
check that the active tab still exists — so **a tab the site opened for itself** is picked
up on the next call. That is the case that used to strand the session on the old page:
`window.open`, a `target="_blank"` link, an OAuth hop.

- `browser_snapshot` reports `tabs`, each with a 1-based index, title, URL, and which one
  is active. The rendered text shows the list whenever there is more than one.
- `tab` selects one by index or by a substring of its URL or title, on
  `browser_snapshot`, `browser_act`, and `browser_jev`.
- `browser_open({ new_tab: true })` opens an additional tab and activates it.

A new tab is **registered but not activated**: following a popup automatically would move
the caller's context under them, so the tab is reported and the caller switches. When the
active tab disappears, the session prefers another tab it already tracks over opening a
fresh one.

One silent ordering bug had to be fixed for this to be honest. `waitForReady` alone
returns instantly after a navigation is *requested*, because the previous document is
still `complete` — a freshly created target sat on `about:blank` and reported success. So
`navigate` now waits on the load event, filtered by `sessionId`, because a browser with
several tabs fires that event for all of them.

## Result verification

An action reporting `ok` means the events were dispatched. It does not mean the site
accepted them, and the two ways of being wrong cost different things: treating a silent
failure as success walks away from work that never happened, while treating an unreadable
success as failure retries it — and on a recruiting console "打招呼" is a finite resource, so
the retry is the expensive mistake.

Every state-changing action is therefore followed by a check of the page it produced, and
the outcome is one of three:

| Verdict | Meaning | What the run does |
|---|---|---|
| `verified` | Evidence says the page reached the intended state. | Continues. |
| `refuted` | Evidence says it did not — an error, a limit, a rejection. | Stops as `action_failed`, with the page's own words in the note. |
| `unconfirmed` | There is nothing to go on either way. | Stops as `result_unconfirmed`, **for a consequential action**, and hands the decision to a person. |

`unconfirmed` is never folded into success. That is the whole point of the feature: the
next step after a silent failure is normally a retry, and a retry spends quota again.

### Where the evidence comes from

The page is read first, and the decision model is only consulted when the page is
inconclusive — so the common cases cost no tokens at all:

- **A control that changed** — the console swaps `打招呼` for `已打招呼` on the very button
  that was pressed. Nothing is more specific than that.
- **A success phrase that was not there before** — `打招呼成功`, `已投递`, `操作成功`.
- **A failure phrase** — `操作失败`, `已达上限`, `请稍后重试`. `已打过招呼` is special: the
  end state already holds, so it counts as `verified` **and is flagged idempotent** — the
  one case where clicking again is both useless and wasteful.
- **Otherwise**, a `noul` question to the decision model: *judged only by the change above,
  did this action achieve its intended effect?* Above `verificationFloor` is `verified`,
  below `1 - verificationFloor` is `refuted`, and in between is `unconfirmed`.

A phrase that was already on the page before the action is not evidence for it.

### How hard it insists depends on what the action costs

Halting the whole task every time a component fails to announce itself would be worse than
useless, and a benign click costs nothing to repeat. So the two halves are tiered:

- **A consequential target** (anything in `consequentialPatterns` — the gate list) is
  quota-bearing: it gets the model when the page is inconclusive, and an `unconfirmed`
  reading stops the run.
- **Any other state-changing action** is checked against the page for free, and an
  `unconfirmed` reading is **recorded but does not stop the run**. A `refuted` reading stops
  it either way, because the page is actively saying something went wrong.

### On the board

Each action in the activity feed carries its verdict and its basis — `✓已验证`,
`⚠结果未确认`, `✗页面否定` — and the totals panel counts the three separately. `结果未确认` is
called out in its own colour rather than being lumped into success or failure, because it is
the number that means *a person is needed*, and it is the number this feature exists to
drive down.

`browser_act` reports the same per step as `verified` and `basis`, and the run status adds
`result_unconfirmed` to the list.

### Configuration

```yaml
verifyActions: true        # set false to turn the whole thing off
verificationFloor: 0.6     # noul threshold; the unsure band is 0.4–0.6
successPatterns: [...]     # defaults in lib/verify.js
failurePatterns: [...]
```

An empty pattern list falls back to the defaults, like every other list here — it cannot be
used to switch the check off.

## Pacing and guardrails

Risk control measures **behaviour**, not which browser binary is running. A client that
wants to stay welcome has exactly one honest lever: go at a person's pace. That lives in
`lib/pacing.js`.

| Guardrail | Default | Effect |
|---|---|---|
| `minActionDelayMs` / `maxActionDelayMs` | 3000 / 9000 | A randomized wait after every action, so nothing lands on a metronome. |
| `maxActionsPerSession` | 20 | State-changing actions per session. On exhaustion the run stops with `action_budget_exhausted`. |
| `cooldownEveryActions` / `cooldownMs` | 8 / 45000 | A forced pause every N state-changing actions. |
| `stopOnRiskPage` | true | A verification or rate-limit phrase on the page halts the run **before the decision is even requested**, so it costs no tokens and performs no action. Reports `risk_page_detected`. |
| `requireConfirmation` | true | A step whose **target label** matches a consequential pattern stops with `needs_confirmation` and is reported, not performed, until the caller re-runs the same goal with `confirm: true`. |

The confirmation gate keys on the target's own label, not on the action kind, because
`下一页` and `打招呼` are both a `click` to the decision layer but only one of them
spends quota or messages a real person. That also closes the loop on Jev picking a
plausible-looking but wrong target.

**What this deliberately does not do.** Fingerprint spoofing, `navigator.webdriver`
patching, captcha solving, and proxy rotation are detection evasion. They are unreliable
by construction — the platform's detection moves faster than any stealth patch — and a
plugin has no business shipping them. When a verification wall appears, the run stops and
hands back to the human.

`test/guardrails-check.mjs` pins all of it, including the two live stops.

## Configuration

The plugin exports no `Config` schema, so the patch row's `config` object passes
through untouched and the plugin applies its own defaults. A later patch layer
overrides any single field by targeting `id: jev-browser`:

```yaml
- id: jev-browser
  name: '@local/dsh-jev-browser'
  config:
    headless: true
    maxSteps: 12
    confidenceFloor: 0.8
```

| Field | Default | Meaning |
|---|---|---|
| `apiKeyEnv` | `COMMANDCODE_API_KEY` | Credential reference. Resolved through the credentials service per call, then `process.env`. |
| `baseUrl` | `https://api.commandcode.ai/provider/v1` | Provider API root. |
| `model` | `typesafe/jev` | Decision model id. |
| `chromePath` | `''` | Explicit Chromium-family binary; probed from the usual locations when empty. |
| `managedBrowserDir` | `''` | Where the managed Chromium installer puts its download; defaults under `$DSH_HOME`. |
| `profileDir` | `''` | Fixed browser profile. Empty means a throwaway one deleted on close, which loses logins. |
| `keepBrowserOnUnload` | `true` | Plugin disposal detaches instead of killing, so a reload cannot end a logged-in browser. |
| `headless` | `false` | Default window mode for new sessions. |
| `maxSteps` | `8` | Step budget per `browser_act` call (capped at 20). |
| `maxElements` | `60` | Elements offered to Jev per step. |
| `maxStateChars` | `6000` | Page-state character budget. |
| `confidenceFloor` | `0.5` | Below this `score`, a mutating step stops the run instead of executing. |
| `minActionDelayMs` / `maxActionDelayMs` | `3000` / `9000` | Randomized wait after each action. A legacy `actionDelayMs` still maps onto both. |
| `maxActionsPerSession` | `20` | State-changing actions per session; `0` is unlimited. |
| `cooldownEveryActions` / `cooldownMs` | `8` / `45000` | Forced pause every N state-changing actions. |
| `stopOnRiskPage` | `true` | Halt on a verification or rate-limit page before any decision is requested. |
| `requireConfirmation` | `true` | Report consequential targets instead of acting on them until `confirm: true`. |
| `consequentialPatterns` | 25 patterns | Target labels treated as consequential. |
| `riskSignals` | 17 phrases | Page text treated as a risk wall. |
| `requestTimeoutMs` | `45000` | Per-decision timeout. |
| `maxSessions` | `4` | Live sessions before the oldest is evicted. |
| `viewer` | `true` | Serve the live view page and its controls. |
| `viewerPort` | `19390` | Loopback port for the live view; a free port is taken if this one is busy. |

Numeric fields are clamped, never rejected: a bad value must not stop the profile
from loading.

## Monitoring board

The board is a **page inside the Harness UI**, not an iframe: the client half registers a
`sidebar.panellist` entry (`招聘工作台`) and a `main` cell under the same id, and the sidebar
button selects that page. That is the only way it can inherit the host's theme tokens,
light/dark switching, and locale — an iframe document receives none of them, and the official
UI guidance rules it out for exactly that reason.

Its data comes from the plugin's own routes on the **application's server**
(`/jev-browser/state.json`, `/jev-browser/frame.png`, `POST /jev-browser/decide`), so the page
is same-origin and needs no token, no second port, and no CORS.

| Panel | What it answers |
|---|---|
| Live frame | What is on screen **right now**, repolled about once a second. |
| 实时指示 | A green dot when a frame is current, when it last updated, and the most recent action with its verdict. |
| 待批准 | Every consequential action the gate stopped on — one entry per session, each with its own id — and **批准这一步** / **拒绝**. |
| 会话 | Every live session with origin, tab count, actions, and idle time. **Click one to watch its frame.** |
| 累计 | Runs, steps, verified / unconfirmed / refuted, risk stops, confirmations vs grants, decision tokens. |
| 最近运行 | One row per `browser_act`: goal, outcome tag, steps, tokens. |
| 活动轨迹 | The event feed: actions with their target and **verification basis**, risk signals, confirmations, grants, denials. |

### How the live frame works

Every capture is taken fresh — a screenshot is not a stream, so the page polls it:

- **Preloaded before swapping.** The next image is only assigned once it has decoded, so the
  previous frame stays on screen instead of flashing an empty box between captures.
- **Chained, not fixed-interval.** The next poll is scheduled after the current one settles,
  so a slow capture cannot stack requests up.
- **Paused while the page is hidden.** Nobody is looking, and a capture is real work on the
  browser being driven.
- **Click a session to switch.** With several sessions, the frame follows the one you pick;
  with none picked, the host half chooses — a session waiting for a decision wins, then
  `default`.

The route is covered by a check that captures a page, changes it, and captures again: a view
that returns the same bytes for a changed page **looks** live and is not.

A **loopback view** on `127.0.0.1` (default port 19390, path token) still exists and serves
the same data plus an HTML dashboard. It is what `browser_open` returns in a profile without a
web carrier — a CLI or headless run — where the native page cannot be shown. `viewer: false`
turns it off.

Everything on the board is **observed, never inferred**: an event is appended at the moment
the action happened, so the feed can answer "what did it actually send, and to whom" — which
the pixels cannot, because pixels only show the present moment. The record is in memory on
purpose; it describes what this process did, so it should not outlive the process, and a
durable audit trail is a different feature with a different retention question.

**The loopback port and its token are that listener's whole access control story**, which is
why it binds `127.0.0.1` only and every route requires the token: that page can authorize
actions in a logged-in browser, and another local process should not reach it by guessing a
port.

### Answering the gate from the panel

The confirmation gate is unchanged in what it protects — a consequential target is still
never actioned on the agent's own say-so, and the agent **cannot grant it itself**; only the
panel or the conversation can. What changed is *where a human may answer it*.

Until now the only reply path was the conversation: the tool stopped, reported
`needs_confirmation`, and the next call needed `confirm: true`. That made the confirmation
a conversation-shaped thing rather than a decision. Now the panel's **批准这一步** records
a grant for that exact target label, and the next `browser_act` that reaches the gate
spends it.

Four properties keep it honest:

- **One-shot.** The grant is deleted when consumed, so approving one greeting is not
  standing permission for every later greeting.
- **Bound to the whole action.** The grant is keyed by session, tab, url, goal, action,
  target, href and typed text, so it cannot transfer to the same label under a different
  goal.
- **One stop per session.** Several sessions can be waiting at once; a new stop replaces only
  its own session's, so the earlier one stays answerable.
- **Shared, not per-call.** `Pacing` is constructed once per plugin. It previously lived
  inside `runGoal`, which would have made the whole feature a silent no-op: the panel
  would have written a grant to an object the next call never saw.

## Prerequisites

- A CommandCode plan with **API access** (`typesafe/jev` is served on the separate
  `/systemone` endpoint and is not in the `/models` list).
- The key stored under `COMMANDCODE_API_KEY` (Settings → Models), or exported in the
  launching environment.
- A Chromium-family browser. Google Chrome is detected at the usual macOS, Linux,
  and Windows locations.
- Host runtime with global `WebSocket` (Node 22+; the Electron/Node 24 Host qualifies).

## Checks

```sh
node test/schema-check.mjs       # no browser needed
node test/labels-check.mjs       # launches a headless browser
node test/guardrails-check.mjs   # launches a headless browser, needs COMMANDCODE_API_KEY
```

`test/schema-check.mjs` runs with plain Node and no Harness packages. It asserts
every tool's `parameters` and `output.schema` are object-rooted, inside the
registry's supported keyword subset, and **lossless JSON**, and that `output.render`
survives a schema-shaped sample.

`test/labels-check.mjs` needs a Chromium-family browser but no Harness packages. It
opens a fixture that reproduces a repeated-card page and asserts that every repeated
control ends up with a distinct, meaningful label — see [Element labels](#element-labels).

Beyond these, two harnesses are worth running against an extracted DSH package tree,
because they use the shipped registry validators rather than re-implementations:
`assertSupportedJsonSchema` over every schema, and `validateJsonSchemaValue` over
every live tool result. A closed-tab recovery harness covers `Sessions.page()`.

That last property is not cosmetic. A schema key whose value is `undefined`
survives `Object.hasOwn` but not a JSON round trip, and `@deepseek-ai/dsh-tools`
refuses to project such a document while assembling a request — a refusal that
breaks **every model request in the session**, not just the offending tool. The
first build of this bundle shipped exactly that bug in `shape()`; the check above
exists so it cannot come back silently.

The authoritative check is the shipped validator itself. With the extracted DSH
package tree available, `assertSupportedJsonSchema` and `validateJsonSchemaValue`
from `@deepseek-ai/dsh-tools` can be run against these definitions directly, and
every live tool result can be validated against its declared `output.schema`.

## Session recovery

A page target can vanish while the browser process stays alive. On macOS, closing the
last Chrome window does not quit the app, so the browser keeps serving its DevTools
endpoint with no page attached; every later command against the dead flat session then
fails with a raw `Session with given id not found`.

`Sessions.page()` reconciles that before each tool call. It lists targets on the
browser-level session — which needs no page session, so it still works when the page
is gone — and re-creates the target at the session's last known URL when the old one
has disappeared. `browser_snapshot` reports the event as `recovered: true` and says so
in its rendered text, because a re-created tab is a **reload**: unsaved form state is
gone and refs are renumbered.

Two failures stay loud instead of being papered over:

- The browser process itself is gone → `the browser for session "x" is gone; open it
  again with browser_open`.
- The session name was never opened → `no browser session named "x"`.

`lib/sessions.js` also exposes `raw(name)` for diagnostics and tests: it returns the
session with no liveness check, which is exactly what the tool-facing `page(name)`
exists to prevent.

## Work mode: 招聘工作台

The bundle installs an agent preset as well as the plugin row. Switching a session to
**招聘工作台** replaces the agent's instructions and its limits together:

- a persona that states the workflow rules — confirm before acting on a person, screen
  from page facts rather than impressions, hand a verification wall back to the human,
  watch the action budget, and report honestly when a run hits its step budget;
- a **preset-scoped copy of the browser plugin with tighter limits**: 5–15 s between
  actions, 12 state-changing actions per session, a 90 s cooldown every 5, and a
  confidence floor of 0.7 instead of 0.5. A preset-scoped registration shadows the
  profile-wide one, so those limits apply inside this mode and nowhere else.

A preset is a self-contained composition, which is why this mode carries its own copies
of `ask_user_question`, `todo_write`, `present`, and the web tools.

**It does not open a second browser.** Both the profile row and the preset row resolve
the same `profileDir` and the same launched-browser registry, so the mode reattaches to
the browser the user is already signed into.

To make the browser tools exist *only* in this mode — which is worth doing if you dislike
five tool schemas in every other session's request — set `disabled: true` on the
`jev-browser` row at the profile level in `cordis.patch.yml`.

## Managed browser

Driving the installed Chrome works and inherits the user's login, but Chrome
Auto-Update can move the DevTools surface under a running plugin. `browser_open` accepts
`install_browser: true`, which downloads a pinned **Chrome for Testing** build once and
then prefers it:

```
chromePath (explicit)  →  managed Chrome for Testing  →  the machine's own Chrome
```

`lib/managed.js` resolves the pinned version from the Chrome for Testing index, downloads
the platform archive, extracts it with `unzip`, and records the binary in
`$DSH_HOME/runtimes/jev-browser/installed.json`. Resolution happens per launch, so an
install takes effect on the next `browser_open` with no restart.

Nothing downloads by itself: a ~200 MB fetch is the user's decision, so it happens only
when that parameter is set.

**This is not a stealth build.** It is stock Chrome for Testing, so it presents exactly
the automation signals stock Chrome does. Pinning a version buys reproducibility, not
invisibility — see [Pacing and guardrails](#pacing-and-guardrails) for what actually
reduces risk.

## Review findings

Three independent read-only reviewers audited this package, one per slice of the surface
(page extraction and the decision loop; sessions/CDP/lifecycle; tool contracts, the live
view, and authorization). Everything below was found by them, reproduced by them, and then
re-checked before being accepted — several of the claims were about code written in the
same session that introduced the reviewer-visible behaviour.

### Fixed in this pass

| Finding | Why it mattered |
|---|---|
| `confirm: true` never consumed a grant, and a denial never revoked one | The one-shot authorization was not one-shot: it survived its whole TTL and silently authorized a later, unrelated action that hit the same label — different goal, session, or candidate. |
| `/decide` accepted any target | Any local client with the token, or a stale tab holding an old target, could pre-arm an authorization for something no human had looked at. It now refuses anything that is not the action actually pending (HTTP 409). |
| The confirmation gate keyed on the target's label only | Pressing Enter in a message box sends the message while the *target* is the text field, whose label matches no consequential word — the send button beside it was gated and the keyboard path was not. A keyboard submit from a text field is now gated on its own terms. |
| The risk match ran in the Host over truncated text | A verification wall appended to the end of a long page fell outside the character budget, so the stop-on-risk control was silently disabled by page length. The match now runs inside the page over its whole text and reports only what it matched. |
| An empty `consequentialPatterns` / `riskSignals` list | Every other field clamps or falls back so a bad value cannot break the profile; an empty list was the one input that could switch a safety gate off without saying so. It now falls back to the defaults. |
| `#reconcile` could activate a metadata-only tab | Lazy tab registration stores `sessionId: null`; activating such a tab made every later page-level command go out as a browser-level one — and the state stuck. It now attaches before activating, or opens a fresh page. |
| Label suffixes were truncated away | ` #n`, `[selected]`, and `[covered]` were appended before the length cut, so a long label lost the ordinal that makes a duplicated action addressable. The stem is now cut to fit and the suffixes are kept whole. |
| `digestPage` fingerprinted the text's *length* | A status flipping between two equally long strings looked unchanged, so two real changes in a row were reported as `stalled`. |
| `final_url` / `final_title` came from before the last action | A click that navigated was reported with the URL it left. The live document is now read once a run has actually acted. |
| `browser_jev` rejected a positional probability list | The guard was `typeof === 'object'`, which an array satisfies; output validation then rejected the value and took the *entire* tool result with it. The schema now accepts both shapes (`oneOf`). |
| `max_elements` / `max_chars` had no upper bound | `1e9` was a legal argument and silently voided the configured limit. A per-call override may now lower the budget but never raise it. |
| `-0` reached the tool result | The harness rejects `-0` as non-lossless JSON on both the snapshot and validation passes, so a negative near-zero score failed the whole call. It is normalized at both producers. |

`test/guards-check.mjs` was added with this pass: 23 assertions over the authorization, the
decision endpoint, `-0`, the budget clamp, the empty-list fallback, the page-side risk
match, and the output contracts. Those subsystems previously had no test at all.

### Merged from a second pass

A second agent worked the same findings in parallel, from a copy taken before the review.
Its work was merged in, and in several places it is the better design:

- **Authorizations are keyed by the whole action context**, not by the target label.
  `approvalKey` covers `session / tab / url / goal / action / target / href / textHash`, so a
  grant cannot transfer to the same label under a different goal — the half of that hole a
  label-only check leaves open. `setPending` mints a fresh id each time, so a stale panel
  cannot approve whatever replaced its decision, and `confirmPending` lets a conversation
  reply approve only the stop it belongs to.
- **`lib/monitor.js`**: the board follows a *selected* session rather than a hard-coded
  `default`, preferring the session that has a pending decision.
- **`test/isolate.mjs`**: every test run gets its own `DSH_PROFILE`, so a test can never
  read or rewrite the Host's browser registry. This closes a trap that had already bitten
  twice — a harness that inherited `DSH_PROFILE=desktop`, read the wrong registry, and
  tried to launch a browser onto the live, locked profile.
- **`test/regressions-check.mjs`**: 24 offline regression checks over a real headless Chrome
  with a local fixture server and deterministic decision stubs.
- **The snapshot's text is the *rendered* text.** `bodyText` is rebuilt from text ranges and
  viewport-clipped, so the decision layer sees what a person sees rather than the whole
  document.

That last change interacts with a safety control, and the interaction is worth stating: a
risk match over the snapshot text can no longer see a verification wall that sits below the
fold. The in-page risk match therefore runs over the **whole document**
(`document.body.textContent`, capped), not over the rendered text. Over-matching costs a
human a glance; under-matching means the agent tries to work around a captcha.

`test/regressions-check.mjs` gained one check for exactly that: it asserts the wall is
absent from the rendered text *and* present in `riskSignal` *and* that the run stops. The
risk check that already existed only exercised a wall inside the visible text — a test whose
name covered the general property while its fixture covered the easy case, which is exactly
the kind of gap a green suite hides.

### Found and deliberately not fixed yet

Real, reproduced, and left in place — each needs a judgement call or a larger change than a
review pass should make unilaterally:

- **Registry writes are not atomic.** `#write` truncates and rewrites in place, `#read`
  degrades to `{}` on any parse error, and read-modify-write has no lock. A Host restart at
  the wrong moment can lose every session record at once, silently.
- **Concurrent reconnects leak a connection.** Two `page()` calls that both observe a closed
  socket each reconnect; the later `set` wins and the first is orphaned, invisible to
  `closeAll`.
- **A stale `getTargets` snapshot deletes live tabs.** `#refreshPages` reconciles by
  deletion, so a concurrent call can drop a tab another call just created.
- **The revive path can leave an unregistered target** when `createTarget` succeeds and
  `Page.attach` fails, and a retry adds another — unbounded until restart.
- **`getTargets` failure is swallowed**, so a dead browser is reported as a working session
  rather than `SessionEndedError`.
- **No aggregate deadline in the `ensure` recovery path**; a wedged browser can be probed
  twice for roughly a minute and a half before the fallback launch.
- **Inner scrolling is invisible** to `scroll_down`, which scrolls the window only and still
  reports success — the employer console's list is an inner scroller.
- **`press_enter` falls back to `document.activeElement`** when its ref is gone, and reports
  success, so a stale ref can submit the wrong form.
- **The gate is decided from the snapshot but the click lands on the live node.** A
  framework that recycles nodes during the Jev round trip can change what a label refers to.
  The fix is to re-resolve and re-check the target immediately before acting.
- **`ensure` cannot tell "the profile is locked by a browser I cannot reach" from "nothing is
  running"** when `SingletonLock` is not a symlink, and a reused pid can make the guard
  refuse a launch that would have worked.
- **`[covered]` is advisory only.** `perform` dispatches events directly and never
  hit-tests, so a covered element is still clickable; the marker informs the caller, it does
  not stop anything.

## Known limitations

- **Refs are per-snapshot.** Refs are renumbered on every read, so a ref from an older
  snapshot may resolve to a different element or to nothing.
- **Tabs are polled, not evented.** A tab the site opens appears on the *next* call, and
  the session does not follow it automatically — it reports the tab and waits to be told.
  A `browser_act` run in progress therefore finishes on the tab it started on, even if the
  page spawned another one mid-run.
- **Positional labels are positional.** `· button #2` makes an unsignalled icon button
  addressable and says nothing about what it does.
- **Screenshots need the model to declare image input.** The capture always works; the
  pixels attach only when the routed model declares `image` in `inputModalities`, because
  attaching anyway would fail the request instead of the call. That is a declaration on the
  model entry, and the provider's `/models` endpoint does not publish one.
- **`browser_act` still decides on text.** The screenshot is a check for the caller, not
  an input to the decision layer, so an overlay the text does not describe — an open
  dropdown covering the page, say — can still mislead a step. Read the screenshot before
  authorizing anything consequential.
- **No ZDR.** CommandCode refuses `typesafe/jev` when `x-cmd-zdr: 1` is set, because
  the decision model has no zero-data-retention upstream.
- **Decision quality is Jev's.** On dense pages it may scroll where a human would
  click a section link, and it can exhaust the step budget. The trace and
  probabilities are returned so the caller can judge and continue rather than
  trust the outcome blindly.
- **Text is caller-supplied.** Multi-field forms need one `browser_act` call per
  literal value; the decision layer cannot compose or vary text.
- **A login lives in a profile.** It cannot be moved between browsers. `profileDir` keeps
  one, and `browser_open({ cdp })` borrows a browser that already has one; copying cookies
  out of the user's personal browser profile is not something this plugin does.
