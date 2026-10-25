import { createRouter, createWebHistory } from 'vue-router'
import { useConfigStore } from '@renderer/store'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/welcome',
      name: 'Welcome',
      component: () => import('../views/Welcome.vue')
    },
    {
      path: '/:any(.*)*',
      name: 'Home',
      component: () => import('../views/Home.vue')
    }
  ]
})

// 仅首次启动展示欢迎页；点“开始使用”后不再出现
router.beforeEach((to) => {
  const store = useConfigStore()
  if (!store.welcomed && to.name !== 'Welcome') return { name: 'Welcome' }
  if (store.welcomed && to.name === 'Welcome') return { name: 'Home' }
})

export default router
