/** The browser entry uses the same workbench module as the native DSH panel. */
export const CHAT_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>场景协作</title>
<link rel="stylesheet" href="/codex-chat/assets/workbench.css">
<style>html,body{margin:0;height:100%;overflow:hidden}#workbench{height:100%}</style>
</head>
<body>
<main id="workbench"></main>
<script type="module">
import { mountWorkbench } from '/codex-chat/assets/workbench.js'
const root = document.getElementById('workbench')
const parameters = new URLSearchParams(location.search)
mountWorkbench(root, { sessionId: parameters.get('dshSession') || '' }).catch(error => {
  root.textContent = '工作区加载失败。' + error.message
})
</script>
</body>
</html>`
