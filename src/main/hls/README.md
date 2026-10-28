# HLS 模块

HLS 运行代码统一放在此目录。其他主进程模块通过 `index.mjs` 使用下载器和解析接口。

| 文件                   | 职责                                          |
| ---------------------- | --------------------------------------------- |
| `index.mjs`            | 对外入口，导出下载器、播放列表解析及 URL 工具 |
| `driver.mjs`           | 轨道计划、请求校验、下载调度、解密与媒体合成  |
| `playlist.mjs`         | hls-parser 适配与播放列表字段校验             |
| `storage.mjs`          | 续传元数据、资源身份、分片哈希与原子写入      |
| `chromium-fetch.mjs`   | Electron 网络栈入口，仅 Electron 主进程导入   |
| `chromium-request.mjs` | 可单独测试的 Chromium 请求实现                |

相关文件按用途放置：

- `tests/hls/`：HLS 单元、回归、媒体、生命周期和 Electron 集成测试。
- `resources/bin/<platform>/`：FFmpeg、ffprobe、aria2 与许可证、构建记录。
- `scripts/setup-ffmpeg.ps1`：安装与校验 Windows FFmpeg。
- `scripts/check-binaries.cjs`：分发包构建前检查内置程序。

常用检查：

```sh
npm run test:hls
npm run test:hls:electron
npm test
```

新增 HLS 测试使用 `tests/hls/*.test.mjs`，自动包含在专项及完整测试中。
