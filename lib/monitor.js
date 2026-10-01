/** Read-only data and frames for the monitoring board's selected session. */
import { captureScreenshot } from './page.js';

export function createMonitor({ sessions, pacing, journal, task }) {
  function selectedSession(requested) {
    const names = sessions.list();
    if (names.includes(requested)) return requested;
    // With several sessions there can be several stops; any session waiting for a person is
    // the one worth showing, because it is the one that cannot proceed without one.
    const waiting = pacing.pendings.find((entry) => names.includes(entry.session));
    if (waiting) return waiting.session;
    return names.includes('default') ? 'default' : names[0];
  }

  return {
    capture: async (requested) => {
      const name = selectedSession(requested);
      if (!name) return null;
      const { session } = await sessions.page(name);
      const base64 = await captureScreenshot(session.cdp, session.sessionId, { fullPage: false });
      return Buffer.from(base64, 'base64');
    },
    readState: async (requested) => {
      const { events, runs, totals } = journal.snapshot({ events: 60, runs: 12 });
      const now = Date.now();
      const name = selectedSession(requested);
      const state = {
        live: false, selectedSession: name || '', url: '', tabs: [], pacing: '',
        status: '没有活动会话', pending: pacing.pending, pendings: pacing.pendings, sessions: [],
        totals, runs, events, health: '',
      };
      state.sessions = sessions.list().map((sessionName) => {
        const record = sessions.raw(sessionName);
        const lastActivity = record?.lastActionAt || record?.startedAt;
        return {
          name: sessionName, origin: record?.origin ?? 'unknown', pid: record?.pid ?? 0,
          tabs: record?.pages instanceof Map ? record.pages.size : 0,
          actions: record?.actionsTaken ?? 0, cooldowns: record?.cooldowns ?? 0,
          idleMs: lastActivity ? Math.max(0, now - lastActivity) : null,
        };
      });
      if (!name) return state;
      try {
        const { session, tabs } = await sessions.page(name);
        return {
          ...state, live: true, url: session.lastUrl || '',
          tabs: tabs.map((tab) => ({ index: tab.index, title: tab.title, url: tab.url, active: tab.active })),
          pacing: pacing.describe(session),
          // The run, as the board shows it: which windows exist, what each is on, how much of
          // the allowance is spent, and anything waiting for a person.
          task: task ? task.status : null,
          status: pacing.pendingFor(name) ? '等待批准' : '空闲',
          health: `浏览器已连接 · 会话 ${name} · profile ${sessions.describeProfile(session)}`,
        };
      } catch (error) {
        return { ...state, status: `没有可看的页面（${error?.message ?? error}）` };
      }
    },
  };
}
