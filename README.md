# 深黑下载器

Electron + Vue3 桌面下载器。主进程拉起本机 `aria2c`，用多连接分段下载，同一保存路径再次开始会断点续传。

## 开发

```bash
pnpm i
pnpm dev
```

## aria2 二进制

仓库不提交 exe。从 [aria2 releases](https://github.com/aria2/aria2/releases) 下载官方 `win-64bit` zip，把 `aria2c.exe` 放到：

```
resources/bin/win32/aria2c.exe
```

缺这个文件时，应用启动下载会提示路径。

## 打包

```bash
pnpm build:win
```
