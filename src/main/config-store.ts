import { join } from 'path'
import { mergeConfig, type AppConfig } from '@shared/config'
import { JsonStore } from './store'

/**
 * config.json 的读写。读与写都过 mergeConfig：读到的可能是旧版本、手改、
 * 写盘中途断电的文件；写进来的来自 IPC，IPC 边界不能假定调用方守规矩。
 */
export class ConfigStore {
  private readonly file: JsonStore<unknown>

  constructor(userDataDir: string) {
    this.file = new JsonStore<unknown>(join(userDataDir, 'config.json'), () => null)
  }

  /**
   * config.json 在不在。用于「首次启动自动打开设置页」（规格 §14.3）：
   * **只有用户点过保存才有这个文件**，read 不写盘，所以打开设置又切走、
   * 没保存的话下次照样会先打开设置页。
   */
  exists(): boolean {
    return this.file.exists()
  }

  read(): AppConfig {
    return mergeConfig(this.file.read())
  }

  write(cfg: AppConfig): void {
    this.file.write(mergeConfig(cfg))
  }
}
