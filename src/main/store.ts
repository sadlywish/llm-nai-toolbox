import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'fs'
import { dirname } from 'path'

/**
 * 单文件 JSON 存储。
 *
 * 写入走「先写 .tmp 再 rename」：rename 在同一分区上是原子的，
 * 这样跑图中途崩溃或断电都不会留下半截 JSON 把上次的内容也毁掉。
 * 读取失败一律回退到 fallback 而不是抛——配置坏了不该让应用起不来。
 */
export class JsonStore<T> {
  constructor(
    private readonly filePath: string,
    private readonly fallback: () => T,
    /** 形状校验。返回 false 时按损坏处理，回退到 fallback 并把坏文件留证 */
    private readonly isValid: (value: unknown) => boolean = () => true,
  ) {}

  /** 文件在不在。注意这跟「read() 返回了默认值」不是一回事——文件存在但
   *  损坏时 read() 也会退回默认值，那种情况用户是配过的，不该当成没配过 */
  exists(): boolean {
    return existsSync(this.filePath)
  }

  read(): T {
    if (!existsSync(this.filePath)) return this.fallback()
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as unknown
      if (!this.isValid(parsed)) {
        // 形状不对：留证后回退。直接用坏数据渲染会让界面白屏且无从恢复
        try {
          renameSync(this.filePath, `${this.filePath}.corrupt`)
        } catch {
          /* 留证失败不影响回退 */
        }
        return this.fallback()
      }
      return parsed as T
    } catch {
      // 原文件不动是为了不在读取时就破坏现场；但下一次 write() 会用 fallback
      // 覆盖掉原文件，所以这里先复制一份留证——用户手写的内容不能因为一次
      // 解析失败就没了。复制失败（例如目录不可写）吞掉，不影响回退。
      try {
        copyFileSync(this.filePath, `${this.filePath}.corrupt`)
      } catch {
        /* 留证失败不影响回退 */
      }
      return this.fallback()
    }
  }

  write(value: T): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    const data = JSON.stringify(value, null, 2)
    // 先 fsync 再 rename：rename 本身只保证读者看不到半截文件，
    // 并不保证数据已经落盘。少了这一步，断电后可能留下一个 0 字节的
    // 目标文件——那比保留上一次的旧内容更糟。
    const fd = openSync(tmp, 'w')
    try {
      writeSync(fd, data, null, 'utf-8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, this.filePath)
  }
}
