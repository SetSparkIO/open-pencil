import { createRouter, createWebHistory } from 'vue-router'

import { COLLABORATION_AVAILABLE } from '@/app/collab/availability'

import WorkspaceView from './views/WorkspaceView.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: WorkspaceView },
    { path: '/storage', redirect: '/' },
    { path: '/demo', component: WorkspaceView, meta: { demo: true } },
    COLLABORATION_AVAILABLE
      ? { path: '/share/:roomId', component: WorkspaceView }
      : { path: '/share/:roomId', redirect: '/' }
  ]
})

export default router
