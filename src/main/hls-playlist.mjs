import HLS from 'hls-parser'

// hls-parser 的选项为进程全局；同步解析期间临时设置，避免影响其他调用者。
function parse(text) {
  const options = HLS.getOptions()
  try {
    // 兼容现实中省略 VERSION/TARGETDURATION 的列表，关键字段在适配层校验。
    HLS.setOptions({ strictMode: false, silent: true })
    return HLS.parse(text)
  } finally {
    HLS.setOptions({ ...options, strictMode: options.strictMode, silent: options.silent })
  }
}

function keyOf(key, epoch) {
  if (!key || key.method === 'NONE') return null
  if (!key.uri) throw new Error('加密播放列表缺少密钥地址')
  const iv = key.iv ? Buffer.from(key.iv) : null
  if (iv && iv.length !== 16) throw new Error('密钥 IV 必须是 16 字节')
  return {
    METHOD: key.method,
    URI: key.uri,
    IV: iv ? `0x${iv.toString('hex')}` : '',
    KEYFORMAT: key.format || 'identity',
    epoch
  }
}

function rangeOf(range) {
  if (!range) return null
  if (
    !Number.isSafeInteger(range.offset) ||
    range.offset < 0 ||
    !Number.isSafeInteger(range.length) ||
    range.length <= 0 ||
    !Number.isSafeInteger(range.offset + range.length)
  )
    throw new Error('播放列表字节范围无效，隐式偏移必须接续同一个资源')
  return { offset: range.offset, length: range.length }
}

export function parseM3u8(input) {
  const text = String(input)
    .replace(/^\uFEFF/, '')
    .trim()
    .replace(
      /([,:]IV=)0[xX]([\da-f]{1,32})(?=,|$)/gim,
      (_match, prefix, hex) => `${prefix}0x${hex.padStart(32, '0')}`
    )
  if (!text.startsWith('#EXTM3U')) throw new Error('播放列表缺少 #EXTM3U')
  if (/\{\$[^}]+\}/.test(text)) throw new Error('暂不支持播放列表中的变量引用')
  let playlist
  try {
    playlist = parse(text)
  } catch (error) {
    throw new Error(`播放列表解析失败：${error.message}`)
  }
  if (!playlist) throw new Error('播放列表解析失败')
  if (playlist.isMasterPlaylist) {
    if (/^#EXTINF:/m.test(text)) throw new Error('播放列表混用了主列表和媒体列表标签')
    return {
      isMaster: true,
      variants: playlist.variants.map((variant) => ({
        uri: variant.uri,
        bandwidth: variant.bandwidth || 0,
        isIFrameOnly: Boolean(variant.isIFrameOnly),
        codecs: variant.codecs || '',
        audio: variant.audio.map((audio) => ({
          uri: audio.uri || '',
          name: audio.name,
          language: audio.language || '',
          isDefault: Boolean(audio.isDefault),
          autoselect: Boolean(audio.autoselect)
        }))
      })),
      segments: [],
      mediaSequence: 0,
      live: false,
      map: null
    }
  }
  const mediaSequence = playlist.mediaSequenceBase || 0
  if (!Number.isSafeInteger(mediaSequence) || mediaSequence < 0) {
    throw new Error('播放列表媒体序号无效')
  }
  // AST 会继承 Map，但没有保留其声明时的 Key。只扫描标签作用域，
  // 属性语法仍交给 hls-parser，避免把媒体分片后来的 Key 误用于初始化段。
  const contexts = []
  let keyLine = ''
  let keyEpoch = 0
  let mapEpoch = 0
  let mapKey = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('#EXT-X-KEY:')) {
      keyLine = line
      keyEpoch++
    } else if (line.startsWith('#EXT-X-MAP:')) {
      mapEpoch++
      const stub = parse(
        `#EXTM3U\n#EXT-X-TARGETDURATION:1\n${keyLine}\n#EXTINF:1,\nsegment\n#EXT-X-ENDLIST`
      )
      mapKey = keyOf(stub.segments[0].key, keyEpoch)
    } else if (line && !line.startsWith('#')) {
      contexts.push({ keyEpoch, mapEpoch, mapKey })
    }
  }
  const maps = new Map()
  const segments = playlist.segments.map((segment, index) => {
    if (!segment.uri || !Number.isFinite(segment.duration) || segment.duration <= 0) {
      throw new Error('播放列表分片缺少有效地址或时长')
    }
    const context = contexts[index]
    if (!context) throw new Error('播放列表分片结构不完整')
    // 宽松解析时，跨 URI 的隐式 offset 仍是 -1，由 rangeOf 拒绝。
    const byteRange = rangeOf(segment.byterange)
    let map = null
    if (segment.map) {
      if (!maps.has(context.mapEpoch)) {
        if (!segment.map.uri) throw new Error('初始化段缺少地址')
        maps.set(context.mapEpoch, {
          uri: segment.map.uri,
          byteRange: rangeOf(segment.map.byterange),
          key: context.mapKey,
          epoch: context.mapEpoch
        })
      }
      map = maps.get(context.mapEpoch)
    }
    return {
      uri: segment.uri,
      duration: segment.duration,
      sequence: segment.mediaSequenceNumber,
      discontinuity: Boolean(segment.discontinuity),
      discontinuitySequence: segment.discontinuitySequence,
      gap: Boolean(segment.gap),
      byteRange,
      key: keyOf(segment.key, context.keyEpoch),
      map
    }
  })
  return {
    isMaster: false,
    variants: [],
    segments,
    mediaSequence,
    live: !playlist.endlist,
    isIFrameOnly: Boolean(playlist.isIFrame),
    map: segments[0]?.map || null
  }
}
