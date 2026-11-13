import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { ElMessage, ElNotification } from 'element-plus'
import { useConfigStore } from '@renderer/store'
import { bytes, displayName, isHistory } from '../utils/downloadFormat'

export function useDownloadsPage() {
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

  function playCompletionSound() {
    const AudioContext = window.AudioContext || window.webkitAudioContext
    if (!AudioContext) return
    try {
      const audio = new AudioContext()
      const start = audio.currentTime
      for (const [offset, frequency] of [
        [0, 784],
        [0.16, 1046]
      ]) {
        const tone = audio.createOscillator()
        const volume = audio.createGain()
        tone.type = 'sine'
        tone.frequency.value = frequency
        volume.gain.setValueAtTime(0, start + offset)
        volume.gain.linearRampToValueAtTime(0.12, start + offset + 0.02)
        volume.gain.exponentialRampToValueAtTime(0.001, start + offset + 0.18)
        tone.connect(volume).connect(audio.destination)
        tone.start(start + offset)
        tone.stop(start + offset + 0.18)
      }
      if (audio.state === 'suspended') void audio.resume().catch(() => {})
      setTimeout(() => void audio.close(), 500)
    } catch {
      // 音频不可用时仍显示完成提示。
    }
  }
  function showCompletion(task) {
    playCompletionSound()
    ElNotification({
      title: '下载完成',
      message: `${displayName(task)} · 点击打开所在文件夹`,
      type: 'success',
      position: 'bottom-right',
      duration: 8000,
      onClick: () => void openTarget(task, 'dir')
    })
  }
  function apply(data) {
    if (data.revision < state.revision) return
    if (state.revision >= 0) {
      const previous = new Map(state.tasks.map((task) => [task.id, task.status]))
      for (const task of data.tasks) {
        if (
          task.status === 'complete' &&
          previous.has(task.id) &&
          previous.get(task.id) !== 'complete'
        ) {
          showCompletion(task)
        }
      }
    }
    Object.assign(state, data)
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
      cookie: '',
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
  async function chooseDir(formData) {
    try {
      const dir = await window.api.chooseDir()
      if (dir) formData.dir = dir
    } catch (error) {
      formError.value = error.message
    }
  }
  async function submit(formData) {
    if (submitting.value) return
    formError.value = ''
    if (!formData.url.trim() || !formData.dir) {
      formError.value = '请填写下载地址并选择保存目录。'
      return
    }
    if (
      editingId.value &&
      state.tasks.find((task) => task.id === editingId.value)?.needsCookie &&
      !formData.cookie.trim()
    ) {
      formError.value = '请重新填写 Cookie。'
      return
    }
    submitting.value = true
    try {
      const payload = {
        ...formData,
        query: formData.query.map(({ key, value }) => ({ key, value })),
        url: formData.url.trim(),
        filename: formData.filename.trim()
      }
      const result = editingId.value
        ? await window.api.resume(editingId.value, payload)
        : await window.api.add(payload)
      apply(result)
      if (!editingId.value) {
        const savedSettings = { ...payload }
        delete savedSettings.cookie
        Object.assign(store, savedSettings, { query: formData.query.map((item) => ({ ...item })) })
      }
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

  return {
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
  }
}
