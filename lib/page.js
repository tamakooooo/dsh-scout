/**
 * Page-level operations: evaluate in the renderer, navigate, read a bounded page
 * state, and perform one decided action.
 *
 * The two browser-side functions below are serialized with `Function.prototype.toString`
 * and evaluated in the page, so they must stay self-contained: no imports, no closure
 * references, and no helper defined outside their own body. Their non-null assertions
 * are the reason each one re-derives everything it needs from the DOM.
 *
 * @module @local/dsh-jev-browser/lib/page
 */

import { sleep } from './browser.js';

/**
 * Evaluate one expression in the page and return its value.
 * @param cdp - the browser-level client.
 * @param sessionId - the flat session id of the target.
 * @param expression - the expression to evaluate; `awaitPromise` is on.
 * @param options - evaluation timeout.
 * @returns the deserialized value.
 */
export async function evaluate(cdp, sessionId, expression, { timeoutMs = 20000 } = {}) {
  const outcome = await cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true, userGesture: true },
    sessionId,
    timeoutMs,
  );
  if (outcome.exceptionDetails) {
    const description = outcome.exceptionDetails.exception?.description ?? outcome.exceptionDetails.text ?? 'unknown error';
    throw new Error(`page evaluation failed: ${String(description).split('\n')[0].slice(0, 400)}`);
  }
  return outcome.result ? outcome.result.value : undefined;
}

/**
 * Turn loose user or model input into an absolute URL.
 * @param input - a full URL, a bare host, or `localhost:port`.
 * @returns the absolute URL.
 */
export function normalizeUrl(input) {
  const value = String(input ?? '').trim();
  if (!value) throw new Error('url is required');
  if (/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?([/?#]|$)/i.test(value)) return `http://${value}`;
  if (/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\]):\d+(?:[/?#]|$)/i.test(value)) return `https://${value}`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  return `https://${value}`;
}

/** Read `document.readyState`, tolerating a renderer that is mid-navigation. */
async function readReadyState(cdp, sessionId) {
  try {
    return await evaluate(cdp, sessionId, 'document.readyState', { timeoutMs: 5000 });
  } catch {
    return null;
  }
}

/**
 * Wait for the page to settle. Never throws: an SPA that never reports `complete`
 * is still usable, and the caller re-snapshots anyway.
 * @returns the last observed readyState.
 */
export async function waitForReady(cdp, sessionId, timeoutMs = 20000, { settleMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let state = null;
  while (Date.now() < deadline) {
    state = await readReadyState(cdp, sessionId);
    if (state === 'complete') break;
    await sleep(150);
  }
  // The settle exists for a document that has just loaded. Asking for it again on a page that
  // has not changed since the last read is pure latency, and the caller is the only one who
  // knows which case it is: a navigation or a fresh tab wants it, the top of a step after an
  // action does not — the action's own navigation window already paused for the same reason.
  if (settleMs > 0) await sleep(settleMs);
  return state;
}

/**
 * Navigate the target and wait for the new document to finish loading.
 *
 * Waiting on `readyState` alone is wrong here, and the failure is silent: the *old*
 * document is still `complete`, so a poll returns instantly while the previous page — or
 * `about:blank`, for a target that was just created — is still on screen. The load event
 * is the signal that the new document committed, and it is filtered by `sessionId`
 * because a browser with several tabs fires this event for all of them.
 *
 * @returns the observed readyState.
 */
export async function navigate(cdp, sessionId, url, { timeoutMs = 25000 } = {}) {
  const settled = new Promise((resolve) => {
    const timer = setTimeout(() => {
      off();
      resolve();
    }, timeoutMs);
    const off = cdp.on('Page.loadEventFired', (_params, eventSessionId) => {
      if (eventSessionId !== sessionId) return;
      clearTimeout(timer);
      off();
      resolve();
    });
  });
  await cdp.send('Page.navigate', { url: normalizeUrl(url) }, sessionId, timeoutMs);
  await settled;
  return waitForReady(cdp, sessionId, 8000);
}

/**
 * Read a bounded, model-readable description of the current page.
 *
 * Every interactive element that survives the visibility filter is stamped with a
 * `data-dsh-jev-ref` attribute (`e1`, `e2`, …). Those refs are the entire action target
 * vocabulary: the decision layer only ever chooses among them, so it can never invent
 * a selector, and a ref that no longer resolves fails loudly instead of clicking
 * something unintended.
 *
 * @param cdp - the browser-level client.
 * @param sessionId - the flat session id of the target.
/**
 * Action words that act on *the record they sit in*, so they are qualified with that
 * record even when this particular snapshot happens to hold only one of them.
 *
 * Duplicate detection alone is not enough, and that is not a detail: it only sees the
 * elements this call collected, so a small `maxElements` cuts the other cards' "打招呼"
 * buttons out of the sample, the surviving label looks unique, and the same button is
 * labelled differently depending on the budget. Labels have to be independent of how
 * many elements were sampled.
 *
 * The list is deliberately narrow — per-record actions only, not generic UI words. A
 * wider list was tried and produced a false prefix: the top navigation's "更多" was
 * qualified with the signed-in user's name from the page header, reading
 * "王先生 · 更多". A wrong record is worse than no record, so "更多", "查看", "提交",
 * "下一页" and friends are left alone; a bare "更多" misleads nobody.
 */
export const PER_RECORD_ACTION_LABELS = [
  '打招呼',
  '立即沟通',
  '发起沟通',
  '沟通',
  '打电话',
  '拨打电话',
  '联系',
  '发送',
  '发送消息',
  '邀请',
  '邀约',
  '投递',
  '收藏',
  '关注',
  '下载简历',
  '查看简历',
  '面试',
  '录用',
  'greet',
  'contact',
  'call',
  'message',
  'invite',
  'apply',
  'favorite',
  'favourite',
];

/**
 * @param options - element and text budgets, plus the per-record action vocabulary.
 * @returns the page state, or `null` when the evaluation returned nothing.
 */
export async function snapshot(
  cdp,
  sessionId,
  { maxElements = 60, maxStateChars = 6000, perRecordActions = PER_RECORD_ACTION_LABELS, riskPatternSource = '' } = {},
) {
  const expression = `(${snapshotImpl.toString()})(${JSON.stringify(maxElements)},${JSON.stringify(maxStateChars)},${JSON.stringify(perRecordActions)},${JSON.stringify(riskPatternSource)})`;
  const value = await evaluate(cdp, sessionId, expression, { timeoutMs: 30000 });
  return value && typeof value === 'object' ? value : null;
}

/**
 * Collect a bounded structural view of the page, for learning a site configuration.
 *
 * @param cdp - the browser-level client.
 * @param sessionId - the flat session id of the target.
 * @param options - the budgets. Every one is a hard cap, because a recruiting list runs to
 *   tens of thousands of tokens and "as complete as possible" is not an option.
 * @returns the sample, or `null` when the evaluation returned nothing.
 */
export async function inspect(cdp, sessionId, budgets = {}) {
  const resolved = {
    depth: budgets.depth ?? 6,
    nodes: budgets.nodes ?? 120,
    attributes: budgets.attributes ?? 5,
    sample: budgets.sample ?? 20,
    characters: budgets.characters ?? 12000,
  };
  const expression = `(${inspectImpl.toString()})(${JSON.stringify(resolved)})`;
  const value = await evaluate(cdp, sessionId, expression, { timeoutMs: 30000 });
  return value && typeof value === 'object' ? value : null;
}

/**
 * Capture the page as a base64 PNG.
 *
 * @param cdp - the browser-level client.
 * @param sessionId - the flat session id of the target.
 * @param options - `fullPage` captures beyond the viewport; the default is what the user
 *   can actually see, which is also the smaller and cheaper image.
 * @returns the base64-encoded PNG.
 */
export async function captureScreenshot(cdp, sessionId, { fullPage = false, timeoutMs = 30000 } = {}) {
  const result = await cdp.send(
    'Page.captureScreenshot',
    { format: 'png', fromSurface: true, captureBeyondViewport: fullPage === true },
    sessionId,
    timeoutMs,
  );
  const data = result?.data;
  if (typeof data !== 'string' || data === '') throw new Error('the browser returned no screenshot data');
  return data;
}

/**
 * Perform one already-decided action.
 * @param action - one of `click`, `type`, `press_enter`, `scroll_down`, `scroll_up`, `back`, `wait`.
 * @param ref - the chosen element ref, for actions that take one.
 * @param text - literal text for `type`; the decision layer never authors text.
 * @returns `{ ok, message }`.
 */
export async function perform(cdp, sessionId, action, ref, text) {
  if (action === 'wait') {
    await sleep(700);
    return { ok: true, message: 'waited for the page to change' };
  }
  const execute = async () => {
    const expression = `(${actionImpl.toString()})(${JSON.stringify(action)},${JSON.stringify(ref ?? null)},${JSON.stringify(text ?? null)})`;
    const value = await evaluate(cdp, sessionId, expression, { timeoutMs: 25000 });
    if (value && typeof value === 'object' && typeof value.ok === 'boolean') {
      if (action === 'press_enter' && value.ok) {
        await cdp.send('Input.dispatchKeyEvent', {
          type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r',
        }, sessionId);
        await cdp.send('Input.dispatchKeyEvent', {
          type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
        }, sessionId);
        return { ok: true, message: 'pressed Enter on the chosen element' };
      }
      return value;
    }
    return { ok: false, message: 'the page returned no result for this action' };
  };
  if (action === 'click' || action === 'press_enter' || action === 'back') {
    return withActionNavigation(cdp, sessionId, execute);
  }
  return execute();
}

/** Observe the new navigation, since the outgoing document can still report complete. */
async function withActionNavigation(cdp, sessionId, execute) {
  const { frameTree } = await cdp.send('Page.getFrameTree', {}, sessionId);
  const frameId = frameTree.frame.id;
  let started = false;
  let resolveSettled;
  const settled = new Promise((resolve) => { resolveSettled = resolve; });
  const start = (params, eventSessionId) => {
    if (eventSessionId === sessionId && params.frameId === frameId) started = true;
  };
  const off = [
    cdp.on('Page.frameStartedNavigating', start),
    cdp.on('Page.frameStartedLoading', start),
    cdp.on('Page.frameStoppedLoading', (params, eventSessionId) => {
      if (started && eventSessionId === sessionId && params.frameId === frameId) resolveSettled();
    }),
    cdp.on('Page.loadEventFired', (_params, eventSessionId) => {
      if (started && eventSessionId === sessionId) resolveSettled();
    }),
  ];
  let timer;
  try {
    const outcome = await execute();
    if (outcome.ok) {
      // The start event can follow the evaluation response by a few milliseconds.
      await sleep(150);
      if (started) {
        await Promise.race([
          settled,
          new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('the action navigation did not settle within 25000ms')), 25000);
          }),
        ]);
      }
    }
    return outcome;
  } finally {
    clearTimeout(timer);
    for (const unsubscribe of off) unsubscribe();
  }
}

/** Browser-side page reader. Serialized into the renderer; keep it self-contained. */
function snapshotImpl(maxElements, maxTextChars, perRecordActions, riskPatternSource) {
  var REF = 'data-dsh-jev-ref';
  // Action words that always want their record attached, regardless of what this
  // particular sample happened to contain.
  var perRecord = {};
  for (var g = 0; g < (perRecordActions || []).length; g++) perRecord[String(perRecordActions[g]).toLowerCase()] = true;
  var stale = document.querySelectorAll('[' + REF + ']');
  for (var s = 0; s < stale.length; s++) stale[s].removeAttribute(REF);

  var SELECTOR = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    'summary',
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="option"]',
    '[role="combobox"]',
    '[role="searchbox"]',
    '[role="textbox"]',
    '[contenteditable="true"]',
    '[onclick]'
  ].join(',');

  var boundsCache = new WeakMap();
  function visibleBounds(el) {
    if (!el) return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    if (boundsCache.has(el)) return boundsCache.get(el);
    var inherited = visibleBounds(el.parentElement);
    var bounds = { left: inherited.left, top: inherited.top, right: inherited.right, bottom: inherited.bottom };
    var style = window.getComputedStyle(el);
    var rect = el.getBoundingClientRect();
    if (/^(auto|scroll|hidden|clip)$/.test(style.overflowX)) {
      bounds.left = Math.max(bounds.left, rect.left + el.clientLeft);
      bounds.right = Math.min(bounds.right, rect.left + el.clientLeft + el.clientWidth);
    }
    if (/^(auto|scroll|hidden|clip)$/.test(style.overflowY)) {
      bounds.top = Math.max(bounds.top, rect.top + el.clientTop);
      bounds.bottom = Math.min(bounds.bottom, rect.top + el.clientTop + el.clientHeight);
    }
    boundsCache.set(el, bounds);
    return bounds;
  }

  function intersects(rect, bounds) {
    return bounds.right > bounds.left && bounds.bottom > bounds.top &&
      rect.width > 0 && rect.height > 0 && rect.bottom > bounds.top && rect.right > bounds.left &&
      rect.top < bounds.bottom && rect.left < bounds.right;
  }

  function isVisible(el) {
    if (!el.isConnected) return false;
    if (el.closest('[aria-hidden="true"]')) return false;
    var style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (style.opacity !== '' && Number(style.opacity) === 0) return false;
    var rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    return intersects(rect, visibleBounds(el.parentElement));
  }
  /**
   * Whether an element is the one a click at its own centre would actually reach.
   *
   * Visibility is not reachability. An open dropdown covers whatever sits under it, and
   * the covered elements are still perfectly "visible" — sized, opaque, rendered. That
   * difference only exists in geometry, and a text-only state cannot express it: the
   * decision layer sees the card's button in the list, has no way to know a menu is on
   * top of it, and picks it. Measured, not guessed.
   */
  function isCovered(el) {
    try {
      var rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return false;
      var x = rect.left + rect.width / 2;
      var y = rect.top + rect.height / 2;
      // Off-screen is a different problem with a different fix (scroll), so it is not
      // reported as coverage.
      if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false;
      var top = document.elementFromPoint(x, y);
      if (!top) return false;
      return !(el === top || el.contains(top) || top.contains(el));
    } catch (error) {
      return false;
    }
  }

  /**
   * Whether an element is marked as the current one, and how that was decided.
   *
   * Where the *active* tab is lives in styling, not in text: six job names read exactly
   * alike and only the class `job-pane__item--active` says which one is selected. Without
   * this the decision layer is asked "which job are you looking at" and can only guess —
   * and it guessed wrong on a real page.
   *
   * ARIA wins when present, because it is a declaration rather than a styling habit.
   * Otherwise class tokens are matched whole, so `container` is never read as `on`, and
   * the BEM modifier shapes (`--active`, `_active`, `is-active`) are accepted. The walk
   * covers the common `<li class="active"><a>…</a></li>` shape, bounded so a selected
   * ancestor cannot claim everything below it.
   *
   * @returns `selected` or an empty string.
   */
  function selectedStateOf(el) {
    if (el.getAttribute('aria-selected') === 'true') return 'selected';
    if (el.getAttribute('aria-checked') === 'true') return 'selected';
    var current = el.getAttribute('aria-current');
    if (current && current !== 'false') return 'selected';
    var node = el;
    for (var depth = 0; node && depth < 3; depth++) {
      if (hasSelectedClass(node)) return 'selected';
      node = node.parentElement;
    }
    return '';
  }

  /** Whole-token test for the class conventions that mean "this one is current". */
  function hasSelectedClass(el) {
    var cls = el.className;
    if (typeof cls !== 'string' || cls === '') return false;
    var tokens = cls.split(/\s+/);
    for (var i = 0; i < tokens.length; i++) {
      var token = tokens[i].toLowerCase();
      if (token === '') continue;
      if (token === 'active' || token === 'selected' || token === 'current' || token === 'checked' || token === 'cur') return true;
      // A suffix only counts behind a separator, so `inactive` and `unselected` do not.
      if (/(^|[-_])active$|(^|[-_])selected$|(^|[-_])current$|(^|[-_])checked$/.test(token)) return true;
    }
    return false;
  }


  function textOf(node) {
    return String(node == null ? '' : node).replace(/\s+/g, ' ').trim();
  }

  function labelOf(el) {
    var label =
      el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      el.getAttribute('placeholder') ||
      el.getAttribute('alt') ||
      '';
    var tag = el.tagName.toLowerCase();
    if (!label && tag === 'input') {
      var type = String(el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset') {
        label = el.value || '';
      } else {
        var labelled = null;
        try {
          if (el.id && window.CSS && window.CSS.escape) labelled = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        } catch (error) {
          labelled = null;
        }
        if (!labelled) labelled = el.closest('label');
        if (labelled) label = textOf(labelled.innerText || labelled.textContent);
        if (!label) {
          // A radio or checkbox group's `name` is usually a generated token such as
          // "rg-04khvrdsa". That is noise dressed as a label, so it is rejected here and
          // the element falls through to a record context instead.
          var nameAttribute = textOf(el.getAttribute('name'));
          if (nameAttribute && !/^[a-z0-9_-]{8,}$/i.test(nameAttribute)) label = nameAttribute;
        }
      }
    }
    if (!label && tag === 'select') {
      var option = el.options && el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
      label = option ? textOf(option.text) : '';
    }
    if (!label) label = textOf(el.innerText || el.textContent);
    return label.slice(0, 120);
  }

  function roleOf(el) {
    var explicit = el.getAttribute('role');
    if (explicit) return explicit;
    var tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'summary') return 'disclosure';
    if (tag === 'input') {
      var type = String(el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return tag;
  }

  function valueOf(el) {
    var tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      var type = String(el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'password') return el.value ? '(hidden)' : '';
      if (type === 'checkbox' || type === 'radio') return el.checked ? 'checked' : 'unchecked';
      return textOf(el.value).slice(0, 80);
    }
    if (tag === 'select') {
      var option = el.options && el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
      return option ? textOf(option.text).slice(0, 80) : '';
    }
    if (tag === 'textarea') return textOf(el.value).slice(0, 80);
    if (el.isContentEditable) return textOf(el.innerText).slice(0, 80);
    return '';
  }

  /**
   * Semantics for an icon-only control: an accessible name on a descendant, an SVG
   * sprite id (`<use href="#icon-phone">`), or a keyword in the class/id. Without this
   * an icon button reads as "(no label)" and the decision layer cannot tell it apart
   * from the icon buttons beside it.
   */
  function semanticsOf(el) {
    var labelled = el.querySelector('[aria-label], [title]');
    if (labelled) {
      var accessible = labelled.getAttribute('aria-label') || labelled.getAttribute('title');
      if (accessible) return textOf(accessible).slice(0, 40);
    }
    var use = el.querySelector('use');
    if (use) {
      var sprite = use.getAttribute('href') || use.getAttribute('xlink:href') || '';
      var spriteId = /#([^#/]+)$/.exec(sprite);
      if (spriteId) return textOf(spriteId[1].replace(/^(icon|ico)[-_]?/i, '').replace(/[-_]+/g, ' ')).slice(0, 40);
    }
    var classAndId = '';
    try {
      classAndId =
        (typeof el.className === 'string' ? el.className : '') + ' ' + (el.id || '') + ' ' + (el.getAttribute('data-testid') || '');
    } catch (error) {
      classAndId = '';
    }
    // Only an explicit `icon-*` segment is trusted here. A wider keyword scan over the
    // class list looks helpful and is not: a button on a resume card carries classes
    // like `resume-button`/`resume-action`, which name the component family rather than
    // the action, and inferring "resume" from them produced a label that looked
    // informative while being identical on every one of the card's buttons.
    var iconSegment = /(?:^|[\s_-])icon[-_]?([a-z]{3,})/i.exec(classAndId);
    if (!iconSegment) return '';
    var iconName = textOf(iconSegment[1]).toLowerCase();
    // `icon-btn`, `icon-wrap`, `icon-left` name a slot or a direction, not an action, so
    // they are rejected for the same reason `resume-button` was.
    var generic = /^(btn|button|icon|ico|img|image|wrap|wrapper|box|container|slot|left|right|up|down|prev|next|close|open|more|default|primary|secondary|small|large)$/;
    return generic.test(iconName) ? '' : iconName.slice(0, 40);
  }

  /**
   * A second, coarser handle on a record, for when the name alone is not unique.
   *
   * Two candidates can share a surname — a real page held three 王先生 — and then a
   * name-qualified label is still ambiguous. Age is the first thing a recruiting card
   * states and the first thing a human uses to tell two 王先生 apart, so that is tried
   * first, then years of experience. It is only ever *appended*, and only for labels
   * that would otherwise collide, so unambiguous pages keep their short labels.
   */
  function discriminatorIn(scope) {
    var text = String(scope.textContent == null ? '' : scope.textContent).slice(0, 400);
    var age = /(\d{2,3})\s*岁/.exec(text);
    if (age) return age[1] + '岁';
    var years = /(\d{1,2})\s*年(?:经验|工作)?/.exec(text);
    if (years) return years[1] + '年';
    return '';
  }

  /**
   * The record an element belongs to: walk up until an ancestor holds a small number
   * of other controls, then take that record's identifying text. Repeated cards are
   * the reason this exists — ten identical "打招呼" buttons become distinguishable
   * only once each carries its candidate's name.
   *
   * @returns `{ name, discriminator }`; either may be empty.
   */
  function recordContext(el) {
    var NAME_SELECTOR = '[class*="name" i], [class*="title" i], [itemprop="name"], h1, h2, h3, h4, h5, strong, b';
    var node = el.parentElement;
    var fallback = '';
    // Ten levels, not six. A real card puts its name well above the button: one live
    // candidate card wrapped the greeting button in three extra divs, so the name sat at
    // the seventh ancestor while the phone button — three divs shallower — found it at
    // the fourth. The control-count window is what keeps this honest, not the depth.
    for (var depth = 0; node && node !== document.body && depth < 10; depth++) {
      var controls = 0;
      try {
        controls = node.querySelectorAll(SELECTOR).length;
      } catch (error) {
        controls = 0;
      }
      if (controls >= 2 && controls <= 14) {
        var named = shortestName(node, NAME_SELECTOR);
        if (named) return { name: named, discriminator: discriminatorIn(node) };
        if (!fallback) {
          var head = String(node.textContent == null ? '' : node.textContent).slice(0, 300);
          var text = textOf(head);
          // A record carries more than its own controls; a bare button bar does not.
          if (text.length >= 40) fallback = (text.split(/[\n·|]/)[0] || '').trim();
        }
      }
      node = node.parentElement;
    }
    return { name: fallback.slice(0, 32), discriminator: '' };
  }

  /**
   * The most identifying short label inside a record.
   *
   * "Exactly one name element" is the wrong test: a real card nests several. A live
   * candidate card carried eleven matches — `talent-basic-info__name`,
   * `talent-basic-info__name--inner`, a title, plus company and job names — so an
   * exactly-one rule never fired. Among them the innermost name is the short one, so
   * the rule is: prefer a class or id that says "name", then take the shortest text.
   */
  function shortestName(scope, selector) {
    var matches;
    try {
      matches = scope.querySelectorAll(selector);
    } catch (error) {
      return '';
    }
    var best = '';
    var bestNamed = '';
    for (var i = 0; i < matches.length; i++) {
      var text = textOf(matches[i].textContent);
      // A name is short; a paragraph, a badge, or the whole record is not.
      if (text.length < 2 || text.length > 24) continue;
      if (!best || text.length < best.length) best = text;
      var marker = '';
      try {
        marker = (typeof matches[i].className === 'string' ? matches[i].className : '') + ' ' + (matches[i].id || '');
      } catch (error) {
        marker = '';
      }
      if (/name/i.test(marker) && (!bestNamed || text.length < bestNamed.length)) bestNamed = text;
    }
    return (bestNamed || best).slice(0, 32);
  }

  var candidates = [];
  try {
    candidates = Array.prototype.slice.call(document.querySelectorAll(SELECTOR));
  } catch (error) {
    candidates = [];
  }

  /**
   * Whether a button is a nested duplicate of an enclosing button.
   *
   * The employer console renders each card action as `<button class="resume-btn-small">`
   * wrapping the icon as `<button class="resume-btn-small__icon">` — BEM block and its
   * element, one action drawn twice. Left in, the inner copy is a second target for the
   * same click, and, worse, it is a *silently* different target: it carries no text, so
   * its label is positional ("… · button #2") and the confirmation gate matches on
   * labels. Clicking that ref really does greet the candidate, while the gate sees a
   * label with no consequential word in it and lets the action through.
   *
   * `<button>` inside `<button>` is invalid HTML and the click bubbles to the outer one,
   * so the inner copy is always redundant. The same shape is *not* dropped for a link:
   * `<a>` wrapping a button is the ordinary "card with its own delete action" pattern,
   * where the inner control is a genuinely different target.
   */
  function isRedundantNestedButton(el) {
    if (el.tagName !== 'BUTTON') return false;
    var enclosing = el.parentElement ? el.parentElement.closest('button') : null;
    return enclosing !== null && enclosing !== el;
  }

  // Offscreen controls may precede the entire viewport after a long scroll.
  var scanLimit = candidates.length;
  var collected = [];
  var seen = [];
  var visibleCount = 0;
  for (var c = 0; c < scanLimit; c++) {
    var el = candidates[c];
    if (!isVisible(el)) continue;
    if (el.disabled) continue;
    if (seen.indexOf(el) !== -1) continue;
    if (isRedundantNestedButton(el)) continue;
    seen.push(el);
    visibleCount++;
    if (collected.length >= maxElements) continue;
    collected.push({ el: el, label: labelOf(el) });
  }

  // Second pass: only ambiguous labels pay for a context lookup, so navigation links
  // and one-off controls keep their own text, while repeated card actions gain the
  // record they belong to ("徐先生 · 打招呼" instead of the seventh "打招呼").
  var labelCounts = {};
  for (var li = 0; li < collected.length; li++) {
    var key = collected[li].label || '(no label)';
    labelCounts[key] = (labelCounts[key] || 0) + 1;
  }

  /** Compose one label, optionally borrowing the record's discriminator. */
  function composeLabel(draft, withDiscriminator) {
    var head = draft.name ? draft.name + (withDiscriminator && draft.discriminator ? ' ' + draft.discriminator : '') : '';
    if (head && draft.semantic) return head + ' · ' + draft.semantic;
    if (head) return head + ' · button';
    if (draft.semantic) return draft.semantic;
    return draft.base || '(no label)';
  }

  function tally(list) {
    var counts = {};
    for (var i = 0; i < list.length; i++) counts[list[i]] = (counts[list[i]] || 0) + 1;
    return counts;
  }

  // Sub-pass 1: give every ambiguous element its record.
  var drafted = [];
  for (var di = 0; di < collected.length; di++) {
    var draftEntry = collected[di];
    // Ambiguous when it has no label, when the sample shows a repeat, or when it is a
    // per-record action whose siblings may simply have been cut off by the budget.
    var ambiguous =
      draftEntry.label === '' ||
      labelCounts[draftEntry.label] > 1 ||
      perRecord[String(draftEntry.label).toLowerCase()] === true;
    var semantic = draftEntry.label || (ambiguous ? semanticsOf(draftEntry.el) : '');
    var context = ambiguous ? recordContext(draftEntry.el) : { name: '', discriminator: '' };
    drafted.push({
      el: draftEntry.el,
      base: draftEntry.label,
      semantic: semantic,
      name: context.name,
      discriminator: context.discriminator,
    });
  }

  // Sub-pass 2: only a label that is *still* shared borrows the discriminator, so a page
  // whose candidates are all distinct keeps short labels like "饶先生 · 打招呼".
  var withoutDiscriminator = drafted.map(function (draft) {
    return composeLabel(draft, false);
  });
  var sharedLabels = tally(withoutDiscriminator);
  var labels = drafted.map(function (draft, index) {
    return sharedLabels[withoutDiscriminator[index]] > 1 ? composeLabel(draft, true) : withoutDiscriminator[index];
  });

  // Sub-pass 3: whatever is still identical is made addressable by document order.
  //
  // Two icon-only buttons inside one card carry no text, no accessible name, and no
  // sprite, so after the candidate and the age there is genuinely nothing left to tell
  // them apart. Position is the only honest handle, and "#2" says exactly that — the
  // second of these — rather than inventing a meaning. It also keeps labels unique,
  // which is what the confirmation gate compares.
  var finalCounts = tally(labels);
  var ordinals = {};
  var finalLabels = labels.map(function (label) {
    // "(no label)" is a statement of fact, not a name. Numbering it would dress it up as
    // a label while adding no information, so it is left to repeat as what it is.
    if (label === '(no label)' || finalCounts[label] <= 1) return label;
    ordinals[label] = (ordinals[label] || 0) + 1;
    return label + ' #' + ordinals[label];
  });

  /**
   * Every element the document currently marks as the selected one.
   *
   * Scanning the document rather than the collected elements is the whole point: the
   * active job on the employer console is a `<div>` with no interactive role, so it never
   * enters the element list at all and a per-element marker could not reach it. The answer
   * to "which job am I looking at" lives only in a class name, and the only reliable way
   * to surface it is to go and look.
   *
   * Pre-filtered by attribute selector so the full-document scan stays cheap, then judged
   * by {@link hasSelectedClass} so `inactive` is not read as `active`.
   *
   * @returns up to `limit` short labels, in document order.
   */
  function selectedLabels(limit) {
    var found = [];
    var seen = {};
    // `--active` means two different things on a real page. On a tab it means "the choice
    // the user made"; on a carousel it means "the frame currently on screen", which is
    // automatic and is not a selection at all. Judging by the marker alone reported a
    // rotating promo banner as something the user had chosen, so the rotator is named and
    // excluded — a categorised false positive, not a length cutoff that would also drop
    // the genuinely long job titles.
    var NOT_A_CHOICE = /(carousel|swiper|slider|slide|banner|marquee|rotator)/i;
    var nodes;
    try {
      nodes = document.querySelectorAll(
        '[aria-selected="true"], [aria-current]:not([aria-current="false"]), [aria-checked="true"],' +
          '[class*="active" i], [class*="selected" i], [class*="current" i], [class*="checked" i]',
      );
    } catch (error) {
      return found;
    }
    for (var i = 0; i < nodes.length && found.length < limit; i++) {
      var el = nodes[i];
      if (NOT_A_CHOICE.test(String(el.className == null ? '' : el.className))) continue;
      if (!hasSelectedClass(el) && el.getAttribute('aria-selected') !== 'true' &&
          el.getAttribute('aria-checked') !== 'true' &&
          !(el.getAttribute('aria-current') && el.getAttribute('aria-current') !== 'false')) {
        continue;
      }
      if (!isVisible(el)) continue;
      // The label a reader would use, and only that: an element whose text is a whole
      // section is a container that happens to be marked, not a current choice.
      var text = textOf(el.innerText || el.textContent);
      if (!text || text.length > 24) continue;
      if (seen[text]) continue;
      seen[text] = true;
      found.push(text);
    }
    return found;
  }

  var elements = [];
  for (var idx = 0; idx < drafted.length; idx++) {
    var draft = drafted[idx];
    var label = finalLabels[idx] || '(no label)';
    // Two facts about an element exist only in geometry and styling, so they are appended
    // rather than left for the decision layer to infer — and they are appended *after* the
    // uniqueness passes, so they can never affect how a label was resolved.
    //
    // The suffixes are protected from the length cut. Truncating the composed label at the
    // end would silently strip the `#n` that makes a duplicated action addressable and the
    // markers that say whether it is the current choice or even reachable — so the stem is
    // cut to fit and the suffixes are always kept whole.
    var ordinalMatch = / #\d+$/.exec(label);
    var ordinal = ordinalMatch ? ordinalMatch[0] : '';
    var stem = ordinal === '' ? label : label.slice(0, label.length - ordinal.length);
    var marks = [];
    if (selectedStateOf(draft.el)) marks.push('selected');
    if (isCovered(draft.el)) marks.push('covered');
    var suffix = marks.length > 0 ? ' [' + marks.join(', ') + ']' : '';
    var keep = Math.max(1, 120 - ordinal.length - suffix.length);
    label = stem.slice(0, keep) + ordinal + suffix;
    var ref = 'e' + (elements.length + 1);
    draft.el.setAttribute(REF, ref);
    elements.push({
      ref: ref,
      role: roleOf(draft.el),
      tag: draft.el.tagName.toLowerCase(),
      label: label,
      value: valueOf(draft.el),
      href: draft.el.tagName.toLowerCase() === 'a' ? String(draft.el.href || '').slice(0, 200) : ''
    });
  }

  var bodyText = '';
  try {
    // innerText describes the entire document, including content above the viewport.
    // Use rendered text ranges so a scroll reveals the matching text as well as targets.
    var walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    var range = document.createRange();
    var chunks = [];
    var textLength = 0;
    var textBounds;
    var shownCache = new WeakMap();
    function shown(el) {
      if (!el) return true;
      if (shownCache.has(el)) return shownCache.get(el);
      var style = window.getComputedStyle(el);
      var result = style.display !== 'none' && style.visibility !== 'hidden' &&
        style.visibility !== 'collapse' && Number(style.opacity) !== 0 && shown(el.parentElement);
      shownCache.set(el, result);
      return result;
    }
    function inViewport(rect) {
      return intersects(rect, textBounds);
    }
    function appendText(value) {
      value = value.replace(/\s+/g, ' ').trim();
      if (!value) return;
      var separatorLength = chunks.length ? 1 : 0;
      var remaining = maxTextChars + 1 - textLength - separatorLength;
      var chunk = value.slice(0, Math.max(0, remaining));
      chunks.push(chunk);
      textLength += chunk.length + separatorLength;
    }
    var node;
    while (textLength <= maxTextChars && (node = walker.nextNode())) {
      var parent = node.parentElement;
      if (!parent || !node.nodeValue.trim() ||
          parent.closest('script,style,noscript,template,[aria-hidden="true"]') || !shown(parent)) continue;
      textBounds = visibleBounds(parent);
      range.selectNodeContents(node);
      var rects = Array.from(range.getClientRects());
      if (!rects.some(inViewport)) continue;
      if (rects.every(inViewport)) {
        appendText(node.nodeValue);
        continue;
      }
      // A single text node can span many lines. Sample short ranges rather than
      // including its off-screen prefix (including long unspaced CJK paragraphs).
      var visible = '';
      for (var offset = 0; offset < node.length; offset += 32) {
        range.setStart(node, offset);
        range.setEnd(node, Math.min(node.length, offset + 32));
        if (Array.from(range.getClientRects()).some(inViewport)) {
          visible += node.nodeValue.slice(offset, offset + 32);
          if (visible.length + textLength > maxTextChars) break;
        }
      }
      appendText(visible);
    }
    range.detach();
    bodyText = chunks.join('\n');
  } catch (error) {
    bodyText = '';
  }
  bodyText = bodyText.replace(/[ \t\u00a0]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
  // The risk match runs here, in the page, over the *whole* document — deliberately not
  // over `bodyText`. That text is filtered to what is currently rendered, because the
  // decision layer should see what a person sees; but a verification wall is exactly the
  // kind of thing that sits below the fold or inside a container the viewport clip hides,
  // and the risk control must never miss one. Over-matching costs a human a glance;
  // under-matching means the agent tries to work around a captcha.
  var riskSignal = '';
  if (typeof riskPatternSource === 'string' && riskPatternSource !== '') {
    try {
      var riskHaystack = (document.title || '') + '\n' + (document.body ? String(document.body.textContent || '') : '');
      var matched = new RegExp(riskPatternSource, 'i').exec(riskHaystack.slice(0, 400000));
      if (matched) riskSignal = String(matched[0]).slice(0, 120);
    } catch (error) {
      riskSignal = '';
    }
  }
  var textTruncated = bodyText.length > maxTextChars;
  if (textTruncated) bodyText = bodyText.slice(0, maxTextChars);

  var doc = document.documentElement;
  var scrollMax = Math.max(0, (doc ? doc.scrollHeight : 0) - window.innerHeight);

  return {
    url: location.href,
    title: document.title || '',
    readyState: document.readyState,
    text: bodyText,
    textTruncated: textTruncated,
    riskSignal: riskSignal,
    selected: selectedLabels(5),
    elements: elements,
    elementsTruncated: visibleCount > elements.length || candidates.length > scanLimit,
    candidateCount: candidates.length,
    scroll: { y: Math.round(window.scrollY || 0), max: Math.round(scrollMax) }
  };
}

/** Browser-side action executor. Serialized into the renderer; keep it self-contained. */
/**
 * The page-side half of {@link inspect}.
 *
 * A separate injected function rather than a mode on `snapshotImpl`, and it shares no helpers
 * with it: both are serialized with `toString()` and evaluated inside the page, so a shared
 * helper would have to be inlined into both anyway. A few duplicated lines buy two functions
 * that can be read and changed on their own.
 *
 * What it returns is a **sample under fixed budgets**, never the document. The two outputs
 * that carry the signal are `repeats` on each node and `groups` over the whole page: together
 * they answer "which siblings are the cards", which is the question a flat snapshot cannot
 * answer and the reason this exists.
 */
function inspectImpl(budgets) {
  var depthLimit = budgets.depth;
  var nodeLimit = budgets.nodes;
  var attrLimit = budgets.attributes;
  var sampleLimit = budgets.sample;
  var charLimit = budgets.characters;

  // A token carrying four digits in a row, or a hex-ish suffix, is generated by the build and
  // changes on every deploy. Anchoring on one is how a learned configuration dies silently.
  var HASHY = /(?:\d{4,}|[_\-][0-9a-f]{6,}|[0-9a-f]{8,})/i;

  function isVisible(el) {
    if (el === document.body) return true;
    var rect;
    try { rect = el.getBoundingClientRect(); } catch (e) { return false; }
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    var style = window.getComputedStyle(el);
    if (!style) return true;
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  function stableTokens(value) {
    return String(value || '').split(/\s+/).filter(function (t) { return t !== '' && !HASHY.test(t); });
  }

  function signature(el) {
    return el.tagName.toLowerCase() + '|' + stableTokens(el.className).sort().join('.');
  }

  function attributesOf(el) {
    var out = [];
    var attrs = el.attributes || [];
    for (var i = 0; i < attrs.length && out.length < attrLimit; i++) {
      var name = attrs[i].name;
      if (name === 'style' || name === 'class') continue;
      var value = String(attrs[i].value == null ? '' : attrs[i].value);
      var stable = name.indexOf('data-') === 0 || name === 'href' || name === 'role' || name === 'type' || name === 'name' || !HASHY.test(value);
      out.push({ name: name, value: value.slice(0, 90), stable: stable });
    }
    // Class tokens are reported separately and only when stable, since an unstable class is
    // noise a caller should not be invited to anchor on.
    var tokens = stableTokens(el.className);
    if (tokens.length > 0 && out.length < attrLimit) {
      out.push({ name: 'class', value: tokens.slice(0, 4).join(' ').slice(0, 90), stable: true });
    }
    return out;
  }

  function textOf(el) {
    var text = '';
    try { text = String(el.innerText || el.textContent || ''); } catch (e) { text = ''; }
    return text.replace(/\s+/g, ' ').trim().slice(0, 40);
  }

  function roleOf(el) {
    var explicit = el.getAttribute ? el.getAttribute('role') : '';
    if (explicit) return explicit;
    var tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : '';
    if (tag === 'button') return 'button';
    if (tag === 'input') return String(el.getAttribute('type') || 'text').toLowerCase();
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    return '';
  }

  function repeatsOf(el) {
    var parent = el.parentElement;
    if (!parent) return 1;
    var want = signature(el);
    var count = 0;
    var kids = parent.children;
    for (var i = 0; i < kids.length; i++) if (signature(kids[i]) === want) count++;
    return count;
  }

  var nodes = [];
  var truncated = false;
  var characters = 0;

  // Breadth-first, so when a budget bites the levels kept are the shallow ones that carry the
  // repeating structure. A leaf with no text is dropped: it costs budget and says nothing.
  var queue = document.body ? [{ el: document.body, depth: 0 }] : [];
  while (queue.length > 0) {
    var item = queue.shift();
    var el = item.el;
    if (nodes.length >= nodeLimit) { truncated = true; break; }
    if (!isVisible(el)) continue;
    var text = textOf(el);
    var childCount = el.children ? el.children.length : 0;
    if (el !== document.body && childCount === 0 && text === '') continue;
    var record = {
      index: nodes.length,
      depth: item.depth,
      tag: el.tagName.toLowerCase(),
      role: roleOf(el),
      text: text,
      attributes: attributesOf(el),
      childCount: childCount,
      repeats: repeatsOf(el),
    };
    var size = JSON.stringify(record).length;
    if (characters + size > charLimit) { truncated = true; break; }
    characters += size;
    nodes.push(record);
    if (item.depth >= depthLimit) {
      if (childCount > 0) truncated = true;
      continue;
    }
    for (var c = 0; c < childCount; c++) queue.push({ el: el.children[c], depth: item.depth + 1 });
  }

  // A second, cheaper pass over a bounded slice of the document, looking only for siblings
  // that repeat. This is what survives a tight node budget: the cards can sit deep in a large
  // page, and the group's shape matters more than its position in the sampled tree.
  var groups = [];
  try {
    var all = document.querySelectorAll('*');
    var limit = Math.min(all.length, 4000);
    var counts = {};
    var examples = {};
    var parents = {};
    for (var i = 0; i < limit; i++) {
      var node = all[i];
      var parent = node.parentElement;
      if (!parent) continue;
      var key = signature(node);
      var sameTag = 0;
      var siblings = parent.children;
      for (var j = 0; j < siblings.length; j++) if (siblings[j].tagName === node.tagName) sameTag++;
      if (sameTag < 3) continue;
      counts[key] = (counts[key] || 0) + 1;
      if (!examples[key]) examples[key] = [];
      var label = textOf(node);
      if (label !== '' && examples[key].length < sampleLimit) examples[key].push(label);
      if (!parents[key]) parents[key] = parent.tagName.toLowerCase() + (stableTokens(parent.className).length ? '.' + stableTokens(parent.className).slice(0, 2).join('.') : '');
    }
    var keys = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
    for (var k = 0; k < keys.length && groups.length < 12; k++) {
      groups.push({ signature: keys[k], count: counts[keys[k]], parent: parents[keys[k]], examples: examples[keys[k]] || [] });
    }
  } catch (e) {
    groups = [];
  }

  var containers = [];
  var dialogs = [];
  try {
    var every = document.querySelectorAll('*');
    var bound = Math.min(every.length, 4000);
    for (var m = 0; m < bound; m++) {
      var candidate = every[m];
      var style = window.getComputedStyle(candidate);
      if (style && (style.overflowY === 'auto' || style.overflowY === 'scroll') && candidate.scrollHeight > candidate.clientHeight + 4) {
        containers.push({ tag: candidate.tagName.toLowerCase(), classes: stableTokens(candidate.className).slice(0, 3).join(' '), scrollHeight: candidate.scrollHeight, clientHeight: candidate.clientHeight });
        if (containers.length >= 5) break;
      }
    }
  } catch (e) { containers = []; }
  try {
    var dialogNodes = document.querySelectorAll('[role="dialog"],[aria-modal="true"],dialog[open]');
    for (var d = 0; d < dialogNodes.length && d < 3; d++) {
      dialogs.push({ tag: dialogNodes[d].tagName.toLowerCase(), text: textOf(dialogNodes[d]) });
    }
  } catch (e) { dialogs = []; }

  return {
    url: String(location.href || ''),
    title: String(document.title || ''),
    snapshotId: 'i' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36),
    budgets: budgets,
    nodes: nodes,
    groups: groups,
    containers: containers,
    dialogs: dialogs,
    nodeCount: nodes.length,
    characters: characters,
    truncated: truncated,
  };
}

function actionImpl(action, ref, text) {
  var REF = 'data-dsh-jev-ref';

  function done(ok, message) {
    return { ok: ok, message: message };
  }

  function find(target) {
    if (!target) return null;
    try {
      return document.querySelector('[' + REF + '="' + target + '"]');
    } catch (error) {
      return null;
    }
  }

  var el = find(ref);

  if (action === 'scroll_down' || action === 'scroll_up') {
    var delta = Math.round(window.innerHeight * 0.9);
    window.scrollBy(0, action === 'scroll_down' ? delta : -delta);
    return done(true, 'scrolled ' + action.slice(7) + ' by ' + delta + 'px');
  }

  if (action === 'back') {
    history.back();
    return done(true, 'went back in history');
  }

  if (action === 'click') {
    if (!el) return done(false, 'the chosen element ref no longer exists');
    el.scrollIntoView({ block: 'center', inline: 'center' });
    var rect = el.getBoundingClientRect();
    var base = {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 0,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2
    };
    var pointer = { pointerId: 1, isPrimary: true, pointerType: 'mouse' };
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({}, base, pointer)));
    } catch (error) {
      /* older engines: the mouse events below still drive the handler */
    }
    el.dispatchEvent(new MouseEvent('mousedown', base));
    try {
      el.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, base, pointer)));
    } catch (error) {
      /* see above */
    }
    el.dispatchEvent(new MouseEvent('mouseup', base));
    if (typeof el.click === 'function') el.click();
    else el.dispatchEvent(new MouseEvent('click', base));
    var name = String(el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    return done(true, 'clicked ' + el.tagName.toLowerCase() + (name ? ' "' + name.slice(0, 60) + '"' : ''));
  }

  if (action === 'type') {
    if (!el) return done(false, 'the chosen element ref no longer exists');
    var payload = text == null ? '' : String(text);
    if (!payload) return done(false, 'this step needs literal text but the call supplied none');
    el.scrollIntoView({ block: 'center' });
    if (el.focus) el.focus();
    if (el.isContentEditable) {
      el.textContent = payload;
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      var descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      if (descriptor && descriptor.set) descriptor.set.call(el, payload);
      else el.value = payload;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      return done(false, 'the chosen element is not an editable field');
    }
    return done(true, 'entered ' + payload.length + ' character(s) into the chosen element');
  }

  if (action === 'press_enter') {
    if (!el) return done(false, 'the chosen element ref no longer exists');
    el.scrollIntoView({ block: 'center' });
    if (el.focus) el.focus();
    if (document.activeElement !== el) return done(false, 'the chosen element cannot receive keyboard focus');
    return done(true, 'focused the chosen element for Enter');
  }

  return done(false, 'unsupported action "' + action + '"');
}
