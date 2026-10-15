<template>
  <main>
    <el-button @click="goHome">home</el-button>
    <span>返回home</span>
    <div class="flex">
      <span>我是图标:</span>
      <plus theme="outline" size="28" />
    </div>
  </main>
</template>

<script setup>
import { useRouter } from 'vue-router'
// Introducing icons
// https://iconpark.oceanengine.com/home
import { Plus } from '@icon-park/vue-next/es'
const router = useRouter()
const goHome = () => {
  router.push('/')
}
</script>
