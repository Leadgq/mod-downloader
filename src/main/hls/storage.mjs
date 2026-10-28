import { createHash, randomUUID } from 'node:crypto'
import { readFile, rename, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

export const digest = (value) => createHash('sha256').update(value).digest('hex')

// 只忽略已知的鉴权参数，内容 ID、清晰度等查询参数仍属于资源身份。
export function resourceIdentity(uri) {
  const url = new URL(uri)
  for (const key of [...url.searchParams.keys()]) {
    if (/^(sign|signature|token|expires|expiry|exp|auth|policy|key-pair-id|x-amz-.+)$/i.test(key)) {
      url.searchParams.delete(key)
    }
  }
  url.hash = ''
  url.searchParams.sort()
  return url.toString()
}

export async function openStorage(dir, identity, resources, signal) {
  const metadataPath = join(dir, 'metadata.json')
  let metadata = { version: 1, identity, files: {} }
  try {
    const saved = JSON.parse(await readFile(metadataPath, 'utf8'))
    if (
      saved.version === 1 &&
      saved.identity === identity &&
      saved.files &&
      typeof saved.files === 'object' &&
      !Array.isArray(saved.files)
    )
      metadata = saved
  } catch (error) {
    if (!['ENOENT'].includes(error.code) && !(error instanceof SyntaxError)) throw error
  }
  let writes = Promise.resolve()
  const save = () => {
    const snapshot = JSON.stringify(metadata)
    const next = writes.then(async () => {
      const temporary = `${metadataPath}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, snapshot, 'utf8')
        await rename(temporary, metadataPath)
      } finally {
        await rm(temporary, { force: true })
      }
    })
    writes = next.catch(() => {})
    return next
  }
  const done = new Set()
  let bytes = 0
  for (const [index, resource] of resources.entries()) {
    signal.throwIfAborted()
    const entry = metadata.files[resource.file]
    if (
      !entry ||
      entry.identity !== resource.identity ||
      !Number.isSafeInteger(entry.size) ||
      entry.size <= 0
    )
      continue
    try {
      const buffer = await readFile(join(dir, resource.file))
      if (buffer.length !== entry.size || digest(buffer) !== entry.sha256) continue
      done.add(index)
      bytes += buffer.length
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  // 未记录、旧版、损坏的分片不会仅凭“非空”而被信任。
  await save()
  return {
    done,
    bytes,
    async commit(index, buffer) {
      signal.throwIfAborted()
      const resource = resources[index]
      const path = join(dir, resource.file)
      const temporary = `${path}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, buffer)
        signal.throwIfAborted()
        await rename(temporary, path)
        metadata.files[resource.file] = {
          identity: resource.identity,
          size: buffer.length,
          sha256: digest(buffer)
        }
        await save()
      } finally {
        await rm(temporary, { force: true })
      }
    },
    async flush() {
      await writes
    }
  }
}
