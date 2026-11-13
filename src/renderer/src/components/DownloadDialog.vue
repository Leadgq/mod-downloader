<template>
  <el-dialog
    :model-value="visible"
    :title="editingId ? '编辑并继续下载' : '新建下载'"
    width="580px"
    align-center
    :close-on-click-modal="false"
    :close-on-press-escape="!submitting"
    :show-close="!submitting"
    @update:model-value="emit('update:visible', $event)"
    @closed="emit('closed')"
  >
    <form class="download-form" @submit.prevent="emit('submit', form)">
      <div class="form-field">
        <label for="task-url">下载地址</label
        ><el-input
          id="task-url"
          v-model="form.url"
          autofocus
          placeholder="https://example.com/file.zip 或视频/音频 .m3u8 链接"
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
          /><el-button
            :disabled="submitting || Boolean(editingId)"
            @click="emit('choose-dir', form)"
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
      <el-collapse :model-value="advanced" @update:model-value="emit('update:advanced', $event)">
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
        <el-button :disabled="submitting" @click="emit('update:visible', false)">返回</el-button
        ><el-button type="primary" native-type="submit" :loading="submitting">{{
          editingId ? '保存并继续' : '添加下载'
        }}</el-button>
      </div>
    </form>
  </el-dialog>
</template>

<script setup>
import { reactive, watch } from 'vue'
import { Delete } from '@element-plus/icons-vue'

const props = defineProps({
  visible: Boolean,
  editingId: String,
  submitting: Boolean,
  initialForm: { type: Object, required: true },
  formError: String,
  advanced: { type: Array, required: true }
})
const emit = defineEmits(['update:visible', 'update:advanced', 'closed', 'choose-dir', 'submit'])
const form = reactive({ url: '', dir: '', filename: '', query: [], cookie: '', connections: 8 })
watch(
  () => props.visible,
  (visible) => {
    if (visible) {
      Object.assign(form, props.initialForm, {
        query: props.initialForm.query.map((item) => ({ ...item }))
      })
    }
  }
)
</script>

<style scoped>
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
  color: var(--danger);
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
</style>
