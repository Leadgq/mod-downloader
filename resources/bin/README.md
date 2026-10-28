# 内置下载与媒体程序

Windows 程序位于 `win32/`：`aria2c.exe`、`ffmpeg.exe`、`ffprobe.exe`。
FFmpeg/ffprobe 使用 Gyan 的 FFmpeg 9.0.2 essentials Windows 构建。

运行 `npm run setup:ffmpeg` 下载并校验固定版本。脚本仅在下载包的 SHA-256
与固定校验值一致时解压，保存许可证、来源和两个可执行文件的 SHA-256。
安装包构建前会检查程序是否齐全，以及 FFmpeg/ffprobe 是否匹配记录。
下载压缩包保留在本地，不进入安装包。可执行文件由 `.gitignore` 排除，
其他机器签出代码后需要运行安装脚本。

`LICENSE.ffmpeg.txt` 与 `ffmpeg-build.json` 随安装包一起提供。
构建信息包含下载地址及对应版本的上游源代码地址。第三方构建说明：
<https://www.gyan.dev/ffmpeg/builds/>。

其他平台需要将对应平台的三个程序放到 `resources/bin/<platform>/`。
当前下载脚本只安装 Windows x64 构建；Windows 构建校验会拒绝 ARM64 打包，
以免把 x64 二进制放进不匹配的安装包。
