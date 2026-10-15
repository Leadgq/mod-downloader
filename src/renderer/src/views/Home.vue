<template>
  <main class="downloads-page">
    <header class="page-header">
      <div>
        <p class="eyebrow">YOUR FILES, IN FLOW</p>
        <h1>深黑下载器<span class="title-dot">.</span></h1>
        <p class="subtitle">添加链接，剩下的交给下载队列。</p>
      </div>
      <el-button type="primary" size="large" :icon="Plus" :disabled="loading" @click="openNew">
        新建下载
      </el-button>
    </header>

    <el-alert v-if="loadError" :title="loadError" type="error" show-icon :closable="false">
      <el-button link @click="load">重新加载</el-button>
    </el-alert>
    <el-alert
      v-if="state.warning"
      :title="state.warning"
      type="warning"
      show-icon
      :closable="false"
    />

    <section class="download-workspace" aria-label="下载任务">
      <div class="list-toolbar">
        <div class="filters" role="group" aria-label="任务状态筛选">
          <button
            v-for="item in filters"
            :key="item.key"
            class="filter-button"
            :class="{ selected: filter === item.key }"
            :aria-pressed="filter === item.key"
            @click="filter = item.key"
          >
            {{ item.label }} <span>{{ counts[item.key] }}</span>
          </button>
        </div>
        <el-input
          v-model="search"
          class="search"
          :prefix-icon="Search"
          placeholder="搜索文件名"
          aria-label="搜索文件名"
          clearable
        />
      </div>

      <div v-if="loading" class="empty-state" role="status">正在读取下载记录…</div>
      <div v-else-if="!visibleTasks.length" class="empty-state">
        <div class="empty-symbol">
          <el-icon :size="30"><Download /></el-icon>
        </div>
        <h2>
          {{
            search ? '没有找到匹配的文件' : filter === 'all' ? '从第一个链接开始' : '这里还没有任务'
          }}
        </h2>
        <p>{{ search ? '换个文件名试试。' : '下载进度和历史记录，都会保留在这里。' }}</p>
        <el-button
          v-if="!search && filter === 'all'"
          type="primary"
          plain
          :icon="Plus"
          @click="openNew"
          >新建下载</el-button
        >
      </div>

      <div v-else class="task-list">
        <article
          v-for="task in visibleTasks"
          :key="task.id"
          class="task-card"
          :class="`task-${task.status}`"
        >
          <div class="task-top">
            <div class="file-icon">
              <el-icon :size="22"><Document /></el-icon>
            </div>
            <div class="task-heading">
              <h2 :title="displayName(task)">{{ displayName(task) }}</h2>
              <p :title="task.dir">{{ task.dir }}</p>
            </div>
            <span class="status-label" :class="task.status"><i></i>{{ labels[task.status] }}</span>
          </div>

          <template v-if="!isHistory(task)">
            <div class="progress-caption font-mono-num">
              <span
                >{{ bytes(task.completedLength) }} /
                {{ task.totalLength ? bytes(task.totalLength) : '未知大小' }}</span
              >
              <span>{{ Math.floor(task.percent || 0) }}%</span>
            </div>
            <el-progress
              :percentage="Math.min(100, Math.round(task.percent || 0))"
              :show-text="false"
              :stroke-width="5"
              :color="task.status === 'error' ? '#f07178' : '#3ddc97'"
            />
          </template>

          <div class="task-bottom">
            <div class="task-detail">
              <template v-if="task.status === 'active'">
                <span class="speed font-mono-num">{{ bytes(task.downloadSpeed) }}/s</span>
                <span>剩余 {{ remaining(task) }}</span>
                <span>{{ task.connections }} / {{ task.connectionsLimit }} 连接</span>
              </template>
              <span v-else-if="task.status === 'waiting'">等待空闲位置，自动开始</span>
              <span v-else-if="task.status === 'paused'">{{
                task.needsCookie ? '继续前需重新填写 Cookie' : '已暂停，可随时继续'
              }}</span>
              <span v-else-if="task.status === 'complete'"
                >{{ bytes(task.totalLength) }} · 完成于 {{ date(task.completedAt) }}</span
              >
              <span v-else-if="task.status === 'cancelled'">已取消 · 已下载的文件仍保留</span>
              <span v-else class="error-text">下载失败</span>
            </div>
            <div class="task-actions" :aria-label="`${displayName(task)}的操作`">
              <template v-if="['active', 'waiting'].includes(task.status)">
                <el-button
                  size="small"
                  :disabled="pending.has(task.id)"
                  @click="operate('pause', task)"
                  >暂停</el-button
                >
              </template>
              <el-button
                v-if="task.status === 'paused'"
                size="small"
                type="primary"
                plain
                :disabled="pending.has(task.id)"
                @click="resume(task)"
                >继续</el-button
              >
              <el-button
                v-if="task.status === 'error'"
                size="small"
                type="primary"
                plain
                :disabled="pending.has(task.id)"
                @click="resume(task)"
                >重试</el-button
              >
              <el-button
                v-if="['error', 'paused'].includes(task.status)"
                size="small"
                :disabled="pending.has(task.id)"
                @click="editTask(task)"
                >编辑</el-button
              >
              <el-button
                v-if="!isHistory(task)"
                size="small"
                :disabled="pending.has(task.id)"
                @click="operate('cancel', task)"
                >取消</el-button
              >
              <template v-else>
                <el-button
                  v-if="task.status === 'complete'"
                  size="small"
                  type="primary"
                  plain
                  :disabled="pending.has(task.id)"
                  @click="openTarget(task, 'file')"
                  >打开文件</el-button
                >
                <el-button
                  size="small"
                  :disabled="pending.has(task.id)"
                  @click="openTarget(task, 'dir')"
                  >打开文件夹</el-button
                >
                <el-dropdown trigger="click" @command="operate('remove', task)">
                  <el-button
                    size="small"
                    :icon="MoreFilled"
                    :disabled="pending.has(task.id)"
                    :aria-label="`${displayName(task)}的更多操作`"
                  />
                  <template #dropdown
                    ><el-dropdown-menu
                      ><el-dropdown-item command="remove"
                        >移除记录（保留文件）</el-dropdown-item
                      ></el-dropdown-menu
                    ></template
                  >
                </el-dropdown>
              </template>
            </div>
          </div>
          <p v-if="task.errorMessage" class="task-error">{{ task.errorMessage }}</p>
        </article>
      </div>
    </section>

    <footer class="queue-footer">
      <div class="queue-summary">
        <span class="live-dot" :class="{ live: activeCount > 0 }"></span
        ><span>{{ activeCount }} 个正在下载</span
        ><strong class="font-mono-num">{{ bytes(totalSpeed) }}/s</strong>
      </div>
      <label class="concurrency-control"
        >同时下载
        <el-select
          :model-value="state.maxConcurrent"
          aria-label="同时下载数量"
          :disabled="changingLimit || loading"
          @change="changeLimit"
        >
          <el-option v-for="n in 5" :key="n" :value="n" :label="`${n} 个`" />
        </el-select>
      </label>
    </footer>

    <el-dialog
      v-model="dialogVisible"
      :title="editingId ? '编辑并继续下载' : '新建下载'"
      width="580px"
      align-center
      :close-on-click-modal="false"
      :close-on-press-escape="!submitting"
      :show-close="!submitting"
      @closed="formError = ''"
    >
      <form class="download-form" @submit.prevent="submit">
        <div class="form-field">
          <label for="task-url">下载地址</label
          ><el-input
            id="task-url"
            v-model="form.url"
            autofocus
            placeholder="https://example.com/file.zip"
            :disabled="submitting"
          />
        </div>
        <div class="form-field">
          <label for="task-dir">保存目录</label>
          <div class="directory-input">
            <el-input
              id="task-dir"
              v-model="form.dir"
              readonly
              placeholder="选择本地文件夹"
            /><el-button :disabled="submitting || Boolean(editingId)" @click="chooseDir"
              >浏览</el-button
            >
          </div>
        </div>
        <div class="form-field">
          <label for="task-filename">文件名 <span>（可选）</span></label
          ><el-input
            id="task-filename"
            v-model="form.filename"
            :disabled="submitting || Boolean(editingId)"
            placeholder="留空则使用服务器文件名"
          />
        </div>
        <p v-if="editingId" class="form-hint">
          保留原目录和文件名，继续使用已下载的部分文件。请确认新链接仍指向同一个文件。
        </p>
        <el-collapse v-model="advanced">
          <el-collapse-item title="高级设置 · 查询参数、Cookie、连接数" name="advanced">
            <div class="advanced-body">
              <div class="query-label">
                <span>查询参数</span
                ><el-button
                  size="small"
                  :disabled="submitting"
                  @click="form.query.push({ key: '', value: '' })"
                  >添加参数</el-button
                >
              </div>
              <div v-for="(item, index) in form.query" :key="index" class="query-row">
                <el-input
                  v-model="item.key"
                  :aria-label="`参数 ${index + 1} 名称`"
                  placeholder="名称"
                  :disabled="submitting"
                />
                <el-input
                  v-model="item.value"
                  :aria-label="`参数 ${index + 1} 值`"
                  placeholder="值"
                  :disabled="submitting"
                />
                <el-button
                  :icon="Delete"
                  aria-label="删除参数"
                  :disabled="submitting"
                  @click="form.query.splice(index, 1)"
                />
              </div>
              <div class="form-field">
                <label for="task-cookie">Cookie <span>（可选）</span></label
                ><el-input
                  id="task-cookie"
                  v-model="form.cookie"
                  type="textarea"
                  :rows="2"
                  :disabled="submitting"
                  placeholder="name=value; name2=value2"
                />
                <p class="form-hint">历史记录不保存 Cookie；重启后继续此任务时需要重新填写。</p>
              </div>
              <div class="form-field">
                <label for="task-connections">单文件连接数 · {{ form.connections }}</label
                ><el-slider
                  id="task-connections"
                  v-model="form.connections"
                  :min="1"
                  :max="16"
                  :step="1"
                  :disabled="submitting"
                />
              </div>
            </div>
          </el-collapse-item>
        </el-collapse>
        <p v-if="formError" class="form-error" role="alert">{{ formError }}</p>
        <div class="dialog-actions">
          <el-button :disabled="submitting" @click="dialogVisible = false">返回</el-button
          ><el-button type="primary" native-type="submit" :loading="submitting">{{
            editingId ? '保存并继续' : '添加下载'
          }}</el-button>
        </div>
      </form>
    </el-dialog>
  </main>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Delete, Document, Download, MoreFilled, Plus, Search } from '@element-plus/icons-vue'
import { useConfigStore } from '@renderer/store'

const store = useConfigStore()
const state = reactive({ tasks: [], maxConcurrent: 2, revision: -1, warning: '' })
const loading = ref(true)
const loadError = ref('')
const filter = ref('all')
const search = ref('')
const pending = reactive(new Set())
const dialogVisible = ref(false)
const editingId = ref(null)
const submitting = ref(false)
const changingLimit = ref(false)
const formError = ref('')
const advanced = ref([])
const form = reactive({ url: '', dir: '', filename: '', query: [], cookie: '', connections: 8 })
const filters = [
  { key: 'all', label: '全部' },
  { key: 'ongoing', label: '进行中' },
  { key: 'complete', label: '已完成' },
  { key: 'cancelled', label: '已取消' }
]
const labels = {
  active: '下载中',
  waiting: '等待下载',
  paused: '已暂停',
  error: '下载失败',
  complete: '已完成',
  cancelled: '已取消'
}
const isHistory = (task) => ['complete', 'cancelled'].includes(task.status)
const matches = (task, key) =>
  key === 'all' || (key === 'ongoing' ? !isHistory(task) : task.status === key)
const counts = computed(() =>
  Object.fromEntries(
    filters.map(({ key }) => [key, state.tasks.filter((task) => matches(task, key)).length])
  )
)
const activeCount = computed(() => state.tasks.filter((task) => task.status === 'active').length)
const totalSpeed = computed(() =>
  state.tasks.reduce((sum, task) => sum + (task.status === 'active' ? task.downloadSpeed : 0), 0)
)
const visibleTasks = computed(() =>
  state.tasks
    .filter(
      (task) =>
        matches(task, filter.value) &&
        displayName(task).toLowerCase().includes(search.value.trim().toLowerCase())
    )
    .sort(
      (a, b) =>
        Number(isHistory(a)) - Number(isHistory(b)) ||
        (isHistory(a) ? b.updatedAt - a.updatedAt : a.createdAt - b.createdAt)
    )
)

function displayName(task) {
  if (task.filename) return task.filename
  try {
    return decodeURIComponent(new URL(task.uri).pathname.split('/').pop()) || '等待获取文件名'
  } catch {
    return '未命名文件'
  }
}
function bytes(value) {
  const n = Number(value) || 0
  if (n < 1024) return `${n} B`
  const power = Math.min(3, Math.floor(Math.log(n) / Math.log(1024)))
  return `${(n / 1024 ** power).toFixed(power === 1 ? 1 : 2)} ${['B', 'KB', 'MB', 'GB'][power]}`
}
function remaining(task) {
  if (!task.downloadSpeed || !task.totalLength) return '--'
  const seconds = Math.max(
    0,
    Math.ceil((task.totalLength - task.completedLength) / task.downloadSpeed)
  )
  if (seconds < 60) return `${seconds} 秒`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分`
}
const date = (value) => (value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '--')
function apply(data) {
  if (data.revision >= state.revision) Object.assign(state, data)
}
async function load() {
  loading.value = true
  loadError.value = ''
  try {
    apply(await window.api.list())
  } catch (error) {
    loadError.value = error.message || '下载记录加载失败'
  } finally {
    loading.value = false
  }
}
async function operate(method, task) {
  if (pending.has(task.id)) return
  pending.add(task.id)
  try {
    apply(await window.api[method](task.id))
  } catch (error) {
    ElMessage.error(error.message)
  } finally {
    pending.delete(task.id)
  }
}
function openNew() {
  editingId.value = null
  Object.assign(form, {
    url: store.url,
    dir: store.dir,
    filename: store.filename,
    query: store.query.map((item) => ({ ...item })),
    cookie: store.cookie,
    connections: store.connections
  })
  advanced.value = []
  formError.value = ''
  dialogVisible.value = true
}
function editTask(task) {
  editingId.value = task.id
  Object.assign(form, {
    url: task.url,
    dir: task.dir,
    filename: task.filename,
    query: task.query.map((item) => ({ ...item })),
    cookie: '',
    connections: task.connectionsLimit
  })
  advanced.value = ['advanced']
  formError.value = task.needsCookie ? '请重新填写此任务使用的 Cookie。' : ''
  dialogVisible.value = true
}
function resume(task) {
  if (task.needsCookie) editTask(task)
  else operate('resume', task)
}
async function chooseDir() {
  try {
    const dir = await window.api.chooseDir()
    if (dir) form.dir = dir
  } catch (error) {
    formError.value = error.message
  }
}
async function submit() {
  if (submitting.value) return
  formError.value = ''
  if (!form.url.trim() || !form.dir) {
    formError.value = '请填写下载地址并选择保存目录。'
    return
  }
  if (
    editingId.value &&
    state.tasks.find((task) => task.id === editingId.value)?.needsCookie &&
    !form.cookie.trim()
  ) {
    formError.value = '请重新填写 Cookie。'
    return
  }
  submitting.value = true
  try {
    const payload = {
      ...form,
      query: form.query.map(({ key, value }) => ({ key, value })),
      url: form.url.trim(),
      filename: form.filename.trim()
    }
    const result = editingId.value
      ? await window.api.resume(editingId.value, payload)
      : await window.api.add(payload)
    apply(result)
    if (!editingId.value)
      Object.assign(store, payload, { query: form.query.map((item) => ({ ...item })) })
    dialogVisible.value = false
    filter.value = 'all'
    search.value = ''
  } catch (error) {
    formError.value = error.message || '添加失败，请重试'
  } finally {
    submitting.value = false
  }
}
async function changeLimit(value) {
  changingLimit.value = true
  try {
    apply(await window.api.setConcurrency(value))
  } catch (error) {
    ElMessage.error(error.message)
  } finally {
    changingLimit.value = false
  }
}
async function openTarget(task, kind) {
  try {
    await window.api.openTarget(task.id, kind)
  } catch (error) {
    ElMessage.error(error.message)
  }
}
let unsubscribe
onMounted(() => {
  // Subscribe first; revisions prevent an older initial response overwriting a live update.
  unsubscribe = window.api.onChange(apply)
  load()
})
onUnmounted(() => unsubscribe?.())
</script>

<style scoped>
.downloads-page {
  min-height: 100vh;
  padding: 0 36px 88px;
  background: radial-gradient(ellipse at 0 0, #3ddc9709, transparent 45%), var(--bg);
}
.page-header {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 30px 0 24px;
  background: var(--bg);
  gap: 24px;
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
.subtitle {
  color: var(--muted);
  font-size: 13px;
  margin: 9px 0 0;
}
.download-workspace {
  border: 1px solid var(--border);
  border-radius: 16px;
  background: var(--surface);
  overflow: hidden;
}
.list-toolbar {
  padding: 16px 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--border);
  gap: 16px;
  flex-wrap: wrap;
}
.filters {
  display: flex;
  gap: 4px;
}
.filter-button {
  border: none;
  background: transparent;
  border-radius: 8px;
  padding: 9px 10px;
  color: var(--muted);
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  white-space: nowrap;
}
.filter-button:hover {
  color: var(--text);
  background: var(--surface-raised);
}
.filter-button.selected {
  color: var(--accent);
  background: #3ddc9712;
}
.filter-button span {
  margin-left: 5px;
  font-size: 11px;
  opacity: 0.8;
  font-variant-numeric: tabular-nums;
}
.filter-button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.search {
  width: 200px;
}
.empty-state {
  min-height: 330px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 36px;
  color: var(--muted);
}
.empty-symbol {
  width: 64px;
  height: 64px;
  display: grid;
  place-items: center;
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-radius: 20px;
  margin-bottom: 20px;
  color: var(--accent);
}
.empty-state h2 {
  color: var(--text);
  font-size: 18px;
  margin-bottom: 8px;
  font-weight: 500;
}
.empty-state p {
  font-size: 13px;
  margin-bottom: 22px;
}
.task-card {
  padding: 22px 24px;
  border-bottom: 1px solid var(--border);
}
.task-card:last-child {
  border-bottom: none;
}
.task-top {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 18px;
}
.file-icon {
  width: 42px;
  height: 46px;
  display: grid;
  place-items: center;
  border-radius: 10px;
  background: var(--surface-raised);
  color: var(--muted);
  flex-shrink: 0;
}
.task-active .file-icon {
  color: var(--accent);
  background: #3ddc9710;
}
.task-heading {
  flex: 1;
  min-width: 0;
}
.task-heading h2 {
  font-size: 14px;
  font-weight: 500;
  color: var(--text);
  margin: 0 0 5px;
  overflow-wrap: anywhere;
}
.task-heading p {
  color: var(--muted);
  font-size: 11px;
  margin: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.status-label {
  color: var(--muted);
  font-size: 12px;
  white-space: nowrap;
  display: flex;
  align-items: center;
  gap: 7px;
}
.status-label i,
.live-dot {
  width: 6px;
  height: 6px;
  background: currentColor;
  border-radius: 50%;
  display: inline-block;
}
.status-label.active,
.status-label.complete,
.live-dot.live {
  color: var(--accent);
}
.status-label.error,
.error-text,
.task-error,
.form-error {
  color: var(--danger);
}
.status-label.waiting {
  color: #b8a2e8;
}
.progress-caption {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--muted);
  margin-bottom: 9px;
}
.task-bottom {
  margin-top: 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.task-detail {
  display: flex;
  gap: 16px;
  font-size: 12px;
  color: var(--muted);
  flex-wrap: wrap;
}
.speed {
  color: var(--accent);
}
.task-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}
.task-actions .el-button + .el-button {
  margin-left: 0;
}
.task-error {
  font-size: 12px;
  margin: 12px 0 0;
  overflow-wrap: anywhere;
}
.queue-footer {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 6;
  padding: 16px 36px;
  border-top: 1px solid var(--border);
  background: var(--bg);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  color: var(--muted);
  font-size: 12px;
}
.queue-summary {
  display: flex;
  align-items: center;
  gap: 10px;
}
.queue-summary strong {
  color: var(--text);
  font-size: 12px;
  font-weight: 400;
  margin-left: 10px;
}
.concurrency-control {
  display: flex;
  align-items: center;
  gap: 12px;
  white-space: nowrap;
}
.concurrency-control .el-select {
  width: 88px;
}
.download-form {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.form-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.form-field label,
.query-label {
  font-size: 13px;
  color: var(--text);
}
.form-field label span {
  color: var(--muted);
}
.directory-input,
.query-row,
.query-label {
  display: flex;
  align-items: center;
  gap: 10px;
}
.query-label {
  justify-content: space-between;
}
.advanced-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding-top: 10px;
}
.form-hint {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.6;
  margin: 0;
}
.form-error {
  font-size: 13px;
  margin: 0;
  line-height: 1.6;
}
.dialog-actions {
  display: flex;
  justify-content: flex-end;
  border-top: 1px solid var(--border);
  padding-top: 18px;
}
.el-alert {
  margin-bottom: 16px;
}
@media (max-width: 900px) {
  .downloads-page {
    padding-left: 24px;
    padding-right: 24px;
  }
  .list-toolbar {
    padding: 14px;
  }
  .search {
    width: 170px;
  }
  .queue-footer {
    padding-left: 24px;
    padding-right: 24px;
  }
}
@media (prefers-reduced-motion: reduce) {
  :deep(*) {
    transition: none !important;
    animation: none !important;
  }
}
</style>
