<script setup></script>

<template>
  <div>
    <RouterView v-slot="{ Component }">
      <Suspense>
        <component :is="Component"></component>
      </Suspense>
    </RouterView>
  </div>
</template>

<style lang="less"></style>
