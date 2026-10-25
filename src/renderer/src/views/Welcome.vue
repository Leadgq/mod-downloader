<template>
  <main class="welcome-page">
    <section class="welcome-card">
      <p class="eyebrow">YOUR FILES, IN FLOW</p>
      <h1>Nox Downloader<span class="title-dot">.</span></h1>
      <p class="lead">添加链接，剩下的交给下载队列。</p>

      <ul class="feature-list">
        <li>
          <el-icon :size="18"><Download /></el-icon>
          <div>
            <h2>多连接高速下载</h2>
            <p>普通文件单任务最多 16 连接，支持断点续传，中断后可继续。</p>
          </div>
        </li>
        <li>
          <el-icon :size="18"><VideoPlay /></el-icon>
          <div>
            <h2>m3u8 流媒体下载</h2>
            <p>粘贴 .m3u8 链接自动下载全部分片，解密合并后转为 .mp4 / .m4a，手机直接播放。</p>
          </div>
        </li>
        <li>
          <el-icon :size="18"><Key /></el-icon>
          <div>
            <h2>Cookie 支持</h2>
            <p>针对需要登录或浏览器验证的站点，可在高级设置里填写 Cookie 完成下载。</p>
          </div>
        </li>
        <li>
          <el-icon :size="18"><List /></el-icon>
          <div>
            <h2>任务队列与历史</h2>
            <p>自动排队、暂停 / 继续、可调整同时下载数量；下载记录自动保留。</p>
          </div>
        </li>
      </ul>

      <el-button type="primary" size="large" class="start-button" @click="start">
        开始使用
      </el-button>
    </section>
  </main>
</template>

<script setup>
import { Download, Key, List, VideoPlay } from '@element-plus/icons-vue'
import { useRouter } from 'vue-router'
import { useConfigStore } from '@renderer/store'

const router = useRouter()
const store = useConfigStore()

function start() {
  store.welcomed = true
  router.push({ name: 'Home' })
}
</script>

<style scoped>
.welcome-page {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 36px;
  background: radial-gradient(ellipse at 0 0, #3ddc9709, transparent 45%), var(--bg);
}
.welcome-card {
  width: min(560px, 100%);
  padding: 44px 48px 40px;
  border: 1px solid var(--border);
  border-radius: 16px;
  background: var(--surface);
}
.eyebrow {
  color: var(--accent);
  font-size: 10px;
  letter-spacing: 0.2em;
  margin: 0 0 8px;
}
h1 {
  font-size: 28px;
  font-weight: 600;
  letter-spacing: -0.04em;
  margin: 0;
}
.title-dot {
  color: var(--accent);
}
.lead {
  color: var(--muted);
  font-size: 13px;
  margin: 9px 0 30px;
}
.feature-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.feature-list li {
  display: flex;
  gap: 14px;
  align-items: flex-start;
}
.feature-list li > .el-icon {
  color: var(--accent);
  margin-top: 2px;
  flex-shrink: 0;
}
.feature-list h2 {
  font-size: 14px;
  font-weight: 500;
  color: var(--text);
  margin: 0 0 4px;
}
.feature-list p {
  font-size: 12px;
  color: var(--muted);
  margin: 0;
  line-height: 1.6;
}
.start-button {
  width: 100%;
  margin-top: 34px;
}
@media (prefers-reduced-motion: reduce) {
  :deep(*) {
    transition: none !important;
    animation: none !important;
  }
}
</style>
