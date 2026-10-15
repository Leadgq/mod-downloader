<script setup></script>

<template>
  <div class="app-shell">
    <RouterView v-slot="{ Component }">
      <Suspense>
        <component :is="Component"></component>
      </Suspense>
    </RouterView>
  </div>
</template>

<style scoped>
.app-shell {
  min-height: 100%;
}
</style>
