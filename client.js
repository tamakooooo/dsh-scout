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
      // The chat box: a fixed row at the foot of the panel, under the frame and the panels.
      '.jev-chat{flex:0 0 auto;border-top:1px solid var(--dsw-alias-border-l1);padding:8px 12px;display:flex;flex-direction:column;gap:4px}',
      '.jev-chat-row{display:flex;gap:6px;align-items:flex-end}',
      '.jev-bar{display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px}',
      '.jev-bar.warn{background:var(--dsw-alias-bg-layer-2)}',
      '.jev-bar>span:first-child{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.jev-convo{flex:1 1 auto;min-height:0;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px}',
      '.jev-msg{max-width:86%;padding:8px 10px;border-radius:10px;background:var(--dsw-alias-bg-layer-2)}',
      '.jev-msg.user{align-self:flex-end}',
      '.jev-msg.assistant{align-self:flex-start}',
      '.jev-msg-role{font-size:11px;color:var(--dsw-alias-label-secondary);margin-bottom:2px}',
      '.jev-msg-text{font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word}',
      '.jev-msg-md{white-space:normal}',
      '.jev-md-p{margin:0 0 6px}',
      '.jev-md-p:last-child{margin-bottom:0}',
      '.jev-md-h{font-weight:600;margin:6px 0 4px}',
      '.jev-md-h1{font-size:15px}',
      '.jev-md-h2{font-size:14px}',
      '.jev-md-h3,.jev-md-h4,.jev-md-h5,.jev-md-h6{font-size:13px}',
      '.jev-md-pre{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:6px 8px;overflow-x:auto;margin:4px 0;font-size:12px}',
      '.jev-md-code{background:var(--dsw-alias-bg-base);border-radius:4px;padding:0 3px;font-size:12px}',
      '.jev-md-list{margin:4px 0;padding-left:18px}',
      '.jev-md-table{border-collapse:collapse;margin:4px 0;font-size:12px}',
      '.jev-md-table th,.jev-md-table td{border:1px solid var(--dsw-alias-border-l1);padding:2px 6px;text-align:left}',
      '.jev-md-quote{margin:4px 0;padding-left:8px;border-left:2px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}',
      '.jev-md-hr{border:0;border-top:1px solid var(--dsw-alias-border-l1);margin:6px 0}',
      '.jev-md-link{color:inherit;text-decoration:underline}',
      '.jev-md-reasoning{border-left:2px solid var(--dsw-alias-border-l1);padding-left:8px;margin:4px 0;color:var(--dsw-alias-label-secondary)}',
      '.jev-md-reasoning-label{font-size:11px;opacity:.8}',
      '.jev-md-reasoning-text{font-size:12px;max-height:96px;overflow-y:auto;white-space:pre-wrap}',
      '.jev-toolrow{display:flex;gap:6px;align-items:baseline;font-size:12px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-radius:6px;padding:4px 8px;margin:4px 0;max-width:86%;align-self:flex-start}',
      '.jev-toolrow.bad{color:var(--dsw-alias-state-error-primary)}',
      '.jev-toolname{flex:0 0 auto;font-weight:600}',
      '.jev-tooldetail{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.jev-detail{flex:0 0 auto;max-height:46%;overflow-y:auto;border-top:1px solid var(--dsw-alias-border-l1);padding:8px 12px}',
      '.jev-chat-input{resize:none;font:inherit}',
      // The chat panel lives in the right sidebar now, so it brings its own full-height column.
      '.jev-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;overflow:hidden}',
      '.jev-boardpane{flex:1 1 42%;min-height:0;overflow-y:auto;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.jev-framepane{flex:1 1 58%;min-height:0;display:flex;flex-direction:column}',
      '.jev-chatcol{flex:0 0 24%;min-width:280px;display:flex;flex-direction:column;min-height:0;border-left:1px solid var(--dsw-alias-border-l1)}',
      '.jev-chathead{flex:0 0 auto;display:flex;align-items:baseline;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.jev-chathead-title{font-weight:600}',
      '.jev-chatpanel{height:100%;display:flex;flex-direction:column;overflow:hidden;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.jev-chatlist{flex:1 1 auto;min-height:0;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:8px}',
      '.jev-scroll{overflow-y:auto}',
      '.jev-statsbox{display:flex;flex-wrap:wrap;gap:6px}',
      // One chip per platform. Four pools, four counts; the live one is marked, never assumed.
      '.jev-platforms{display:flex;gap:6px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);overflow-x:auto;flex:0 0 auto}',
      '.jev-platform{display:inline-flex;align-items:center;gap:4px;padding:2px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);font-size:12px;white-space:nowrap;color:var(--dsw-alias-label-secondary)}',
      '.jev-platform.live{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-label-primary)}',
      '.jev-platform .n{font-variant-numeric:tabular-nums}',
      '.jev-chat-input{flex:1 1 auto;min-width:0;padding:6px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:inherit;font:inherit}',
      '.jev-chat-note{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.jev-left{flex:1 1 auto;display:flex;flex-direction:column;min-width:0;border-right:1px solid var(--dsw-alias-border-l1)}',
      '.jev-right{flex:0 0 340px;display:flex;flex-direction:column;min-height:0}',
      '.jev-frame{flex:1 1 auto;min-height:0;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-base);overflow:hidden;border-bottom:1px solid var(--dsw-alias-border-l1)}',
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
    /**
     * The conversation, as a tab in the right sidebar.
     *
     * Kept out of the board on purpose: the board is for watching the browser work, and a
     * conversation you are having wants its own column rather than a strip at the foot of a
     * dashboard. The tab sits on a session-scoped slot, so the session on screen is passed in
     * and used — better than the panel asking the Host which conversation was most recently
     * active, which is what it had to do while it lived on a shell-wide slot.
     */
    function Chat(props) {
      const propsSessionId = typeof props?.sessionId === 'string' ? props.sessionId : '';
      const [text, setText] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [note, setNote] = React.useState('');
      const [log, setLog] = React.useState([]);
      const [status, setStatus] = React.useState('');
      const [streamedSession, setStreamedSession] = React.useState('');
      const listRef = React.useRef(null);
      const sessionId = propsSessionId || streamedSession;

      // The transcript, streamed. EventSource reconnects on its own and a reconnect replays the
      // recent messages, so the same one can arrive twice: the duplicate is dropped rather than
      // showing the conversation twice.
      React.useEffect(() => {
        if (!MOUNT) return undefined;
        const query = propsSessionId ? '?sessionId=' + encodeURIComponent(propsSessionId) : '';
        const source = new EventSource(MOUNT + '/chat/stream' + query);
        source.onmessage = (event) => {
          let frame;
          try { frame = JSON.parse(event.data); } catch { return; }
          if (frame.kind === 'message') {
            setLog((previous) => (previous.some((m) => m.id === frame.message.id)
              ? previous
              : previous.concat([{ kind: 'message', ...frame.message }]).slice(-300)));
          } else if (frame.kind === 'tool') {
            setLog((previous) => (previous.some((m) => m.id === frame.tool.id)
              ? previous
              : previous.concat([{ kind: 'tool', ...frame.tool }]).slice(-300)));
          } else if (frame.kind === 'status') {
            setStatus(frame.text || '');
          } else if (frame.kind === 'session') {
            setStreamedSession(frame.sessionId || '');
          } else if (frame.kind === 'unknown') {
            setStatus('已连接，但有 ' + frame.count + ' 条事件不认识：' + (frame.types || []).join('、'));
          } else if (frame.kind === 'end') {
            setStatus(frame.ignored ? '已连接（' + frame.ignored + ' 条事件未识别）' : '');
          } else if (frame.kind === 'error') {
            setStatus('读取失败：' + frame.text);
          }
        };
        source.onerror = () => setStatus('读取中断，正在重试…');
        return () => source.close();
      }, [propsSessionId]);

      // Keep the newest message in view.
      React.useEffect(() => {
        const element = listRef.current;
        if (element) element.scrollTop = element.scrollHeight;
      }, [log.length, status]);

      const send = () => {
        const message = text.trim();
        if (message === '' || busy) return;
        setBusy(true);
        setNote('');
        fetch(MOUNT + '/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(propsSessionId ? { text: message, sessionId: propsSessionId } : { text: message }),
        })
          .then(async (response) => {
            if (!response.ok) throw new Error((await response.text()) || ('HTTP ' + response.status));
            return response.json();
          })
          .then((sent) => {
            setText('');
            setNote(sent.accepted ? '' : '已提交，但 Host 没有确认收到');
          })
          .catch((error) => setNote('发送失败：' + String(error && error.message ? error.message : error)))
          .then(() => setBusy(false));
      };

      return h('div', { className: 'jev-chatpanel' }, [
        // Said plainly, because it is the point: this is not the conversation you are in. It is
        // one session of its own, kept for this workbench, and what you tell it is about the run
        // in front of you.
        h('div', { className: 'jev-chathead', key: 'h' }, [
          h('span', { className: 'jev-chathead-title', key: 't' }, '招聘工作台助手'),
          h('span', { className: 'jev-dim', key: 's' }, sessionId ? sessionId.slice(0, 12) : '尚未建立'),
        ]),
        h('div', { className: 'jev-chatlist', key: 'l', ref: listRef }, [
          log.length === 0
            ? h('div', { className: 'jev-dim', key: 'e', style: { padding: '12px' } },
                status || '还没有对话。在下面说点什么，回复会出现在这里。')
            : log.map((entry) => {
                // A tool result is a row, not a bubble: it is something that happened, not
                // something said, and the conversation draws it that way too.
                if (entry.kind === 'tool') {
                  return h('div', { className: 'jev-toolrow' + (entry.error ? ' bad' : ''), key: entry.id }, [
                    h('span', { className: 'jev-toolname', key: 'n' }, entry.error ? '工具出错' : '工具结果'),
                    h('span', { className: 'jev-tooldetail', key: 'd' }, entry.text || '(空)'),
                  ]);
                }
                if (entry.role === 'assistant') {
                  const parts = Array.isArray(entry.parts) && entry.parts.length > 0
                    ? entry.parts
                    : [{ kind: 'text', text: entry.text }];
                  return h('div', { className: 'jev-msg assistant', key: entry.id }, [
                    h('div', { className: 'jev-msg-role', key: 'r' }, 'AI'),
                    ...parts.map((part, partIndex) => {
                      const partKey = entry.id + '-p' + partIndex;
                      if (part.kind === 'reasoning') {
                        // Shown, dimmed and clamped, because it is part of the answer's working and
                        // the conversation shows it too.
                        return h('div', { className: 'jev-md-reasoning', key: partKey }, [
                          h('div', { className: 'jev-md-reasoning-label', key: 'l' }, '思考'),
                          h('div', { className: 'jev-md-reasoning-text', key: 't' }, part.text),
                        ]);
                      }
                      if (part.kind === 'tool') {
                        return h('div', { className: 'jev-toolrow', key: partKey }, [
                          h('span', { className: 'jev-toolname', key: 'n' }, part.name),
                          h('span', { className: 'jev-tooldetail', key: 'd' }, (part.input || '').slice(0, 240)),
                        ]);
                      }
                      return h('div', { className: 'jev-msg-text jev-msg-md', key: partKey }, renderMarkdown(part.text, partKey));
                    }),
                  ]);
                }
                return h('div', { className: 'jev-msg ' + entry.role, key: entry.id }, [
                  h('div', { className: 'jev-msg-role', key: 'r' }, entry.role === 'user' ? '我' : 'AI'),
                  h('div', { className: 'jev-msg-text', key: 't' }, entry.text),
                ]);
              }),
        ]),
        status && log.length > 0
          ? h('div', { className: 'jev-chat-note', key: 's', style: { padding: '0 10px 4px' } }, status)
          : null,
        h('div', { className: 'jev-chat', key: 'c' }, [
          h('div', { className: 'jev-chat-row', key: 'r' }, [
            h('textarea', {
              key: 'i',
              className: 'jev-chat-input',
              rows: 2,
              value: text,
              disabled: busy,
              placeholder: '说点什么，回车发送（Shift+回车换行）…',
              'aria-label': '给 AI 的消息',
              onChange: (event) => setText(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              },
            }),
            h('button', {
              key: 'b',
              className: 'jev-btn primary',
              disabled: busy || text.trim() === '',
              onClick: send,
            }, busy ? '…' : '发送'),
          ]),
          h('div', { className: 'jev-chat-note', key: 'n' },
            note || '只用于操作这个工作台'),
        ]),
      ]);
    }

    /**
     * The board: the browser's own picture, and the numbers that describe what it is doing.
     *
     * This is the main panel, so the live frame gets the room and the data sits to its right.
     * The conversation is not here — it is a tab of its own in the right sidebar.
     */
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

      // The live view. Every capture is taken fresh, so the frame is polled — and preloaded: the
      // next image is only swapped in once it has decoded, which keeps the previous frame on
      // screen instead of flashing an empty box between captures. The next poll is chained rather
      // than fixed-interval, so a slow capture cannot stack requests up, and polling stops while
      // the page is hidden: nobody is looking, and a capture is real work.
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
      const task = (state && state.task) || null;
      const platforms = (state && state.platforms) || [];
      const tabs = (state && state.tabs) || [];
      const lastAction = (() => {
        const last = events.find((event) => event.kind === 'action');
        if (!last) return '';
        const verdict = last.verified === 'verified' ? ' ✓' : last.verified === 'unconfirmed' ? ' ⚠' : last.verified === 'refuted' ? ' ✗' : '';
        return (last.action || '') + ' → ' + (last.target || '?') + verdict + '（' + ago(now - last.at) + '）';
      })();
      const pendings = (state && state.pendings && state.pendings.length)
        ? state.pendings
        : (state && state.pending ? [state.pending] : []);

      const control = (action, worker, reason) => {
        setBusy(true);
        fetch(MOUNT + '/control', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, worker, reason }),
        })
          .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); })
          .catch((e) => setError(String(e && e.message ? e.message : e)))
          .then(() => setBusy(false));
      };

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
          h('span', { className: 'jev-dim', key: 'u' }, state && state.status ? state.status : '连接中…'),
          sessions.length > 1
            ? h('span', { className: 'jev-dim', key: 's' }, '会话 ' + (state.selectedSession || '—'))
            : null,
        ]),

        h('div', { className: 'jev-body', key: 'body' }, [
          h('div', { className: 'jev-main', key: 'l' }, [
            h('div', { className: 'jev-framepane', key: 'fp' }, [
            h('div', { className: 'jev-frame', key: 'f' },
              frame.url && !frame.empty
                ? h('img', { src: frame.url, alt: '浏览器实况' })
                : h('span', { className: 'jev-dim' },
                    error ? '无法读取看板状态：' + error
                      : state && state.live ? '正在取画面…' : '没有可看的页面（画面可能不可用）')),
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

          // The board proper, under the picture: the same column, split. The reference has the
          // browser on top and the board beneath it, which is the order they are read in — what
          // it is doing, then what that adds up to.
          h('div', { className: 'jev-boardpane', key: 'board' }, [
            // Which platform is on screen, and what each one has on file. Four pools, four counts.
            platforms.length
              ? h('div', { className: 'jev-sec', key: 'plat' }, [
                  h('h3', { key: 'h' }, '平台'),
                  platforms.map((platform) => h('div', { className: 'jev-row', key: platform.id }, [
                    h('span', { key: 'd', style: { marginRight: '6px' } }, platform.live ? '●' : '○'),
                    h('span', { key: 'n', style: { marginRight: 'auto' } }, platform.name),
                    h('span', { className: 'jev-dim', key: 'c' },
                      platform.contacts + ' 条' + (platform.state && platform.state !== 'idle' ? ' · ' + platform.state : '')),
                  ])),
                ])
              : null,

            // The only things that cannot proceed without a person.
            task && task.requestedAuthorization
              ? h('div', { className: 'jev-sec', key: 'auth' }, [
                  h('h3', { key: 'h' }, '等待你批准的授权'),
                  h('div', { className: 'jev-dim', key: 'w' },
                    task.requestedAuthorization.actions.join('、') + ' · 上限 ' + task.requestedAuthorization.limit +
                    ' 次 · ' + (task.requestedAuthorization.account || '')),
                  h('div', { style: { marginTop: '6px', display: 'flex', gap: '6px' }, key: 'b' }, [
                    h('button', { className: 'jev-btn primary', disabled: busy, key: 'g',
                      onClick: () => decide({ id: task.requestedAuthorization.id }, 'grant') }, '批准授权'),
                    h('button', { className: 'jev-btn', disabled: busy, key: 'd',
                      onClick: () => decide({ id: task.requestedAuthorization.id }, 'deny') }, '拒绝'),
                  ]),
                ])
              : null,
            pendings.length
              ? h('div', { className: 'jev-sec', key: 'pend' }, [
                  h('h3', { key: 'h' }, pendings.length > 1 ? '待批准的动作 (' + pendings.length + ')' : '待批准的动作'),
                  pendings.map((stop) => h('div', { className: 'jev-pending', key: stop.id, style: { marginBottom: '6px' } }, [
                    h('div', { key: 't' }, stop.target),
                    h('div', { className: 'jev-dim', key: 'g' }, (stop.session || '') + (stop.goal ? ' · ' + stop.goal : '')),
                    h('div', { style: { marginTop: '6px', display: 'flex', gap: '6px' }, key: 'b' }, [
                      h('button', { className: 'jev-btn primary', disabled: busy, onClick: () => decide(stop, 'grant'), key: 'g' }, '批准这一步'),
                      h('button', { className: 'jev-btn', disabled: busy, onClick: () => decide(stop, 'deny'), key: 'd' }, '拒绝'),
                    ]),
                  ])),
                ])
              : null,

            h('div', { className: 'jev-sec', key: 'task' }, [
              h('h3', { key: 'h' }, '招聘任务'),
              task
                ? h('div', { key: 'b' }, [
                    h('div', { key: 'state' }, task.state +
                      (task.platform ? ' · ' + task.platform : '') +
                      (task.account ? ' · ' + task.account : '') +
                      (task.posting ? ' · ' + task.posting : '')),
                    h('div', { className: 'jev-dim', key: 'spend' },
                      '联系 ' + task.spend.spent + ' / ' + task.spend.limit + '（余 ' + task.spend.remaining + '）'),
                    task.windows && task.windows.length > 0
                      ? h('div', { key: 'w', style: { marginTop: '6px' } }, task.windows.map((window) => h('div', { className: 'jev-row', key: window.name }, [
                          h('span', { key: 'n', style: { marginRight: '6px' } }, window.name),
                          h('span', { className: 'jev-dim', key: 'd' }, window.state + (window.candidate ? ' · ' + window.candidate : '')),
                        ])))
                      : null,
                    task.state === 'running'
                      ? h('div', { style: { marginTop: '8px', display: 'flex', gap: '6px' }, key: 'ctl' }, [
                          h('button', { className: 'jev-btn', disabled: busy, key: 's', onClick: () => control('stop') }, '统一停止'),
                          h('button', { className: 'jev-btn', disabled: busy, key: 'p', onClick: () => control('pause', 'w1') }, '暂停 w1'),
                          h('button', { className: 'jev-btn', disabled: busy, key: 'r', onClick: () => control('resume', 'w1') }, '继续 w1'),
                        ])
                      : null,
                  ])
                : h('div', { className: 'jev-dim', key: 'none' }, '没有正在运行的任务'),
            ]),

            h('div', { className: 'jev-sec', key: 'stats' }, [
              h('h3', { key: 'h' }, '数据'),
              h('div', { className: 'jev-statsbox' }, [
                h(Stat, { key: 'v', label: '已验证', value: total.verified || 0, tone: total.verified ? 'ok' : '' }),
                h(Stat, { key: 'u', label: '结果未确认', value: total.unconfirmed || 0, tone: total.unconfirmed ? 'warn' : '' }),
                h(Stat, { key: 'r', label: '页面否定', value: total.refused || 0, tone: total.refused ? 'bad' : '' }),
                h(Stat, { key: 'a', label: '动作', value: (total.actionsOk || 0) + ' / ' + (total.actionsFailed || 0) }),
                h(Stat, { key: 'p', label: '待批/已批', value: (total.confirmations || 0) + ' / ' + (total.grants || 0) }),
                h(Stat, { key: 'k', label: '风控停手', value: total.riskStops || 0, tone: total.riskStops ? 'bad' : '' }),
                h(Stat, { key: 'n', label: '运行/步数', value: (total.runs || 0) + ' / ' + (total.steps || 0) }),
                h(Stat, { key: 'c', label: '决策 token', value: (total.tokensIn || 0) + (total.tokensOut || 0) }),
              ]),
            ]),

            sessions.length > 1
              ? h('div', { className: 'jev-sec', key: 'sess' }, [
                  h('h3', { key: 'h' }, '会话（点一个看它的画面）'),
                  sessions.map((session) => h('div', {
                    key: session.name,
                    className: 'jev-row jev-pick' + (session.name === (state.selectedSession || '') ? ' on' : ''),
                    onClick: () => setWatch(session.name),
                  }, [
                    h('span', { key: 'n', style: { marginRight: '6px' } },
                      (session.name === (state.selectedSession || '') ? '● ' : '') + session.name),
                    h('span', { className: 'jev-dim', key: 'd' },
                      session.origin + ' · ' + session.tabs + ' 标签 · ' + session.actions + ' 动作'),
                  ])),
                ])
              : null,

            h('div', { className: 'jev-sec', key: 'runs' }, [
              h('h3', { key: 'h' }, '最近运行'),
              (state && state.runs && state.runs.length)
                ? state.runs.slice(0, 4).map((run, i) => h('div', { className: 'jev-row', key: i }, [
                    h('span', { className: 'jev-t', key: 't' }, clock(run.at)),
                    h('span', { key: 's' }, run.status + ' · ' + run.steps + ' 步'),
                  ]))
                : h('div', { className: 'jev-dim', key: 'n' }, '还没有运行'),
            ]),

            h('div', { className: 'jev-sec', key: 'feed' }, [
              h('h3', { key: 'h' }, '活动轨迹'),
              h(Feed, { events, key: 'l' }),
            ]),
          ]),
          ]),

          // The conversation, in its own column beside the board. It is part of this page rather
          // than a separate shell panel: the workbench is where the watching and the talking
          // happen, and switching surfaces to ask a question about what you are looking at is
          // the wrong shape for it.
          h('div', { className: 'jev-chatcol', key: 'chat' }, [
            h(Chat, { key: 'c' }),
          ]),
        ]),
      ]);
    }

    // ─── markdown parser: a verbatim copy of lib/markdown.js ─────────────────
    // The Client half is a separate bundle and cannot import from lib, so the parser is copied.
    // test/markdown-check.mjs compares this block against the original, so the duplicate is
    // checked rather than trusted.
/** Split a table row into cells, trimming the outer pipes. */
function splitRow(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

/** Whether a line is a table's separator row: |---|:--:|---| */
function isTableSeparator(line) {
  const cells = splitRow(line);
  if (cells.length === 0) return false;
  return cells.every((cell) => /^:?-{2,}:?$/.test(cell.replace(/\s+/g, '')));
}

/**
 * Parse one message body into blocks.
 *
 * @param text - the raw text.
 * @returns an array of blocks; empty input yields no blocks.
 */
function parseMarkdown(text) {
  const source = typeof text === 'string' ? text : '';
  if (source.trim() === '') return [];
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    // Blank lines only separate.
    if (line.trim() === '') {
      index += 1;
      continue;
    }

    // A fenced code block, to its closing fence or the end.
    const fence = line.match(/^\s*(```|~~~)\s*([A-Za-z0-9+#._-]*)\s*$/);
    if (fence) {
      const marker = fence[1];
      const lang = fence[2] || '';
      const body = [];
      index += 1;
      while (index < lines.length && !new RegExp(`^\\s*${marker}\\s*$`).test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: 'code', lang, text: body.join('\n') });
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] });
      index += 1;
      continue;
    }

    if (/^\s{0,3}([-*_])\s*(\1\s*){2,}$/.test(line)) {
      blocks.push({ type: 'rule' });
      index += 1;
      continue;
    }

    // A table: a row with pipes, then a separator row.
    if (line.includes('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      const head = splitRow(line);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim() !== '') {
        rows.push(splitRow(lines[index]));
        index += 1;
      }
      blocks.push({ type: 'table', head, rows });
      continue;
    }

    const quote = line.match(/^\s{0,3}>\s?(.*)$/);
    if (quote) {
      const body = [quote[1]];
      index += 1;
      while (index < lines.length && /^\s{0,3}>\s?/.test(lines[index])) {
        body.push(lines[index].replace(/^\s{0,3}>\s?/, ''));
        index += 1;
      }
      blocks.push({ type: 'quote', text: body.join('\n') });
      continue;
    }

    const bullet = line.match(/^\s*([-*+])\s+(.*)$/);
    const numbered = line.match(/^\s*(\d{1,9})[.)]\s+(.*)$/);
    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      const start = numbered ? Number(numbered[1]) : 1;
      const items = [];
      while (index < lines.length) {
        const next = ordered
          ? lines[index].match(/^\s*(\d{1,9})[.)]\s+(.*)$/)
          : lines[index].match(/^\s*([-*+])\s+(.*)$/);
        if (!next) break;
        items.push(next[2]);
        index += 1;
      }
      blocks.push({ type: 'list', ordered, start, items });
      continue;
    }

    // A paragraph, up to the next blank line or a line that starts another block.
    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length) {
      const candidate = lines[index];
      if (candidate.trim() === '') break;
      if (/^\s*(```|~~~)/.test(candidate)) break;
      if (/^\s{0,3}#{1,6}\s+/.test(candidate)) break;
      if (/^\s{0,3}>\s?/.test(candidate)) break;
      if (/^\s*([-*+])\s+/.test(candidate) || /^\s*\d{1,9}[.)]\s+/.test(candidate)) break;
      if (candidate.includes('|') && isTableSeparator(candidate)) break;
      paragraph.push(candidate.trim());
      index += 1;
    }
    blocks.push({ type: 'para', text: paragraph.join('\n') });
  }

  return blocks;
}

/**
 * Split a line of text into inline spans.
 *
 * Code first, so that `**` inside `code` is code and not emphasis.
 */
function parseInline(text) {
  const source = typeof text === 'string' ? text : '';
  const spans = [];
  const push = (span) => {
    if (span.text === '') return;
    const last = spans[spans.length - 1];
    if (last && last.type === 'text' && span.type === 'text') last.text += span.text;
    else spans.push(span);
  };
  let rest = source;

  while (rest !== '') {
    const code = rest.match(/^`([^`]+)`/);
    if (code) {
      push({ type: 'code', text: code[1] });
      rest = rest.slice(code[0].length);
      continue;
    }
    const link = rest.match(/^\[([^\]]*)\]\(([^)\s]+)\)/);
    if (link) {
      push({ type: 'link', text: link[1] || link[2], href: link[2] });
      rest = rest.slice(link[0].length);
      continue;
    }
    const strong = rest.match(/^\*\*([^*]+)\*\*/) || rest.match(/^__([^_]+)__/);
    if (strong) {
      push({ type: 'strong', text: strong[1] });
      rest = rest.slice(strong[0].length);
      continue;
    }
    const em = rest.match(/^\*([^*\s][^*]*)\*/) || rest.match(/^_([^_\s][^_]*)_/);
    if (em) {
      push({ type: 'em', text: em[1] });
      rest = rest.slice(em[0].length);
      continue;
    }
    // Take one character of plain text and try again from the next position.
    const next = rest.slice(1).search(/[`*_[\]\\]/);
    const take = next === -1 ? rest.length : next + 1;
    push({ type: 'text', text: rest.slice(0, take) });
    rest = rest.slice(take);
  }

  return spans;
}
    // ─── end markdown parser ────────────────────────────────────────────────

    /** Inline spans as React nodes. */
    function renderInline(text, keyPrefix) {
      return parseInline(text).map((span, index) => {
        const key = keyPrefix + '-' + index;
        if (span.type === 'code') return h('code', { className: 'jev-md-code', key }, span.text);
        if (span.type === 'strong') return h('strong', { key }, span.text);
        if (span.type === 'em') return h('em', { key }, span.text);
        if (span.type === 'link') return h('a', { className: 'jev-md-link', key, href: span.href, target: '_blank', rel: 'noreferrer' }, span.text);
        return h('span', { key }, span.text);
      });
    }

    /**
     * One message body as elements.
     *
     * The same replies the conversation panel renders, rendered here too — a place that showed
     * them as raw punctuation looked broken beside it. Tool calls and reasoning steps are not
     * reproduced: this is the message text, and saying so is better than a half-copy of the
     * conversation's own node renderers.
     */
    function renderMarkdown(text, keyPrefix) {
      const blocks = parseMarkdown(text);
      if (blocks.length === 0) return null;
      return blocks.map((block, index) => {
        const key = keyPrefix + '-b' + index;
        if (block.type === 'code') {
          return h('pre', { className: 'jev-md-pre', key }, h('code', { key: 'c' }, block.text));
        }
        if (block.type === 'heading') {
          return h('div', { className: 'jev-md-h jev-md-h' + block.level, key }, renderInline(block.text, key));
        }
        if (block.type === 'rule') return h('hr', { className: 'jev-md-hr', key });
        if (block.type === 'quote') {
          return h('blockquote', { className: 'jev-md-quote', key }, renderInline(block.text, key));
        }
        if (block.type === 'list') {
          const items = block.items.map((item, itemIndex) => h('li', { key: key + '-i' + itemIndex }, renderInline(item, key + '-i' + itemIndex)));
          return block.ordered
            ? h('ol', { className: 'jev-md-list', key, start: block.start }, items)
            : h('ul', { className: 'jev-md-list', key }, items);
        }
        if (block.type === 'table') {
          return h('table', { className: 'jev-md-table', key }, [
            h('thead', { key: 'h' }, h('tr', null, block.head.map((cell, cellIndex) => h('th', { key: 'h' + cellIndex }, renderInline(cell, key + '-h' + cellIndex))))),
            h('tbody', { key: 'b' }, block.rows.map((row, rowIndex) => h('tr', { key: 'r' + rowIndex },
              row.map((cell, cellIndex) => h('td', { key: 'c' + cellIndex }, renderInline(cell, key + '-r' + rowIndex + 'c' + cellIndex)))))),
          ]);
        }
        return h('p', { className: 'jev-md-p', key }, renderInline(block.text, key));
      });
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
