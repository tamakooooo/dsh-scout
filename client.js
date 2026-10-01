window.__ModuleLoader__.load({
  id: '@local/dsh-jev-browser',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const MOUNT = '/jev-browser';
    const ID = 'jev-browser';

    // ── theme tokens only ──────────────────────────────────────────────────────
    // No literal colors for chrome: the host owns light/dark, and a token that gets
    // renamed degrades appearance instead of breaking the render. No Harness Client
    // package is imported either — they change without notice and a plain-JS plugin has
    // no type check, so a throwing component would blank the whole slot.
    const CSS = [
      '.jev-root{height:100%;display:flex;flex-direction:column;overflow:hidden;color:var(--dsw-alias-label-primary);font-size:13px}',
      '.jev-head{display:flex;align-items:center;gap:8px;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto}',
      '.jev-title{font-weight:600;font-size:14px;margin-right:auto}',
      '.jev-btn{font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:4px 10px;cursor:pointer}',
      '.jev-btn:hover{background:var(--dsw-alias-bg-layer-1)}',
      '.jev-btn[disabled]{opacity:.5;cursor:default}',
      '.jev-btn.primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}',
      '.jev-stats{display:flex;flex-wrap:wrap;gap:6px;padding:8px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto}',
      '.jev-stat{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:4px 8px;min-width:64px}',
      '.jev-stat .k{display:block;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.jev-stat .v{font-weight:600;font-variant-numeric:tabular-nums}',
      '.jev-stat.ok .v{color:var(--dsw-alias-state-success-primary)}',
      '.jev-stat.warn .v{color:var(--dsw-alias-state-warn-primary)}',
      '.jev-stat.bad .v{color:var(--dsw-alias-state-error-primary)}',
      '.jev-body{flex:1 1 auto;display:flex;min-height:0}',
      '.jev-left{flex:1 1 auto;display:flex;flex-direction:column;min-width:0;border-right:1px solid var(--dsw-alias-border-l1)}',
      '.jev-right{flex:0 0 340px;display:flex;flex-direction:column;min-height:0}',
      '.jev-frame{flex:1 1 auto;min-height:0;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-base);overflow:hidden}',
      '.jev-frame img{max-width:100%;max-height:100%;object-fit:contain;display:block}',
      '.jev-meta{padding:6px 16px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:12px;flex:0 0 auto}',
      '.jev-sec{border-bottom:1px solid var(--dsw-alias-border-l1);padding:8px 12px;flex:0 0 auto}',
      '.jev-sec h3{margin:0 0 6px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.jev-pending{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-state-warn-primary);border-radius:6px;padding:8px}',
      '.jev-feed{flex:1 1 auto;overflow:auto;padding:8px 12px;min-height:0}',
      '.jev-row{padding:4px 0;border-bottom:1px solid var(--dsw-alias-border-l1);line-height:1.5}',
      '.jev-row:last-child{border-bottom:0}',
      '.jev-t{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;margin-right:6px}',
      '.jev-tag{display:inline-block;min-width:44px;text-align:center;border-radius:4px;padding:0 5px;margin-right:6px;font-size:11px;background:var(--dsw-alias-bg-layer-2)}',
      '.jev-tag.ok{color:var(--dsw-alias-state-success-primary)}',
      '.jev-tag.warn{color:var(--dsw-alias-state-warn-primary)}',
      '.jev-tag.bad{color:var(--dsw-alias-state-error-primary)}',
      '.jev-basis{display:block;padding-left:64px;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.jev-dim{color:var(--dsw-alias-state-idle-primary)}',
      '.jev-pick{cursor:pointer;border-radius:4px;padding:4px 6px}',
      '.jev-pick:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.jev-pick.on{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-brand-primary)}',
      '.jev-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;background:var(--dsw-alias-state-idle-primary);vertical-align:middle}',
      '.jev-dot.on{background:var(--dsw-alias-state-success-primary)}',
      '.jev-tabs{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}',
      '.jev-tab{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:4px;padding:1px 6px;font-size:11px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.jev-tab.active{border-color:var(--dsw-alias-brand-primary)}',
    ].join('');

    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    const clock = (at) => {
      const d = new Date(at);
      return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    };
    const ago = (ms) => {
      if (ms == null) return '—';
      if (ms < 1000) return '刚刚';
      if (ms < 60000) return Math.round(ms / 1000) + ' 秒前';
      if (ms < 3600000) return Math.round(ms / 60000) + ' 分钟前';
      return Math.round(ms / 3600000) + ' 小时前';
    };

    /** One stat cell. */
    function Stat({ label, value, tone }) {
      return h('div', { className: 'jev-stat' + (tone ? ' ' + tone : '') }, [
        h('span', { className: 'k', key: 'k' }, label),
        h('span', { className: 'v', key: 'v' }, String(value)),
      ]);
    }

    /**
     * The one line that says what happened to an action, and on what evidence.
     *
     * Verification is the reason this board exists at all: `unconfirmed` is the state that
     * needs a person, so it is never folded into success or failure here either.
     */
    function actionLine(event) {
      const verdict = event.verified === 'verified' ? '已验证'
        : event.verified === 'unconfirmed' ? '结果未确认'
        : event.verified === 'refuted' ? '页面否定'
        : event.ok === false ? '失败' : '已执行';
      const tone = event.verified === 'verified' ? 'ok'
        : event.verified === 'unconfirmed' ? 'warn'
        : event.verified === 'refuted' || event.ok === false ? 'bad' : '';
      return { verdict, tone };
    }

    function Feed({ events }) {
      if (!events || events.length === 0) return h('div', { className: 'jev-dim' }, '还没有活动');
      return h(
        'div',
        null,
        events.map((event, index) => {
          let text = event.kind;
          let tone = '';
          if (event.kind === 'action') {
            const line = actionLine(event);
            text = event.action + ' → ' + (event.target || '?');
            tone = line.tone;
            return h('div', { className: 'jev-row', key: index }, [
              h('span', { className: 'jev-t', key: 't' }, clock(event.at)),
              h('span', { className: 'jev-tag ' + tone, key: 'g' }, line.verdict),
              h('span', { key: 'x' }, text),
              event.basis ? h('span', { className: 'jev-basis', key: 'b' }, '依据: ' + event.basis) : null,
            ]);
          }
          if (event.kind === 'risk') { text = '风控信号: ' + event.signal; tone = 'bad'; }
          else if (event.kind === 'confirm') { text = '等待批准: ' + event.target; tone = 'warn'; }
          else if (event.kind === 'grant') { text = '已批准: ' + event.target; tone = 'ok'; }
          else if (event.kind === 'deny') { text = '已拒绝: ' + event.target; tone = 'warn'; }
          else if (event.kind === 'session') text = event.text || 'session';
          return h('div', { className: 'jev-row', key: index }, [
            h('span', { className: 'jev-t', key: 't' }, clock(event.at)),
            h('span', { className: 'jev-tag ' + tone, key: 'g' }, event.kind),
            h('span', { key: 'x' }, text),
          ]);
        }),
      );
    }

    /** The board page: monitor, pending decision, and the run's own account of itself. */
    function Page() {
      const [state, setState] = React.useState(null);
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [watch, setWatch] = React.useState('');
      const [frame, setFrame] = React.useState({ url: '', at: 0, empty: false });
      const [now, setNow] = React.useState(Date.now());

      // `watch` names the session to look at; empty lets the host half choose one (a session
      // waiting for a decision wins, then `default`).
      React.useEffect(() => {
        let alive = true;
        const query = watch ? '?session=' + encodeURIComponent(watch) : '';
        const load = () => {
          fetch(MOUNT + '/state.json' + query, { cache: 'no-store' })
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
            .then((next) => { if (alive) { setState(next); setError(''); } })
            .catch((e) => { if (alive) setError(String(e && e.message ? e.message : e)); });
        };
        load();
        const id = setInterval(load, 1000);
        const tick = setInterval(() => setNow(Date.now()), 1000);
        return () => { alive = false; clearInterval(id); clearInterval(tick); };
      }, [watch]);

      // The live view. Every capture is taken fresh, so the frame is polled — and preloaded:
      // the next image is only swapped in once it has decoded, which keeps the previous frame
      // on screen instead of flashing an empty box between captures. The next poll is chained
      // rather than fixed-interval, so a slow capture cannot stack requests up, and polling
      // stops while the page is hidden: nobody is looking, and a capture is real work.
      React.useEffect(() => {
        let alive = true;
        let timer = null;
        const step = () => {
          if (document.hidden) { timer = setTimeout(step, 1000); return; }
          const url = MOUNT + '/frame.png?t=' + Date.now() + (watch ? '&session=' + encodeURIComponent(watch) : '');
          const image = new Image();
          image.onload = () => { if (alive) setFrame({ url, at: Date.now(), empty: false }); };
          image.onerror = () => { if (alive) setFrame((previous) => ({ ...previous, at: Date.now(), empty: true })); };
          image.src = url;
          timer = setTimeout(step, 900);
        };
        step();
        return () => { alive = false; if (timer) clearTimeout(timer); };
      }, [watch]);

      const total = (state && state.totals) || {};
      const events = (state && state.events) || [];
      const sessions = (state && state.sessions) || [];
      const tabs = (state && state.tabs) || [];
      // One stop per session: with several sessions working, several can be waiting at once,
      // and each one has its own decision id — so every stop is rendered and answered
      // separately. `state.pending` is the newest of them, kept for an older host half.
      // The freshest thing the run did, so the picture and the log agree at a glance.
      const lastAction = (() => {
        const last = events.find((event) => event.kind === 'action');
        if (!last) return '';
        const verdict = last.verified === 'verified' ? ' ✓' : last.verified === 'unconfirmed' ? ' ⚠' : last.verified === 'refuted' ? ' ✗' : '';
        return (last.action || '') + ' → ' + (last.target || '?') + verdict + '（' + ago(now - last.at) + '）';
      })();
      const pendings = (state && state.pendings && state.pendings.length)
        ? state.pendings
        : (state && state.pending ? [state.pending] : []);

      const decide = (stop, verdict) => {
        if (!stop) return;
        setBusy(true);
        fetch(MOUNT + '/decide', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ target: stop.target, verdict, id: stop.id }),
        })
          .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); })
          .catch((e) => setError(String(e && e.message ? e.message : e)))
          .then(() => setBusy(false));
      };

      return h('div', { className: 'jev-root' }, [
        h('style', { key: 'css' }, CSS),
        h('div', { className: 'jev-head', key: 'head' }, [
          h('span', { className: 'jev-title', key: 't' }, '招聘工作台'),
          sessions.length > 1
            ? h('span', { className: 'jev-dim', key: 's' }, '会话 ' + (state.selectedSession || '—'))
            : null,
          h('span', { className: 'jev-dim', key: 'u' }, state && state.status ? state.status : '连接中…'),
        ]),
        h('div', { className: 'jev-stats', key: 'stats' }, [
          h(Stat, { key: 'v', label: '已验证', value: total.verified || 0, tone: total.verified ? 'ok' : '' }),
          h(Stat, { key: 'u', label: '结果未确认', value: total.unconfirmed || 0, tone: total.unconfirmed ? 'warn' : '' }),
          h(Stat, { key: 'r', label: '页面否定', value: total.refused || 0, tone: total.refused ? 'bad' : '' }),
          h(Stat, { key: 'a', label: '动作', value: (total.actionsOk || 0) + ' / ' + (total.actionsFailed || 0) }),
          h(Stat, { key: 'p', label: '待批/已批', value: (total.confirmations || 0) + ' / ' + (total.grants || 0) }),
          h(Stat, { key: 'k', label: '风控停手', value: total.riskStops || 0, tone: total.riskStops ? 'bad' : '' }),
          h(Stat, { key: 'n', label: '运行/步数', value: (total.runs || 0) + ' / ' + (total.steps || 0) }),
          h(Stat, { key: 'c', label: '决策 token', value: (total.tokensIn || 0) + (total.tokensOut || 0) }),
        ]),
        h('div', { className: 'jev-body', key: 'body' }, [
          h('div', { className: 'jev-left', key: 'l' }, [
            h('div', { className: 'jev-frame', key: 'f' },
              frame.url && !frame.empty
                ? h('img', { src: frame.url, alt: '浏览器实况' })
                : h('span', { className: 'jev-dim' },
                    error ? '无法读取看板状态：' + error
                      : state && state.live ? '正在取画面…'
                        : '没有可看的页面（画面可能不可用）')),
            h('div', { className: 'jev-meta', key: 'm' }, [
              h('div', { key: 'live' }, [
                h('span', { className: 'jev-dot' + (frame.url && !frame.empty ? ' on' : ''), key: 'd' }),
                h('span', { key: 't' }, frame.url && !frame.empty ? '实时画面 · ' + ago(now - frame.at) + '更新' : '等待画面'),
                h('span', { className: 'jev-dim', key: 's' }, lastAction ? '　最近动作：' + lastAction : ''),
              ]),
              h('div', { key: 'u' }, (state && state.url) || '—'),
              h('div', { key: 'h' }, (state && state.health) || ''),
              h('div', { key: 'p' }, (state && state.pacing) || ''),
              tabs.length
                ? h('div', { className: 'jev-tabs', key: 't' }, tabs.map((tab) => h(
                    'span',
                    { className: 'jev-tab' + (tab.active ? ' active' : ''), key: tab.index, title: tab.url },
                    tab.index + '. ' + (tab.title || tab.url || ''),
                  )))
                : null,
            ]),
          ]),
          h('div', { className: 'jev-right', key: 'r' }, [
            h('div', { className: 'jev-sec', key: 'p' }, [
              h('h3', { key: 'h' }, pendings.length > 1 ? '待批准 (' + pendings.length + ')' : '待批准'),
              pendings.length
                ? h('div', { key: 'l' }, pendings.map((stop) => h('div', { className: 'jev-pending', key: stop.id, style: { marginBottom: '6px' } }, [
                    h('div', { key: 't' }, stop.target),
                    h('div', { className: 'jev-dim', key: 'g' }, (stop.session || '') + (stop.goal ? ' · ' + stop.goal : '')),
                    h('div', { style: { marginTop: '8px', display: 'flex', gap: '6px' }, key: 'b' }, [
                      h('button', { className: 'jev-btn primary', disabled: busy, onClick: () => decide(stop, 'grant'), key: 'g' }, '批准这一步'),
                      h('button', { className: 'jev-btn', disabled: busy, onClick: () => decide(stop, 'deny'), key: 'd' }, '拒绝'),
                    ]),
                    h('div', { className: 'jev-dim', key: 'n', style: { marginTop: '6px' } },
                      '批准只授权这一个动作，用完即失效；' + ago(now - (stop.at || now)) + '前提出'),
                  ])))
                : h('div', { className: 'jev-dim', key: 'n' }, '没有等待批准的动作'),
            ]),
            h('div', { className: 'jev-sec', key: 's' }, [
              h('h3', { key: 'h' }, '会话' + (sessions.length > 1 ? '（点一个看它的实时画面）' : '')),
              sessions.length
                ? h('div', { key: 'l' }, sessions.map((s) => h('div', {
                    key: s.name,
                    className: 'jev-row jev-pick' + (s.name === (state.selectedSession || '') ? ' on' : ''),
                    title: '看这个会话的实时画面',
                    onClick: () => setWatch(s.name),
                  }, [
                    h('span', { key: 'n', style: { marginRight: '6px' } },
                      (s.name === (state.selectedSession || '') ? '● ' : '') + s.name),
                    h('span', { className: 'jev-dim', key: 'd' },
                      s.origin + ' · ' + s.tabs + ' 标签 · ' + s.actions + ' 动作 · 空闲 ' + ago(s.idleMs)),
                  ])))
                : h('div', { className: 'jev-dim', key: 'n' }, '没有会话'),
            ]),
            h('div', { className: 'jev-sec', key: 'r' }, [
              h('h3', { key: 'h' }, '最近运行'),
              (state && state.runs && state.runs.length)
                ? h('div', { key: 'l' }, state.runs.slice(0, 4).map((run, i) => h('div', { className: 'jev-row', key: i }, [
                    h('span', { className: 'jev-t', key: 't' }, clock(run.at)),
                    h('span', { key: 's' }, run.status + ' · ' + run.steps + ' 步'),
                    h('span', { className: 'jev-dim', key: 'g' }, ' ' + (run.goal || '').slice(0, 40)),
                  ])))
                : h('div', { className: 'jev-dim', key: 'n' }, '还没有运行'),
            ]),
            h('div', { className: 'jev-feed', key: 'f' }, [
              h('h3', { key: 'h', style: { margin: '0 0 6px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } }, '活动轨迹'),
              h(Feed, { events, key: 'l' }),
            ]),
          ]),
        ]),
      ]);
    }

    /** The sidebar glyph. The host supplies the square edge and the selected state. */
    function Icon({ size, active }) {
      const s = size || 20;
      return h(
        'svg',
        { width: s, height: s, viewBox: '0 0 24 24', 'aria-hidden': true, style: { display: 'block' } },
        [
          // A browser window with a cursor in it: the plugin drives a real browser.
          h('rect', {
            key: 'r', x: 3, y: 4, width: 18, height: 16, rx: 2.5,
            fill: 'none', stroke: 'currentColor', strokeWidth: active ? 2 : 1.6,
          }),
          h('line', { key: 'l', x1: 3, y1: 8.5, x2: 21, y2: 8.5, stroke: 'currentColor', strokeWidth: 1.6 }),
          h('circle', { key: 'd1', cx: 6, cy: 6.2, r: 0.9, fill: 'currentColor' }),
          h('circle', { key: 'd2', cx: 9, cy: 6.2, r: 0.9, fill: 'currentColor' }),
          h('path', { key: 'c', d: 'M10 11.5l6 2.6-2.5 1 1.2 2.7-1.6.7-1.2-2.7-1.9 1.6z', fill: 'currentColor' }),
        ],
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // The sidebar owns the button and resolves the label; the id is what addresses the
        // `main` cell, so the two registrations must agree on it.
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id: ID, order: 20, label: () => '招聘工作台' },
          Icon,
        ));
        ctx.slots.inject('main', () => ctx.slots.register(
          { name: 'main', key: ID },
          Page,
        ));
      },
    };
  },
});
