import { join } from 'path'
import { JsonStore } from './store'

/**
 * 密文读写的最小接口。
 *
 * 生产环境注入 Electron 的 `safeStorage`（Windows 下即 DPAPI，加密绑定当前
 * 系统用户）；它要求 app ready 之后才可用、测试环境里拿不到，所以抽成接口
 * 让测试注入假实现。
 */
export interface SecretCrypto {
  encrypt(plain: string): string
  decrypt(cipher: string): string
}

/**
 * 钥匙的名字。目前只有 LLM 的 API Key；NovelAI Token 与 Danbooru Key
 * 由用到它们的计划各自加进来——没有消费方就先不声明。
 */
export type SecretName = 'llmApiKey'

type SecretFile = Partial<Record<SecretName, string>>

function isSecretFile(v: unknown): boolean {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  return Object.values(v).every((x) => typeof x === 'string')
}

/**
 * `secrets.json`：几把钥匙共用一个文件，每把各自加密。
 *
 * 与 config.json 分开：配置文件用户可能手动编辑或重置，混在一起容易
 * 「重置配置顺手清掉钥匙」。
 */
export class SecretStore {
  private readonly file: JsonStore<SecretFile>

  constructor(
    userDataDir: string,
    private readonly crypto: SecretCrypto,
  ) {
    this.file = new JsonStore<SecretFile>(join(userDataDir, 'secrets.json'), () => ({}), isSecretFile)
  }

  read(name: SecretName): string {
    const cipher = this.file.read()[name]
    if (!cipher) return ''
    try {
      return this.crypto.decrypt(cipher)
    } catch {
      // 换机器、换用户、或系统密钥轮换后旧密文解不开。
      // 当作「未设置」：让用户重填一次，好过整个应用起不来
      return ''
    }
  }

  /** 写空串表示清除这把钥匙 */
  write(name: SecretName, plain: string): void {
    const data = this.file.read()
    if (plain === '') delete data[name]
    else data[name] = this.crypto.encrypt(plain)
    this.file.write(data)
  }
}
