# CHANGELOG

## 1.6.1

- feat: release 配置的 message 选项，支持函数和异步函数，接收 `{ name, version }` 返回 `string`

## 1.6.0

- feat: 支持异步配置

## 1.5.1

- feat: monodic 启动时，注入 `IS_MONODIC=YES` 环境变量

## 1.5.0

- feat: 支持 copy 模式

## 1.4.1

- fix：修复 `monodic start` 列举的项目名称顺序不稳定的问题

## 1.4.0

- feat: 支持多个软链目录映射到一个项目

## 1.3.0

- feat: 新增命令行参数，支持直接启动目标项目和脚本任务

## 1.2.4

- fix: 修复 release.dest 在 copy 前没有删除原目录的问题
- fix: 修复 realase.dest 忽略 dot files 的问题

## 1.2.3

- fix：修复 api typo，`createCreate` rename `createConfig`

## 1.2.2

- fix：让`concurrently`直接输出 log，目前只运行了一个命令，没有加 prefix 的必要 
- feat: 支持 `config.ignorePackages` 配置需要忽略扫描 `package.json` 的目录

## 1.2.1

- feat：支持 `monodic command` 里输入错误的指令，但不退出 `command` 状态
- fix: 处理没有 `monodic start` 状态下，`monodic command` 结束运行时报错的问题

## 1.2.0

- feat：支持 `monodic command` 在 `reset` 状态下运行命令

## 1.1.0

- feat：支持 release 前后执行 prerelease 和 postrelease 命令
- feat: 支持发布到本地目录
- feat：支持无构建发布的场景

## 1.0.8

- feat: 先尝试 releaseProject，失败后再删除 .cache，尽可能里用 cache，加快发布速度

## 1.0.7

- fixed：修复 monodic release 时 gh-pages .cache 目录总是报错的问题（release project 前删除 .cache 目录）

## 1.0.6

- fixed: 修复并发切换软链接导致 cwd 错乱的问题

## 1.0.5

- feature: 支持嵌套的 links 关联，真实文件夹内部包含软链接，在启动时递归切换成文件夹

## 1.0.4

- 在运行出错时，捕获 uncaughtException 并 log 出排查问题的文档地址