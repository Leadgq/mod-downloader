const { existsSync, readFileSync } = require('node:fs')
const { createHash } = require('node:crypto')
const { join } = require('node:path')

module.exports = async (context) => {
  const platform = context.electronPlatformName
  if (platform === 'win32' && context.arch !== 1) {
    throw new Error('当前内置 FFmpeg/aria2 为 Windows x64，请使用 --x64 打包')
  }
  const dir = join(context.packager.projectDir, 'resources', 'bin', platform)
  for (const name of ['aria2c', 'ffmpeg', 'ffprobe']) {
    const file = join(dir, platform === 'win32' ? `${name}.exe` : name)
    if (!existsSync(file)) {
      throw new Error(`缺少内置程序：${file}。Windows 请先运行 npm run setup:ffmpeg。`)
    }
  }
  if (platform === 'win32') {
    const manifest = JSON.parse(
      readFileSync(join(dir, 'ffmpeg-build.json'), 'utf8').replace(/^\uFEFF/, '')
    )
    for (const name of ['ffmpeg.exe', 'ffprobe.exe']) {
      const hash = createHash('sha256')
        .update(readFileSync(join(dir, name)))
        .digest('hex')
      if (hash !== manifest.binaries?.[name])
        throw new Error(`内置 ${name} 校验失败，请重新运行 setup:ffmpeg`)
    }
  }
}
