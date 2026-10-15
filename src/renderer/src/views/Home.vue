<template>
  <main class="page">
    <header class="hero">
      <p class="kicker">Aria2 · Range · Resume</p>
      <h1>深黑下载器</h1>
      <p class="lede">多连接分段拉取，同一路径再次开始会从断点续上。</p>
    </header>

    <section class="panel" aria-labelledby="url-label">
      <label id="url-label" class="field-label" for="download-url">下载地址</label>
      <el-input
        id="download-url"
        v-model="store.url"
        size="large"
        clearable
        placeholder="https://dmod.3dmgame.com/static/upload/resource2/....zip"
      />
    </section>

    <section class="panel" aria-labelledby="query-label">
      <div class="panel-head">
        <h2 id="query-label">查询参数</h2>
        <el-button size="small" @click="addQuery">添加</el-button>
      </div>
      <div v-for="(item, index) in store.query" :key="index" class="kv-row">
        <el-input v-model="item.key" placeholder="key" />
        <el-input v-model="item.value" placeholder="value" />
        <el-button :icon="Delete" circle aria-label="删除参数" @click="removeQuery(index)" />
      </div>
    </section>

    <section class="panel grid-2" aria-labelledby="settings-label">
      <h2 id="settings-label" class="sr-only">下载设置</h2>
      <div class="field">
        <label class="field-label" for="save-dir">保存目录</label>
        <div class="dir-row">
          <el-input id="save-dir" v-model="store.dir" placeholder="选择一个本地文件夹" readonly />
          <el-button @click="chooseDir">浏览</el-button>
        </div>
      </div>
      <div class="field">
        <label class="field-label" for="filename">文件名（可选）</label>
        <el-input id="filename" v-model="store.filename" placeholder="留空则使用服务器文件名" />
      </div>
      <div class="field span-2">
        <label class="field-label" for="connections">并发连接 {{ store.connections }}</label>
        <el-slider id="connections" v-model="store.connections" :min="1" :max="16" :step="1" show-stops />
      </div>
    </section>

    <el-collapse class="cookie-fold">
      <el-collapse-item name="cookie">
        <template #title>
          <span class="cookie-title">Cookie（可选）</span>
          <span class="cookie-hint">直链一般不用填</span>
        </template>
        <el-input
          v-model="store.cookie"
          type="textarea"
          :rows="3"
          placeholder="name=value; 另一段=..."
        />
      </el-collapse-item>
    </el-collapse>

    <div class="actions">
      <el-button type="primary" :loading="starting" :disabled="busy" @click="onStart">开始</el-button>
      <el-button :disabled="progress.status !== 'active'" @click="onPause">暂停</el-button>
      <el-button :disabled="progress.status !== 'paused'" @click="onResume">继续</el-button>
      <el-button type="danger" plain :disabled="!hasTask" @click="onCancel">取消</el-button>
    </div>

    <section class="progress-card" aria-live="polite">
      <div v-if="progress.status === 'idle'" class="empty">还没有任务</div>
      <template v-else>
        <div class="progress-meta">
          <strong>{{ statusLabel }}</strong>
          <span class="font-mono-num">{{ percentText }}</span>
        </div>
        <el-progress :percentage="displayPercent" :stroke-width="10" :show-text="false" color="#3DDC97" />
        <dl class="stats">
          <div>
            <dt>已下 / 总量</dt>
            <dd class="font-mono-num">{{ formatBytes(progress.completedLength) }} / {{ formatBytes(progress.totalLength) }}</dd>
          </div>
          <div>
            <dt>速度</dt>
            <dd class="font-mono-num">{{ formatSpeed(progress.downloadSpeed) }}</dd>
          </div>
          <div>
            <dt>剩余</dt>
            <dd class="font-mono-num">{{ remainingText }}</dd>
          </div>
          <div>
            <dt>连接</dt>
            <dd class="font-mono-num">{{ progress.connections || 0 }}</dd>
          </div>
        </dl>
        <p v-if="progress.filename" class="filename">{{ progress.filename }}</p>
        <p v-if="progress.errorMessage" class="error">{{ progress.errorMessage }}</p>
      </template>
    </section>
  </main>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Delete } from '@element-plus/icons-vue'
import { useConfigStore } from '@renderer/store'

const store = useConfigStore()
const starting = ref(false)
const progress = reactive({
  status: 'idle',
  completedLength: 0,
  totalLength: 0,
  downloadSpeed: 0,
  connections: 0,
  errorMessage: '',
  percent: 0,
  filename: ''
})

let stopProgress = null

const busy = computed(() => progress.status === 'active' || progress.status === 'waiting')
const hasTask = computed(() => ['active', 'waiting', 'paused', 'error'].includes(progress.status))
const displayPercent = computed(() => Math.round(progress.percent || 0))
const percentText = computed(() => `${displayPercent.value}%`)

const statusLabel = computed(() => {
  const map = {
    waiting: '排队中',
    active: '下载中',
    paused: '已暂停',
    complete: '已完成',
    error: '失败'
  }
  return map[progress.status] || progress.status
})

const remainingText = computed(() => {
  const left = progress.totalLength - progress.completedLength
  if (!progress.downloadSpeed || left <= 0) return '--'
  const seconds = Math.round(left / progress.downloadSpeed)
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
})

function formatBytes(value) {
  const n = Number(value) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatSpeed(value) {
  return `${formatBytes(value)}/s`
}

function addQuery() {
  store.query.push({ key: '', value: '' })
}

function removeQuery(index) {
  if (store.query.length === 1) {
    store.query[0] = { key: '', value: '' }
    return
  }
  store.query.splice(index, 1)
}

function applyProgress(data) {
  Object.assign(progress, data)
}

async function chooseDir() {
  const dir = await window.api.chooseDir()
  if (dir) store.dir = dir
}

function validate() {
  if (!store.url.trim()) {
    ElMessage.error('请填写下载地址')
    return false
  }
  try {
    new URL(store.url.trim())
  } catch {
    ElMessage.error('下载地址不是合法 URL')
    return false
  }
  if (!store.dir) {
    ElMessage.error('请选择保存目录')
    return false
  }
  return true
}

async function onStart() {
  if (!validate()) return
  starting.value = true
  try {
    await window.api.start({
      url: store.url.trim(),
      query: store.query.map((item) => ({ key: item.key, value: item.value })),
      dir: store.dir,
      filename: store.filename.trim(),
      connections: Number(store.connections),
      cookie: String(store.cookie || '')
    })
  } catch (error) {
    ElMessage.error(error.message || '开始失败')
  } finally {
    starting.value = false
  }
}

async function onPause() {
  try {
    await window.api.pause()
  } catch (error) {
    ElMessage.error(error.message || '暂停失败')
  }
}

async function onResume() {
  try {
    await window.api.resume()
  } catch (error) {
    ElMessage.error(error.message || '继续失败')
  }
}

async function onCancel() {
  try {
    await window.api.cancel()
  } catch (error) {
    ElMessage.error(error.message || '取消失败')
  }
}

onMounted(() => {
  if (!store.query.length) store.query.push({ key: '', value: '' })
  stopProgress = window.api?.onProgress?.(applyProgress)
})

onUnmounted(() => {
  stopProgress?.()
})
</script>

<style scoped>
.page {
  min-height: 100%;
  padding: 36px 40px 48px;
  background:
    radial-gradient(900px 420px at 12% -10%, rgba(61, 220, 151, 0.08), transparent 60%),
    radial-gradient(700px 360px at 100% 0%, rgba(80, 110, 180, 0.08), transparent 55%),
    #050608;
}

.hero {
  margin-bottom: 28px;
}

.kicker {
  color: #3ddc97;
  font-size: 12px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  margin-bottom: 8px;
}

h1 {
  font-size: 36px;
  letter-spacing: -0.04em;
  line-height: 1.1;
}

.lede {
  margin-top: 8px;
  color: #8b93a7;
  max-width: 40rem;
}

.panel,
.progress-card,
.cookie-fold {
  background: #0e1116;
  border: 1px solid #1c212b;
  border-radius: 16px;
  padding: 18px 18px 16px;
  margin-bottom: 14px;
}

.panel-head,
.progress-meta,
.dir-row,
.kv-row,
.actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.panel-head {
  justify-content: space-between;
  margin-bottom: 12px;
}

.panel-head h2,
.field-label {
  font-size: 13px;
  color: #8b93a7;
}

.field-label {
  display: block;
  margin-bottom: 8px;
}

.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

.span-2 {
  grid-column: 1 / -1;
}

.kv-row {
  margin-bottom: 8px;
}

.dir-row .el-input {
  flex: 1;
}

.cookie-fold {
  padding: 0 18px;
}

.cookie-title {
  color: #e8edf5;
}

.cookie-hint {
  margin-left: 10px;
  color: #8b93a7;
  font-size: 12px;
}

.actions {
  margin: 8px 0 16px;
}

.progress-card {
  min-height: 148px;
}

.progress-meta {
  justify-content: space-between;
  margin-bottom: 12px;
}

.empty {
  height: 116px;
  display: grid;
  place-items: center;
  color: #8b93a7;
}

.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-top: 16px;
}

.stats dt {
  color: #8b93a7;
  font-size: 12px;
}

.stats dd {
  margin-top: 4px;
  font-size: 14px;
}

.filename,
.error {
  margin-top: 12px;
  font-size: 13px;
}

.filename {
  color: #8b93a7;
  overflow-wrap: anywhere;
}

.error {
  color: #f07178;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  border: 0;
}
</style>
