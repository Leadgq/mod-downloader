<template>
  <main class="downloads-page">
    <header class="page-header">
      <div>
        <p class="eyebrow">YOUR FILES, IN FLOW</p>
        <h1>Nox Downloader<span class="title-dot">.</span></h1>
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
        <DownloadTaskCard
          v-for="task in visibleTasks"
          :key="task.id"
          :task="task"
          :pending="pending"
          @operate="operate"
          @resume="resume"
          @edit="editTask"
          @open-target="openTarget"
        />
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

    <DownloadDialog
      v-model:visible="dialogVisible"
      v-model:advanced="advanced"
      :editing-id="editingId"
      :submitting="submitting"
      :initial-form="form"
      :form-error="formError"
      @closed="formError = ''"
      @choose-dir="chooseDir"
      @submit="submit"
    />
  </main>
</template>

<script setup>
import { Download, Plus, Search } from '@element-plus/icons-vue'
import DownloadTaskCard from '../components/DownloadTaskCard.vue'
import DownloadDialog from '../components/DownloadDialog.vue'
import { useDownloadsPage } from '../composables/useDownloadsPage'

const {
  state,
  loading,
  loadError,
  filter,
  search,
  pending,
  dialogVisible,
  editingId,
  submitting,
  changingLimit,
  formError,
  advanced,
  form,
  filters,
  counts,
  activeCount,
  totalSpeed,
  visibleTasks,
  load,
  operate,
  openNew,
  editTask,
  resume,
  chooseDir,
  submit,
  changeLimit,
  openTarget,
  bytes
} = useDownloadsPage()
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
.live-dot {
  width: 6px;
  height: 6px;
  background: currentColor;
  border-radius: 50%;
  display: inline-block;
}
.live-dot.live {
  color: var(--accent);
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
