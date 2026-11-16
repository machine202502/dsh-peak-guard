/**
 * Browser half of dsh-peak-guard: the Session header switch and the language form.
 *
 * The switch only reports and flips a per-Session flag through the plugin's
 * loopback bridge; every decision about when to speak lives in index.js.
 *
 * @module dsh-peak-guard
 */

window.__ModuleLoader__.load({
  id: '@machine202502/dsh-peak-guard',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PORT = 49238;
    const base = `http://127.0.0.1:${PORT}`;
    const LANGUAGES = ['ru', 'en', 'zh', 'auto'];

    const STRINGS = {
      ru: {
        label: 'ПИК',
        onTip: 'Слежу за пиком: предупрежу о начале и верну к работе в конце',
        onPeakTip: 'Пик идёт. Сессия предупреждена и будет продолжена после пика',
        offTip: 'Выключено. Нажми, чтобы следить за пиком',
        noData: 'Расписание пика неизвестно',
        peakUntil: 'до {time}',
        settingsTitle: 'Язык',
        settingsHint: 'Авто — по языку приложения',
        save: 'Сохранить',
        saving: 'Сохраняю…',
        saved: 'Сохранено',
        saveFailed: 'Не удалось сохранить',
        loading: 'Загружаю…',
        offline: 'Сервис недоступен',
        auto: 'Авто',
      },
      en: {
        label: 'PEAK',
        onTip: 'Watching the peak: I warn at its start and resume work at its end',
        onPeakTip: 'Peak is running. The Session was warned and will resume after it',
        offTip: 'Off. Click to watch the peak',
        noData: 'Peak schedule is unknown',
        peakUntil: 'until {time}',
        settingsTitle: 'Language',
        settingsHint: 'Auto follows the application language',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved',
        saveFailed: 'Could not save',
        loading: 'Loading…',
        offline: 'Service is unavailable',
        auto: 'Auto',
      },
      zh: {
        label: '高峰',
        onTip: '正在盯高峰：开始时提醒，结束时恢复工作',
        onPeakTip: '高峰进行中。会话已收到提醒，结束后会继续',
        offTip: '已关闭。点击以盯住高峰',
        noData: '高峰时段未知',
        peakUntil: '到 {time}',
        settingsTitle: '语言',
        settingsHint: '自动跟随应用语言',
        save: '保存',
        saving: '保存中…',
        saved: '已保存',
        saveFailed: '保存失败',
        loading: '加载中…',
        offline: '服务不可用',
        auto: '自动',
      },
    };

    let stylesReady = false;
    function ensureStyles() {
      if (stylesReady || typeof document === 'undefined') return;
      stylesReady = true;
      const style = document.createElement('style');
      style.textContent = `
        .pg-chip { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 9px;
          border-radius: 999px; border: 1px solid rgba(120,120,120,.34); background: transparent;
          color: inherit; font: inherit; font-size: 12px; line-height: 1; cursor: pointer; opacity: .72; }
        .pg-chip:hover { opacity: 1; }
        .pg-chip--on { opacity: 1; border-color: rgba(64,120,255,.55); background: rgba(64,120,255,.08); }
        .pg-chip--peak { border-color: rgba(229,72,77,.5); background: rgba(229,72,77,.08); }
        .pg-chip:disabled { cursor: default; opacity: .5; }
        .pg-dot { width: 6px; height: 6px; border-radius: 50%; background: #8b8b8b; }
        .pg-chip--on .pg-dot { background: #4078ff; }
        .pg-chip--peak .pg-dot { background: #e5484d; }
        .pg-strong { font-weight: 600; letter-spacing: .02em; }
        .pg-set { display: flex; flex-direction: column; gap: 10px; }
        .pg-set-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
        .pg-set-hint { font-size: 12px; opacity: .65; margin-top: 2px; }
        .pg-set select { min-width: 160px; padding: 4px 8px; border-radius: 8px;
          border: 1px solid rgba(120,120,120,.4); background: transparent; color: inherit; font: inherit; }
        .pg-set-foot { display: flex; align-items: center; gap: 12px; }
        .pg-set button { padding: 5px 12px; border-radius: 8px; border: 1px solid rgba(64,120,255,.5);
          background: rgba(64,120,255,.1); color: inherit; font: inherit; cursor: pointer; }
        .pg-set button:disabled { opacity: .5; cursor: default; }
        .pg-set-note { font-size: 12px; }
        .pg-set-note--error { color: #e5484d; }
      `;
      document.head.appendChild(style);
    }

    /** Application language, falling back through the document then the browser. */
    function detectLanguage() {
      const fromDocument = (document?.documentElement?.lang ?? '').toLowerCase();
      const fromBrowser = (typeof navigator !== 'undefined' ? navigator.language : '').toLowerCase();
      const tag = fromDocument || fromBrowser;
      if (tag.startsWith('ru')) return 'ru';
      if (tag.startsWith('zh')) return 'zh';
      return 'en';
    }

    function resolveChoice(choice) {
      if (choice === 'ru' || choice === 'en' || choice === 'zh') return choice;
      return detectLanguage();
    }

    const clock = (ms, language) => new Date(ms).toLocaleTimeString(language === 'en' ? 'en-US' : language === 'zh' ? 'zh-CN' : 'ru-RU', { hour: '2-digit', minute: '2-digit' });
    const fill = (template, values) => template.replace(/\{(\w+)\}/g, (match, key) => (values[key] === undefined ? match : String(values[key])));

    function PeakChip({ sessionId }) {
      const [data, setData] = React.useState(null);
      const [busy, setBusy] = React.useState(false);

      React.useEffect(() => {
        if (sessionId === undefined) return undefined;
        let alive = true;
        const load = async () => {
          try {
            const response = await fetch(`${base}/state?session=${encodeURIComponent(sessionId)}`, { cache: 'no-store' });
            if (response.ok && alive) setData(await response.json());
          } catch {
            /* the bridge is down; the chip keeps its last state */
          }
        };
        void load();
        const timer = setInterval(() => void load(), 20000);
        const onChange = () => void load();
        window.addEventListener('dsh-peak-guard:settings', onChange);
        return () => {
          alive = false;
          clearInterval(timer);
          window.removeEventListener('dsh-peak-guard:settings', onChange);
        };
      }, [sessionId]);

      const toggle = async (event) => {
        event.stopPropagation();
        if (busy || sessionId === undefined) return;
        setBusy(true);
        try {
          const response = await fetch(`${base}/toggle`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ session: sessionId }),
          });
          if (response.ok) setData(await response.json());
        } catch {
          /* leave the previous state in place */
        } finally {
          setBusy(false);
        }
      };

      if (sessionId === undefined) return null;

      const language = data?.language === 'en' ? 'en' : data?.language === 'zh' ? 'zh' : 'ru';
      const strings = STRINGS[language];
      const known = data !== null && Array.isArray(data.windows) && data.windows.length > 0;
      const enabled = data?.enabled === true;
      const peak = data?.peak === true;
      const title = !known
        ? strings.noData
        : enabled
          ? peak
            ? strings.onPeakTip
            : strings.onTip
          : strings.offTip;

      return h('button', {
        type: 'button',
        className: ['pg-chip', enabled ? 'pg-chip--on' : '', enabled && peak ? 'pg-chip--peak' : ''].filter(Boolean).join(' '),
        title,
        disabled: busy,
        onClick: toggle,
      },
        h('span', { className: 'pg-dot' }),
        h('span', { className: 'pg-strong' }, strings.label),
        enabled && peak && typeof data.boundaryAt === 'number'
          ? h('span', null, fill(strings.peakUntil, { time: clock(data.boundaryAt, language) }))
          : null,
      );
    }

    function PeakSettings() {
      ensureStyles();
      const [state, setState] = React.useState({ status: 'loading', values: {}, defaults: {} });
      const [choice, setChoice] = React.useState('ru');
      const [saving, setSaving] = React.useState(false);
      const [notice, setNotice] = React.useState({ text: '', error: false });
      const [strings, setStrings] = React.useState(STRINGS.ru);

      React.useEffect(() => {
        let alive = true;
        fetch(`${base}/settings`, { cache: 'no-store' })
          .then((response) => response.json())
          .then((body) => {
            if (!alive) return;
            const stored = body.values?.language ?? body.defaults?.language ?? 'ru';
            setChoice(LANGUAGES.includes(stored) ? stored : 'ru');
            setStrings(STRINGS[resolveChoice(stored)] ?? STRINGS.ru);
            setState({ status: 'ready', values: body.values ?? {}, defaults: body.defaults ?? {} });
          })
          .catch(() => {
            if (alive) setState({ status: 'error', values: {}, defaults: {} });
          });
        return () => {
          alive = false;
        };
      }, []);

      const pick = (next) => {
        setChoice(next);
        setStrings(STRINGS[resolveChoice(next)] ?? STRINGS.ru);
        setNotice({ text: '', error: false });
      };

      const save = async () => {
        setSaving(true);
        setNotice({ text: '', error: false });
        try {
          const response = await fetch(`${base}/settings`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ language: choice }),
          });
          const body = await response.json();
          if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
          setState({ status: 'ready', values: body.values ?? {}, defaults: body.defaults ?? {} });
          setNotice({ text: strings.saved, error: false });
          window.dispatchEvent(new CustomEvent('dsh-peak-guard:settings'));
        } catch (error) {
          setNotice({ text: `${strings.saveFailed}: ${String(error?.message ?? error)}`, error: true });
        } finally {
          setSaving(false);
        }
      };

      if (state.status === 'loading') return h('div', { className: 'pg-set' }, h('span', { className: 'pg-set-hint' }, strings.loading));
      if (state.status === 'error') return h('div', { className: 'pg-set' }, h('span', { className: 'pg-set-note pg-set-note--error' }, strings.offline));

      return h('div', { className: 'pg-set' },
        h('div', { className: 'pg-set-row' },
          h('div', null,
            h('div', null, strings.settingsTitle),
            h('div', { className: 'pg-set-hint' }, strings.settingsHint),
          ),
          h('select', {
            value: choice,
            onChange: (event) => pick(event.target.value),
          },
            h('option', { value: 'ru' }, 'Русский'),
            h('option', { value: 'en' }, 'English'),
            h('option', { value: 'zh' }, '中文'),
            h('option', { value: 'auto' }, strings.auto),
          ),
        ),
        h('div', { className: 'pg-set-foot' },
          h('button', { type: 'button', onClick: save, disabled: saving }, saving ? strings.saving : strings.save),
          notice.text === '' ? null : h('span', { className: `pg-set-note${notice.error ? ' pg-set-note--error' : ''}` }, notice.text),
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ensureStyles();
        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
          {
            name: 'conversation.session.header.utilities',
            id: 'peak-guard',
            order: 520,
          },
          (props) => h(PeakChip, props),
        ));
        try {
          ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
            name: 'plugins.row.config',
            key: 'dsh-peak-guard#peak-guard',
          }, () => h(PeakSettings)));
        } catch (error) {
          console.warn('dsh-peak-guard: settings form registration failed', error);
        }
      },
    };
  },
});
