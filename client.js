/** Native Conversation view and browser entry share workbench.js. */
window.__ModuleLoader__.load({
  id: '@local/dsh-codex-chat',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const h = React.createElement
    const VIEW_ID = 'codex-chat'
    const NS = 'codexChat'
    const dictionaries = {
      en: { 'type.label': 'Scenario team' },
      zh: { 'type.label': '场景协作' },
    }

    function report(error) {
      void fetch('/codex-chat/log', { method: 'POST', headers: { 'content-type': 'text/plain' },
        body: `workbench client: ${error?.stack || error}` }).catch(() => {})
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
      const cwd = props.useSessions ? props.useSessions(sessions => sessions.byId[props.sessionId]?.cwd) : undefined
      const sessionTitle = props.useSessions ? props.useSessions(sessions => sessions.byId[props.sessionId]?.title) : undefined
      React.useEffect(() => {
        let disposed = false
        let unmount
        const link = document.createElement('link')
        link.rel = 'stylesheet'
        link.href = `/codex-chat/assets/workbench.css?v=${Date.now()}`
        document.head.appendChild(link)
        import(`/codex-chat/assets/workbench.js?v=${Date.now()}`).then(async module => {
          if (disposed) return
          const cleanup = await module.mountWorkbench(root.current, {
            sessionId: props.sessionId, sessionTitle, cwd,
            pickDirectory: async () => globalThis.__DSH_DIRECTORY_PICKER__?.pick(),
            openSession: sessionId => {
              if (!props.navigation.openSession) return false
              props.navigation.openSession(sessionId)
              return true
            },
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
      }, [props.sessionId, sessionTitle, cwd])
      return h('div', { ref: root, 'data-scenario-conversation': '' })
    }

    function BlankSessionEntry(props) {
      const [container, setContainer] = React.useState(null)
      const body = container && createPortal(h('div', { className: 'sc-blank-session' },
        h('button', { type: 'button', onClick: () => setContainer(null) }, '返回内置对话'),
        h(Boundary, null, h(Body, props))), container)
      return h(React.Fragment, null,
        h('button', { type: 'button', onClick: event => setContainer(event.currentTarget.closest('[data-conversation-scroll]')) }, props.label), body)
    }

    return {
      inject: ['slots', 'locale', 'uiConversation'],
      apply(ctx) {
        const navigation = {}
        ctx.inject(['uiWorkspace'], inner => {
          navigation.openSession = sessionId => inner.uiWorkspace.openSession(sessionId)
          inner.effect(() => () => { delete navigation.openSession }, 'codex-chat: workspace navigation')
        })
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, dictionaries), 'codex-chat: dictionaries')
        ctx.effect(() => ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view', id: VIEW_ID, order: 5, locale: NS, label: () => t('type.label'),
        }, function ConversationView(props) {
          return h(Boundary, null, h(Body, { ...props, navigation }))
        })), 'codex-chat: Conversation view')
        ctx.effect(() => ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
          name: 'conversation.hero.options', id: VIEW_ID, locale: NS,
        }, function HeroEntry(props) {
          return h(BlankSessionEntry, { ...props, navigation, label: t('type.label') })
        })), 'codex-chat: blank Conversation entry')
      },
    }
  },
})
