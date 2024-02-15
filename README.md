# QQ 空间相册同步到本地

## 功能

+ 全部照片/视频同步到本地
+ 指定并发数
+ 自动跳过已同步的照片/视频

## 使用

1. 安装运行环境 NodeJS。
2. 使用 pnpm 安装依赖。
3. 更名 `.env.example` 为 `.env`，并配置好环境变量。
4. 使用 `node index.js` 运行。

## 注意

+ 请勿删除 `track.json` 文件，该文件用于追踪同步情况，删除后将丢失所有同步状态。
