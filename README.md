# 深黑下载器

Electron + Vue3 桌面下载器。主进程拉起本机 `aria2c`，用多连接分段下载，同一保存路径再次开始会断点续传。

## 下载与历史

- 首页按「全部 / 进行中 / 已完成 / 已取消」筛选任务，支持搜索文件名。
- 点击「新建下载」逐个添加链接；查询参数、Cookie 和单文件连接数在高级设置中。
- 默认同时下载 2 个文件，可在底部调整为 1～5 个；其余任务排队。暂停、取消或完成后自动补位。
- 每个文件默认使用 8 条连接，可调整为 1～16 条。这与「同时下载数量」是两个独立设置。
- 重启后保留历史，未完成任务恢复为暂停；点击继续可断点续传。服务器必须支持 Range，链接仍须指向原文件。
- Cookie 仅保留在任务当前会话中，不写入下载历史；需 Cookie 的任务重启后通过编辑重新填写。新建表单仍沿用原有的本地配置记忆。
- 取消保留部分文件，移除记录仅删除列表记录。已完成任务可以打开文件或文件夹。
- 任务记录保存在 Electron 用户数据目录的 `download-history.json`，无需数据库。

## 检查

```bash
pnpm test
pnpm exec eslint . --ext .js,.cjs,.mjs,.vue
pnpm build
```

构建后可以运行 `pnpm test:ui`，通过隐藏的 Electron 窗口检查列表、新建弹窗、搜索和取消操作，并在 `out/qa/` 中生成截图和检查结果。界面测试使用独立临时记录，不会修改实际下载历史。

测试包含队列调度、历史恢复及 Cookie 不落入历史的检查。在 Windows 且下载引擎存在时，还会运行本地 HTTP Range 下载测试，校验多任务、重启续传和文件内容；其他环境跳过真实引擎测试。

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
