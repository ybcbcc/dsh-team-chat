/** Native DSH registration. The panel and browser share workbench.js. */
window.__ModuleLoader__.load({
  id: '@local/dsh-codex-chat',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const PANEL_ID = '@local/dsh-codex-chat'
    const NS = 'codexChat'
    const dictionaries = {
      en: { 'type.label': 'Scenario team', 'guide.title': 'Scenario collaboration', 'guide.description': 'Work with Codex and DeepSeek in a team with scenario memory' },
      zh: { 'type.label': '场景协作', 'guide.title': '场景协作', 'guide.description': '与 Codex、DeepSeek 团队协作，持续积累场景记忆' },
    }

    function report(error) {
      void fetch('/codex-chat/log', { method: 'POST', headers: { 'content-type': 'text/plain' },
        body: `workbench client: ${error?.stack || error}` }).catch(() => {})
    }

    function GuideIcon(props) {
      return h('span', { ...props, 'aria-hidden': true }, '⇄')
    }

    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: undefined }
      }
      static getDerivedStateFromError(error) { return { error } }
      componentDidCatch(error) { report(error) }
      render() {
        if (this.state.error) return h('div', { style: { padding: 16 } }, `工作区加载失败。${this.state.error.message}`)
        return this.props.children
      }
    }

    function Body(props) {
      const root = React.useRef(null)
      const info = typeof props.useTabInfo === 'function' ? props.useTabInfo() : undefined
      const infoRef = React.useRef(info)
      infoRef.current = info
      const cwd = props.useSessions ? props.useSessions(sessions => sessions.byId[props.sessionId]?.cwd) : undefined
      const sessionTitle = props.useSessions ? props.useSessions(sessions => sessions.byId[props.sessionId]?.title) : undefined
      React.useEffect(() => {
        root.current?.dispatchEvent(new Event('sc-layout-change'))
      }, [info?.sidebar.fullscreen])
      React.useEffect(() => {
        let disposed = false
        let unmount
        const link = document.createElement('link')
        link.rel = 'stylesheet'
        link.href = `/codex-chat/assets/workbench.css?v=${Date.now()}`
        document.head.appendChild(link)
        const expand = automatic => {
          if (automatic && infoRef.current?.sidebar.fullscreen) return
          const target = props.sidebar.commandTarget(root.current)
          if (target) props.sidebar.toggleFullscreen(target)
        }
        import(`/codex-chat/assets/workbench.js?v=${Date.now()}`).then(async module => {
          if (disposed) return
          const cleanup = await module.mountWorkbench(root.current, {
            sessionId: props.sessionId, sessionTitle, cwd,
            pickDirectory: async () => globalThis.__DSH_DIRECTORY_PICKER__?.pick(),
            onExpand: () => expand(false), onRunStart: () => expand(true),
            openSession: sessionId => {
              if (!props.navigation.openSession) return false
              props.navigation.openSession(sessionId)
              return true
            },
            isExpanded: () => infoRef.current?.sidebar.fullscreen === true,
          })
          if (disposed) cleanup()
          else unmount = cleanup
        }).catch(error => {
          report(error)
          if (!disposed && root.current) root.current.textContent = `工作区加载失败。${error.message}`
        })
        return () => {
          disposed = true
          unmount?.()
          link.remove()
        }
      }, [props.sessionId, cwd, props.sidebar])
      return h('div', { ref: root, style: { height: '100%', minHeight: 0, containerType: 'inline-size', containerName: 'scenario-workspace' } })
    }

    return {
      inject: ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight'],
      apply(ctx) {
        const navigation = {}
        ctx.inject(['uiWorkspace'], inner => {
          navigation.openSession = sessionId => inner.uiWorkspace.openSession(sessionId)
          inner.effect(() => () => { delete navigation.openSession }, 'codex-chat: workspace navigation')
        })
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, dictionaries), 'codex-chat: dictionaries')
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: PANEL_ID, kind: 'codex-chat', priority: 'extension', title: () => t('type.label'),
          guide: [{ id: 'panel', order: 12, title: () => t('guide.title'), description: () => t('guide.description'), icon: GuideIcon }],
        }), 'codex-chat: tab type')
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab', key: PANEL_ID, locale: NS,
        }, function PanelBody(props) {
          return h(Boundary, null, h(Body, { ...props, sidebar: ctx.sidebarRight, navigation }))
        })), 'codex-chat: tab body')
      },
    }
  },
})
