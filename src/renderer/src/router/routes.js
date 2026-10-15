import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/:any(.*)*',
      name: 'Home',
      component: () => import('../views/Home.vue')
    },
    {
      path: '/other',
      name: 'Other',
      component: () => import('../views/Other.vue')
    }
  ]
})

export default router
