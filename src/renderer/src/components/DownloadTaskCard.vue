<template>
  <article class="task-card" :class="`task-${task.status}`">
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
            @click="emit('operate', 'pause', task)"
            >暂停</el-button
          >
        </template>
        <el-button
          v-if="task.status === 'paused'"
          size="small"
          type="primary"
          plain
          :disabled="pending.has(task.id)"
          @click="emit('resume', task)"
          >继续</el-button
        >
        <el-button
          v-if="task.status === 'error'"
          size="small"
          type="primary"
          plain
          :disabled="pending.has(task.id)"
          @click="emit('resume', task)"
          >重试</el-button
        >
        <el-button
          v-if="['error', 'paused'].includes(task.status)"
          size="small"
          :disabled="pending.has(task.id)"
          @click="emit('edit', task)"
          >编辑</el-button
        >
        <el-button
          v-if="!isHistory(task)"
          size="small"
          :disabled="pending.has(task.id)"
          @click="emit('open-target', task, 'dir')"
          >打开文件夹</el-button
        >
        <el-button
          v-if="!isHistory(task)"
          size="small"
          :disabled="pending.has(task.id)"
          @click="emit('operate', 'cancel', task)"
          >取消</el-button
        >
        <template v-else>
          <el-button
            v-if="task.status === 'complete'"
            size="small"
            type="primary"
            plain
            :disabled="pending.has(task.id)"
            @click="emit('open-target', task, 'file')"
            >打开文件</el-button
          >
          <el-button
            size="small"
            :disabled="pending.has(task.id)"
            @click="emit('open-target', task, 'dir')"
            >打开文件夹</el-button
          >
          <el-dropdown trigger="click" @command="emit('operate', 'remove', task)">
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
</template>

<script setup>
import { Document, MoreFilled } from '@element-plus/icons-vue'
import {
  bytes,
  date,
  displayName,
  isHistory,
  remaining,
  statusLabels
} from '../utils/downloadFormat'

defineProps({ task: { type: Object, required: true }, pending: { type: Object, required: true } })
const emit = defineEmits(['operate', 'resume', 'edit', 'open-target'])
const labels = statusLabels
</script>

<style scoped>
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
</style>
