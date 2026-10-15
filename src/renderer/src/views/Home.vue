<template>
  <main class="flex flex-col">
    <div class="w-[200px] flex flex-col">
      <el-button style="width: fit-content" @click="goOther">other</el-button>
      <span>去other</span>
    </div>
  </main>
</template>

<script setup>
import { useRouter } from 'vue-router'
const router = useRouter()
const goOther = () => router.push('/other')
</script>
<style scoped></style>
