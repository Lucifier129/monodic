import path from 'path'
import { lstat, constants, Stats } from 'fs'
import fs from 'fs-extra'
import { cosmiconfig } from 'cosmiconfig'
import prompts from 'prompts'
import globby from 'globby'
import ghpages from 'gh-pages'
import Concurrently from 'concurrently'
import readPkgUp from 'read-pkg-up'
import cpy from 'cpy'
import { argv } from 'yargs'
import chokidar from 'chokidar'
import copyFile from 'cp-file'

const explorer = cosmiconfig('monodic')

const concurrently: typeof Concurrently = (commands, ...args) => {
  return Concurrently(
    commands.map((command) => {
      if (typeof command === 'string') {
        return command
      }
      return {
        ...command,
        env: {
          ...command.env,
          IS_MONODIC: 'YES',
        },
      }
    }),
    ...args
  )
}

// 获取文件 stat 信息
const getFileStat = (targetPath: string) => {
  return new Promise<Stats>((resolve, reject) => {
    lstat(targetPath, (error, data) => {
      if (error) {
        reject(error)
      } else {
        resolve(data)
      }
    })
  })
}

// 访问文件
const accessFile = (filepath: string, mode: number) => {
  return new Promise<boolean>((resolve, reject) => {
    fs.access(filepath, mode, (error) => {
      if (error) {
        reject(error)
      } else {
        resolve(true)
      }
    })
  })
}

// 判断文件是否存在
const isFileExisted = async (filepath: string) => {
  try {
    await accessFile(filepath, constants.F_OK)
    return true
  } catch (error) {
    return false
  }
}

const getExistedPaths = async (paths: string[] = []) => {
  let results: string[] = []

  for (let i = 0; i < paths.length; i++) {
    let isExisted = await isFileExisted(paths[i])
    if (isExisted) results.push(paths[i])
  }

  return results
}

const getSymlinks = async (paths: string[] = []) => {
  let results: string[] = []

  for (let i = 0; i < paths.length; i++) {
    let isSymlink = await isSymbolicLink(paths[i])
    if (isSymlink) results.push(paths[i])
  }

  return results
}

const getDirectories = async (paths: string[] = []) => {
  let results: string[] = []

  for (let i = 0; i < paths.length; i++) {
    let yes = await isDirectory(paths[i])
    if (yes) results.push(paths[i])
  }

  return results
}

const watch = (
  paths: string | readonly string[],
  options?: chokidar.WatchOptions
): Promise<chokidar.FSWatcher> => {
  return new Promise((resolve, reject) => {
    let watcher = chokidar
      .watch(paths, options)
      .on('ready', () => {
        resolve(watcher)
      })
      .on('error', (error) => {
        reject(error)
      })
  })
}

export interface Link {
  src: string
  dest: string[]
}

export type Links = Link[]

// 将 link object 里的路径，都解析成绝对路径
const resolveLink = (link: Link) => {
  let src = path.resolve(link.src)
  let dest = [...link.dest].map((filepath) => path.resolve(filepath))
  let paths = [src, ...dest]
  return {
    src,
    dest,
    paths,
  }
}

// 根据 link object 重置文件夹位置，真实文件夹放到 src 里，dest 路径里是软链接
const linking = async (link: Link) => {
  let { src, dest, paths } = resolveLink(link)
  let existedPathList = await getExistedPaths(paths)
  let symlinkList = await getSymlinks(existedPathList)
  let realPathList = existedPathList.filter(
    (path) => !symlinkList.includes(path)
  )
  let directories = await getDirectories(realPathList)

  if (existedPathList.length === 0) {
    throw new Error(
      `配置中的路径所对应的本地文件夹都不存在，请添加一个文件夹\n\n${paths
        .map((path, index) => `${index + 1}) ${path}`)
        .join('\n')}`
    )
  }

  if (directories.length !== 1) {
    throw new Error(
      `预期只有一个真实的文件夹，其余为软链接。目前找到的文件夹数量为：${
        directories.length
      }。\n请删除多余的，只留下一个真实文件夹。\n\n${directories
        .map((dir, index) => `${index + 1}) ${dir}`)
        .join('\n')}
      `
    )
  }

  let directory = directories[0]

  if (realPathList.length > 1) {
    // 删除非文件夹，它们可能是 git 对 symblinks 的文件化处理
    while (realPathList.length) {
      let currentPath = realPathList.shift()
      if (currentPath && currentPath !== directory) {
        await fs.remove(currentPath)
      }
    }
  }

  let realPath = directories[0]

  if (realPath !== src) {
    await fs.remove(src)
    await fs.copy(realPath, src)
    await fs.remove(realPath)
  }

  let list = [...dest]

  // 创建软链接，必须依次创建
  // 并发创建时，cwd 被反复切换，在异步场景下有概率产生错乱
  while (list.length) {
    let destPath = list.shift()
    if (destPath) {
      let isExisted = await isFileExisted(destPath)
      if (!isExisted) {
        await createSymlink(src, destPath)
      }
    }
  }

  return realPath
}

// 创建相对路径的软链接，以便支持跨用户电脑重建软链接。
const createSymlink = async (source: string, target: string) => {
  let dirname = path.dirname(target)
  let relativePath = path.relative(dirname, source)
  let cwd = process.cwd()
  process.chdir(dirname)
  await fs.createSymlink(relativePath, target, 'dir')
  process.chdir(cwd)
}

// 根据目录，找到目标 link
const findLinks = (links: Links, dirname: string) => {
  let result = []
  let resolvedDirname = path.resolve(dirname)

  for (let i = 0; i < links.length; i++) {
    let { src, dest, paths } = resolveLink(links[i])
    let targetPath = dest.find((currPath) =>
      currPath.startsWith(resolvedDirname)
    )

    if (targetPath) {
      result.push({
        link: links[i],
        targetPath,
        src,
        dest,
        paths,
      })
    }
  }

  return result
}

const findLinksDeep = async (links: Links, dirname: string) => {
  let targets = findLinks(links, dirname)

  let list: { src: string; target: string; link: Link }[] = []

  let stack = [...targets]

  while (stack.length) {
    let target = stack.shift()

    if (!target) break

    let { link, targetPath, src } = target

    // 先重置文件夹和软链位置
    await linking(link)

    list.push({
      src,
      target: targetPath,
      link,
    })

    // 递归查找 src 目录内部是否有需要替换的软链
    let targets = findLinks(links, src)

    if (targets.length) {
      stack.unshift(...targets)
    }
  }

  // src 重复的列表
  let dupList = list.filter(
    (item) => list.filter((item1) => item1.src === item.src).length > 1
  )

  if (dupList.length > 0) {
    throw new Error(
      `检查到一个 src 指向了两个或以上的 dist 目标，\n ${dupList
        .map((item) => `${item.src} -> ${item.target}`)
        .join('\n')}`
    )
  }

  list.reverse()

  return list
}

const select = async (links: Links, dirname: string) => {
  if (!links) return false

  let list = await findLinksDeep(links, dirname)

  let isNotEmpty = list.length > 0

  // 串行替换，防止异步切换 cwd 导致错乱
  while (list.length) {
    let item = list.shift()
    if (item) {
      // 将启动目录里的软链替换成真实文件夹
      await swapSymlink(item.src, item.target)
    }
  }

  return isNotEmpty
}

const swapSymlink = async (source: string, target: string) => {
  await fs.remove(target)
  await fs.copy(source, target)
  await fs.remove(source)
  await createSymlink(target, source)
}

const isSymbolicLink = async (targetPath: string) => {
  let stats = await getFileStat(targetPath)
  return stats.isSymbolicLink()
}

const isDirectory = async (targetPath: string) => {
  let stats = await getFileStat(targetPath)
  return stats.isDirectory()
}

const findPkgList = async (patterns: string[] = []) => {
  const paths = await globby([
    '*/**/package.json',
    '!**/node_modules',
    '!**/.monodic/**',
    ...patterns,
  ])
  return paths.sort()
}

// 重置链接
const resetLink = async (links: Links, targetPath: string) => {
  if (!links) return []

  let list = await findLinksDeep(links, targetPath)

  list = list.reverse()

  let results: string[] = []

  // 串行重置，防止异步切换 cwd 导致错乱
  while (list.length) {
    let item = list.shift()
    if (item) {
      results.push(await linking(item.link))
    }
  }

  return results
}

type GetMessage = (info: {
  name: string
  version: string
}) => string | Promise<string>

type ReleaseInfo = {
  // 待发布目录
  src: string
  // 发布到的目录（这个目录不是 branch 配置指定的目录，而是当前分支的目录）
  dest?: string
  // 发布分支
  branch?: string
  // 发布的新分支时的 git commit message
  message?: string | GetMessage
  // 发布前需要运行的命令
  prerelease?: string
  // 发布后需要运行的命令
  postrelease?: string
  /**
   * 需要发布的文件的匹配模式
   * 文档：https://github.com/tschaub/gh-pages#optionssrc
   */
  include?: string[]
  // 是否忽略 src 目录的 package.json
  // 这个配置影响 prerelease/postrelease 的运行目录
  // 当 src 目录也有 package.json 但不想被执行 npm scripts 时可以设置该配置
  ignoreSrcPackage?: boolean
}

type ReleaseConfig = {
  [key: string]: ReleaseInfo
}

type MonodicConfig = {
  // 需要忽略的 package 查询目录
  ignorePackages?: string[]
  ignoreFiles?: string[]
  links: Links
  release: ReleaseConfig
}

// 搜索配置
const searchConfig = async () => {
  let result = await explorer.search()

  if (!result || result.isEmpty) {
    let filepath = process.cwd()
    let isEmpty = true
    let config = {} as MonodicConfig

    return { config, filepath, isEmpty }
  }

  let config = result.config

  if (typeof config === 'function') {
    config = config()
  }

  if (config instanceof Promise) {
    config = await config
  }

  let { filepath, isEmpty } = result

  return {
    config: config as MonodicConfig,
    filepath,
    isEmpty,
  }
}

const copyFiles = async (
  targetPath: string,
  dirname: string,
  ignoreFiles?: string[]
) => {
  ignoreFiles = ignoreFiles
    ? ignoreFiles.map(
        (filename) =>
          `!${path.relative(targetPath, path.resolve(dirname, filename))}`
      )
    : []

  let monodicDir = path.join(targetPath, '.monodic')

  let paths = [
    '**/*',
    '!.git',
    '!node_modules',
    '!.monodic',
    '!**/node_modules/**/*',
    '!**/.monodic/**/*',
    '!**/.git/**/*',
    ...ignoreFiles,
  ]

  let startCopyTime = Date.now()

  console.log(`start copy to ${monodicDir}`)

  await fs.remove(monodicDir)
  await fs.mkdir(monodicDir)

  await cpy(paths, monodicDir, {
    cwd: targetPath,
    parents: true,
    dot: true,
  })

  let nodeModulesPath = `${targetPath}/node_modules`

  if (await isFileExisted(nodeModulesPath)) {
    await createSymlink(nodeModulesPath, `${monodicDir}/node_modules`)
  }

  console.log(
    `finish copy, take time: ${((Date.now() - startCopyTime) / 22).toFixed(
      2
    )}ms`
  )

  return paths
}

const startCopyMode = async () => {
  let { config, filepath } = await searchConfig()

  let links = config.links

  let cwd = process.cwd()

  let dirname = path.dirname(filepath)

  if (cwd !== dirname) {
    process.chdir(dirname)
  }

  let ignorePackages = config.ignorePackages
    ? config.ignorePackages.map((pattern) => `!${pattern}`)
    : []

  let pkgList = await findPkgList(ignorePackages)

  // 选择一个项目
  let project = {
    value: argv.project as string | undefined,
  }

  if (!project.value) {
    project = await prompts({
      type: 'select',
      name: 'value',
      message: '请选择一个项目',
      hint: '按方向键进行选择，按回车键确认',
      choices: pkgList.map((pkgPath) => {
        let dirname = path.dirname(pkgPath)
        let title = dirname
        let value = dirname
        return {
          title,
          value,
        }
      }),
      initial: 0,
    })
  }

  if (!project.value) {
    return
  }

  let isValidProject = pkgList.some((pkgPath) => {
    let dirname = path.dirname(pkgPath)
    return dirname === project.value
  })

  if (!isValidProject) {
    throw new Error(`project {${project.value}} is not valid`)
  }

  let targetPath = path.resolve(project.value)

  let monodicDir = path.join(targetPath, '.monodic')

  let pkg = require(`${targetPath}/package.json`) as {
    name: string
    scripts: object
  }

  let presets = ['start', 'test', 'install']

  let pkgScripts = Object.keys(pkg.scripts)

  let scripts = Array.from(
    new Set([...presets, 'build', ...pkgScripts])
  ).filter((script) => pkgScripts.includes(script))

  // 选择一个 script 命令
  let script = {
    command: argv.script ? `npm run ${argv.script}` : undefined,
  }

  if (!script.command) {
    script = await prompts({
      type: 'select',
      name: 'command',
      message: '请选择一个命令',
      hint: '按方向键进行选择，按回车键确认',
      choices: scripts.map((name) => {
        let title = presets.includes(name) ? `npm ${name}` : `npm run ${name}`
        let value = title
        return {
          title,
          value,
        }
      }),
      initial: 0,
    })
  }

  if (!script.command) {
    return
  }

  await findLinksDeep(links, targetPath)

  let paths = await copyFiles(targetPath, dirname, config.ignoreFiles)

  let watcher = await watch(paths, {
    cwd: targetPath,
    usePolling: true,
  })

  watcher.on('all', async (event, filename) => {
    let srcPath = path.join(targetPath, filename)

    if (srcPath.includes('.monodic')) return
    if (srcPath.includes('node_modules')) return
    if (srcPath.includes('.git')) return

    let destPath = path.join(monodicDir, filename)

    if (event === 'add' || event === 'change') {
      await copyFile(srcPath, destPath)
    } else if (event === 'unlink' || event === 'unlinkDir') {
      await fs.remove(destPath)
    }
  })

  // 切换 cwd 到项目文件夹
  process.chdir(monodicDir)

  try {
    // 运行选中的命令
    await concurrently([{ name: pkg.name, command: script.command }], {
      raw: true,
      prefix: 'name',
      killOthers: ['failure', 'success'],
    })
  } finally {
    watcher.close()
  }
}

const startExchangeMode = async () => {
  let { config, filepath } = await searchConfig()

  let links = config.links

  let cwd = process.cwd()

  let dirname = path.dirname(filepath)

  if (cwd !== dirname) {
    process.chdir(dirname)
  }

  let ignorePackages = config.ignorePackages
    ? config.ignorePackages.map((pattern) => `!${pattern}`)
    : []

  let pkgList = await findPkgList(ignorePackages)

  // 选择一个项目
  let project = {
    value: argv.project as string | undefined,
  }

  if (!project.value) {
    project = await prompts({
      type: 'select',
      name: 'value',
      message: '请选择一个项目',
      hint: '按方向键进行选择，按回车键确认',
      choices: pkgList.map((pkgPath) => {
        let dirname = path.dirname(pkgPath)
        let title = dirname
        let value = dirname
        return {
          title,
          value,
        }
      }),
      initial: 0,
    })
  }

  if (!project.value) {
    return
  }

  let isValidProject = pkgList.some((pkgPath) => {
    let dirname = path.dirname(pkgPath)
    return dirname === project.value
  })

  if (!isValidProject) {
    throw new Error(`project {${project.value}} is not valid`)
  }

  let targetPath = path.resolve(project.value)

  try {
    let pkg = require(`${targetPath}/package.json`) as {
      name: string
      scripts: object
    }

    let presets = ['start', 'test', 'install']

    let pkgScripts = Object.keys(pkg.scripts)

    let scripts = Array.from(
      new Set([...presets, 'build', ...pkgScripts])
    ).filter((script) => pkgScripts.includes(script))

    // 选择一个 script 命令
    let script = {
      command: argv.script ? `npm run ${argv.script}` : undefined,
    }

    if (!script.command) {
      script = await prompts({
        type: 'select',
        name: 'command',
        message: '请选择一个命令',
        hint: '按方向键进行选择，按回车键确认',
        choices: scripts.map((name) => {
          let title = presets.includes(name) ? `npm ${name}` : `npm run ${name}`
          let value = title
          return {
            title,
            value,
          }
        }),
        initial: 0,
      })
    }

    if (!script.command) {
      return
    }

    // 切换软链接
    await select(links, targetPath)

    // 切换 cwd 到项目文件夹
    process.chdir(targetPath)

    // 运行选中的命令
    await concurrently([{ name: pkg.name, command: script.command }], {
      raw: true,
      prefix: 'name',
      killOthers: ['failure', 'success'],
    })
  } finally {
    // 切换 monodic.config.js 所在目录
    process.chdir(dirname)
    // 重置链接
    await resetLink(links, targetPath)
  }
}

export const start = async () => {
  if (argv.mode === 'copy') {
    await startCopyMode()
  } else {
    await startExchangeMode()
  }
}

export const reset = async () => {
  let { config, filepath } = await searchConfig()
  let { links } = config

  if (!Array.isArray(links)) {
    return
  }

  process.chdir(path.dirname(filepath))

  let cwd = process.cwd()

  let list = await Promise.all(links.map(linking))

  process.chdir(cwd)

  return {
    list,
    links,
  }
}

export const command = async () => {
  let result = await reset()

  let cwd = process.cwd()

  let restore = async () => {
    if (!result) return
    let { list, links } = result

    for (let i = 0; i < list.length; i++) {
      let realPath = list[i]
      let link = links[i]
      let src = path.resolve(link.src)
      if (realPath !== src) {
        await select(links, realPath)
        process.chdir(cwd)
      }
    }
  }

  try {
    while (true) {
      // 选择一个 script 命令
      let script = await prompts({
        type: 'text',
        name: 'command',
        message: '请输入命令（输入quit退出）',
      })

      if (!script.command) {
        continue
      }

      if (script.command === 'quit') {
        break
      }

      try {
        // 运行选中的命令
        await concurrently([{ name: 'run', command: script.command }], {
          raw: true,
        })
      } catch (_) {
        // ignore error
      }
    }
  } finally {
    await restore()
  }
}

const searchReleaseConfig = async () => {
  let { config, filepath } = await searchConfig()

  if (!config.release) {
    throw new Error(
      `预期 config.release 字段结构为对象： { "project": { src, branch } }, 接收到的却是 ${
        config.release + ''
      }`
    )
  }

  return { config, filepath }
}

export const releaseAll = async () => {
  let { config, filepath } = await searchReleaseConfig()

  let dirname = path.dirname(filepath)

  process.chdir(dirname)

  let keys = Object.keys(config.release)

  while (keys.length) {
    let key = keys.shift()
    if (!key) continue
    let item = config.release[key]

    if (argv.mode === 'copy') {
      await releaseItemByCopy(
        item,
        key,
        dirname,
        config.links,
        config.ignoreFiles
      )
    } else {
      await releaseItemByExchange(item, key, dirname, config.links)
    }
  }
}

export const release = async () => {
  let { config, filepath } = await searchReleaseConfig()

  let dirname = path.dirname(filepath)

  process.chdir(dirname)

  let keys = Object.keys(config.release)

  // 选择一个项目
  let project = {
    value: argv.project as string | undefined,
  }

  if (!project.value) {
    project = await prompts({
      type: 'select',
      name: 'value',
      message: '请选择一个项目',
      hint: '按方向键进行选择，按回车键确认',
      choices: keys.map((key) => {
        let title = key
        let value = key
        return {
          title,
          value,
        }
      }),
      initial: 0,
    })
  }

  if (!project.value) {
    return
  }

  let isValidProject = keys.includes(project.value)

  if (!isValidProject) {
    throw new Error(`project {${project.value}} is not existed in [${keys}]`)
  }

  let item = config.release[project.value]

  if (argv.mode === 'copy') {
    await releaseItemByCopy(
      item,
      project.value,
      dirname,
      config.links,
      config.ignoreFiles
    )
  } else {
    await releaseItemByExchange(item, project.value, dirname, config.links)
  }
}

const releaseItemByCopy = async (
  item: ReleaseInfo,
  name: string, // 发布名称
  dirname: string, // 发布时的 cwd 目录
  links: Links, // Links 配置,
  ignoreFiles?: string[]
) => {
  let pkgInfo = await readPkgUp({
    cwd: item.ignoreSrcPackage ? path.dirname(item.src) : item.src,
  })

  if (!pkgInfo) throw new Error(`package.json not found`)

  let targetPath = path.dirname(pkgInfo.path)
  let monodicDir = path.join(targetPath, '.monodic')

  if (targetPath === dirname) {
    throw new Error(`project {${name}} has not its own pakcage.json`)
  }

  // 运行命令
  let runCommand = async (command?: string) => {
    if (pkgInfo && command) {
      // 切换 cwd 到项目文件夹
      process.chdir(monodicDir)

      // 运行选中的命令
      await concurrently(
        [{ name: pkgInfo.packageJson.name, command: command }],
        {
          raw: true,
          prefix: 'name',
          killOthers: ['failure', 'success'],
        }
      )
      // 恢复 cwd
      process.chdir(dirname)
    }
  }

  let src = path.join(dirname, item.src).replace(targetPath, monodicDir)

  await findLinksDeep(links, targetPath)

  await copyFiles(targetPath, dirname, ignoreFiles)

  await runCommand(item.prerelease)

  await releaseProject({
    name: name,
    dir: src,
    dest: item.dest,
    branch: item.branch,
    message: item.message,
    include: item.include,
  })

  await runCommand(item.postrelease)
}

// 发布一个 release-info
const releaseItemByExchange = async (
  item: ReleaseInfo,
  name: string, // 发布名称
  dirname: string, // 发布时的 cwd 目录
  links: Links // Links 配置
) => {
  let pkgInfo = await readPkgUp({
    cwd: item.ignoreSrcPackage ? path.dirname(item.src) : item.src,
  })

  // 运行命令
  let runCommand = async (command?: string) => {
    if (pkgInfo && command) {
      let targetPath = path.dirname(pkgInfo.path)

      // 切换 cwd 到项目文件夹
      process.chdir(targetPath)

      // 运行选中的命令
      await concurrently(
        [{ name: pkgInfo.packageJson.name, command: command }],
        {
          raw: true,
          prefix: 'name',
          killOthers: ['failure', 'success'],
        }
      )
      // 恢复 cwd
      process.chdir(dirname)
    }
  }

  let isReleased = false

  try {
    if (pkgInfo) {
      await select(links, path.dirname(pkgInfo.path))
    }

    await runCommand(item.prerelease)

    await releaseProject({
      name: name,
      dir: item.src,
      dest: item.dest,
      branch: item.branch,
      message: item.message,
      include: item.include,
    })

    isReleased = true
  } finally {
    if (pkgInfo) {
      // 切换 monodic.config.js 所在目录
      process.chdir(dirname)
      // 重置链接
      await resetLink(links, path.dirname(pkgInfo.path))
    }
    if (isReleased) {
      await runCommand(item.postrelease)
    }
  }
}

type ReleaseProjectOptions = {
  name: string
  dir: string
  dest?: string
  branch?: string
  message?: string | GetMessage
  include?: string[]
}

const getVersion = async (filepath: string) => {
  let pkgInfo = await readPkgUp({
    cwd: filepath
  })

  if (!pkgInfo) return ''

  return pkgInfo.packageJson.version || ''
}

const releaseProject = async ({
  name,
  dir,
  branch = '',
  dest = '',
  message = '',
  include = ['**/*', '!**/node_modules/**/*'],
}: ReleaseProjectOptions) => {
  let targetDir = path.resolve(dir)
  let isExisted = await isFileExisted(targetDir)

  if (!isExisted) {
    console.log(`发布目录 ${targetDir} 不存在，已跳过它。`)
    return
  }

  let version = await getVersion(targetDir)

  if (typeof message === 'function') {
    message = await message({
      name,
      version,
    })
  }

  let finalMessage = message
    ? message
    : version
    ? `发布 ${name}@${version}`
    : `发布 ${name}`

  if (dest) {
    await fs.remove(dest)
    await cpy(include, path.resolve(dest), {
      cwd: targetDir,
      parents: true,
      dot: true,
    })
    console.log(
      `\n已发布到目录：${JSON.stringify(
        { project: name, src: dir, dest, version },
        null,
        2
      )}`
    )
  }

  if (!branch) {
    return
  }

  if (version) {
    console.log(
      `\n发布项目 ${name}@${version} 到 git 分支 ${branch}\n文件夹为：${targetDir}`
    )
  } else {
    console.log(
      `\n发布项目 ${name} 到 git 分支 ${branch}\n文件夹为：${targetDir}`
    )
  }

  let publish = () => {
    return new Promise<void>((resolve, reject) => {
      ghpages.clean()
      ghpages.publish(
        targetDir,
        {
          src: include,
          branch: branch,
          message: finalMessage,
          dotfiles: true,
        },
        (error) => {
          if (error) {
            reject(error)
          } else {
            resolve()
          }
        }
      )
    })
  }

  await publish()

  console.log(
    `\n已发布到分支 ${JSON.stringify(
      { project: name, src: dir, branch, version, message: finalMessage },
      null,
      2
    )}`
  )
}

export const createConfig = (config: MonodicConfig) => config

/**
 * 在报错后，提供问题排查的文档地址
 */
process.on('uncaughtException', (error) => {
  console.log(
    '出错了。查看此链接排查问题：https://github.com/Lucifier129/monodic#faq'
  )
  console.error(error)
  process.exit()
})
