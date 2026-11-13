export const statusLabels = {
  active: '下载中',
  waiting: '等待下载',
  paused: '已暂停',
  error: '下载失败',
  complete: '已完成',
  cancelled: '已取消'
}

export const isHistory = (task) => ['complete', 'cancelled'].includes(task.status)

export function displayName(task) {
  if (task.filename) return task.filename
  try {
    return decodeURIComponent(new URL(task.uri).pathname.split('/').pop()) || '等待获取文件名'
  } catch {
    return '未命名文件'
  }
}
export function bytes(value) {
  const n = Number(value) || 0
  if (n < 1024) return `${n} B`
  const power = Math.min(3, Math.floor(Math.log(n) / Math.log(1024)))
  return `${(n / 1024 ** power).toFixed(power === 1 ? 1 : 2)} ${['B', 'KB', 'MB', 'GB'][power]}`
}
export function remaining(task) {
  if (!task.downloadSpeed || !task.totalLength) return '--'
  const seconds = Math.max(
    0,
    Math.ceil((task.totalLength - task.completedLength) / task.downloadSpeed)
  )
  if (seconds < 60) return `${seconds} 秒`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分`
}
export const date = (value) =>
  value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '--'
