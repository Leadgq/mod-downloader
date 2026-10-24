import { isHlsUri } from './hls.mjs'

// 组合驱动：普通文件交给 aria2，m3u8 流媒体交给内置 HLS 下载器。
// 两边保持同一套接口（add/status/pause/resume/remove），task-manager 无需区分。
// 注意：HLS 驱动的 gid 自带 "hls:" 前缀（add 原样返回），路由时必须整串透传。
export function createCompositeDriver({ aria2, hls, isHls = isHlsUri }) {
  const pick = (gid) => (String(gid).startsWith('hls:') ? hls : aria2)
  return {
    setFailureHandler: (handler) => aria2.setFailureHandler(handler),
    // 引擎按需在 add 里启动；schedule() 的 ensure() 调用不做任何事
    async ensure() {},
    add(task, cookie) {
      if (isHls(task.uri)) return hls.add(task, cookie)
      return Promise.resolve(aria2.ensure()).then(() => aria2.add(task, cookie))
    },
    status(gid) {
      return pick(gid).status(gid)
    },
    pause(gid) {
      return pick(gid).pause(gid)
    },
    resume(gid) {
      return pick(gid).resume(gid)
    },
    remove(gid) {
      return pick(gid).remove(gid)
    },
    destroy() {
      return Promise.all([aria2.destroy(), hls.destroy()]).then(() => {})
    }
  }
}
