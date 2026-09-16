import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  classifyShareError,
  LONG_PRESS_HINT,
  pickShareChannel,
  shareImage,
  shareMessage,
  type NaiShell,
  type ShareEnv,
} from '../../src/mobile/src/share'

function shell(available: () => boolean): NaiShell {
  return { available, shareImage: vi.fn() }
}

const NO_SHELL: ShareEnv = { shell: undefined, canWebShare: false, canWebShareFiles: false }

describe('pickShareChannel', () => {
  it('壳在就走壳：WebView 里根本没有 Web Share API', () => {
    expect(pickShareChannel({ ...NO_SHELL, shell: shell(() => true) })).toBe('shell')
    // 壳里即使浏览器那套也齐，仍优先走原生面板（壳的 WebView 不一定认 canShare 的结果）
    expect(pickShareChannel({ shell: shell(() => true), canWebShare: true, canWebShareFiles: true })).toBe('shell')
  })

  it('壳说自己不可用、或者桥坏了，就往下降级而不是卡住', () => {
    expect(pickShareChannel({ ...NO_SHELL, shell: shell(() => false) })).toBe('none')
    expect(
      pickShareChannel({
        shell: shell(() => {
          throw new Error('bridge gone')
        }),
        canWebShare: true,
        canWebShareFiles: true,
      }),
    ).toBe('web-share')
  })

  it('壳的版本对不上（缺 shareImage）当作没有壳', () => {
    const half = { available: () => true } as unknown as NaiShell
    expect(pickShareChannel({ shell: half, canWebShare: true, canWebShareFiles: true })).toBe('web-share')
    expect(pickShareChannel({ ...NO_SHELL, shell: half })).toBe('none')
  })

  it('浏览器有 share 不等于能分享文件，两件事都真了才走这一档', () => {
    expect(pickShareChannel({ ...NO_SHELL, canWebShare: true, canWebShareFiles: false })).toBe('none')
    expect(pickShareChannel({ ...NO_SHELL, canWebShare: false, canWebShareFiles: true })).toBe('none')
    expect(pickShareChannel({ ...NO_SHELL, canWebShare: true, canWebShareFiles: true })).toBe('web-share')
  })

  it('什么都没有（明文 HTTP 页面在浏览器里打开）就是 none', () => {
    expect(pickShareChannel(NO_SHELL)).toBe('none')
    expect(pickShareChannel({ ...NO_SHELL, shell: null })).toBe('none')
  })
})

describe('classifyShareError', () => {
  it('用户在系统面板上点返回（AbortError）不算失败', () => {
    const abort = new Error('share canceled')
    abort.name = 'AbortError'
    expect(classifyShareError(abort)).toBe('cancelled')
    expect(classifyShareError({ name: 'AbortError' })).toBe('cancelled')
  })

  it('别的都算失败', () => {
    expect(classifyShareError(new TypeError('boom'))).toBe('failed')
    const denied = new Error('no permission')
    denied.name = 'NotAllowedError'
    expect(classifyShareError(denied)).toBe('failed')
    expect(classifyShareError(undefined)).toBe('failed')
  })
})

describe('shareMessage', () => {
  it('两档都没有时必须说话，不许静默失败', () => {
    expect(shareMessage({ status: 'unsupported' })).toBe(LONG_PRESS_HINT)
    expect(shareMessage({ status: 'failed', message: '取图片失败' })).toBe('分享失败：取图片失败')
  })

  it('成功与用户自己取消都不打扰', () => {
    expect(shareMessage({ status: 'ok' })).toBeNull()
    expect(shareMessage({ status: 'cancelled' })).toBeNull()
  })
})

// ── 三档真跑一遍：图片字节必须由页面自己 fetch，这一点错了壳那边就拿不到图 ──

/** Node 里没有 FileReader，补一个只做 dataURL 的 */
class FakeFileReader {
  result: string | null = null
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  readAsDataURL(): void {
    this.result = 'data:image/png;base64,ZmFrZQ=='
    // 真的 FileReader 是异步回调，这里也异步：同步返回会掩盖忘了 await 的写法
    setTimeout(() => this.onload?.(), 0)
  }
}

type FetchMock = Mock<[], Promise<{ ok: boolean; status: number; blob: () => Promise<Blob> }>>

function stubFetch(blob: Blob): FetchMock {
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, blob: async () => blob }))
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('FileReader', FakeFileReader)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('shareImage', () => {
  const blob = new Blob(['fake png'], { type: 'image/png' })

  it('壳在：页面自己取图，转成 dataURL 交给壳', async () => {
    const fetchMock = stubFetch(blob)
    const bridge = { available: () => true, shareImage: vi.fn() }
    vi.stubGlobal('window', { NaiShell: bridge })
    vi.stubGlobal('navigator', {})

    const result = await shareImage('http://192.168.1.8:7321/api/image?x=1', '00001-3163646731.png')

    expect(result).toEqual({ status: 'ok' })
    expect(fetchMock).toHaveBeenCalledWith('http://192.168.1.8:7321/api/image?x=1')
    expect(bridge.shareImage).toHaveBeenCalledWith('data:image/png;base64,ZmFrZQ==', '00001-3163646731.png')
  })

  it('浏览器：navigator.share 带上文件，文件名用那一轮的', async () => {
    stubFetch(blob)
    const share = vi.fn(async (data: ShareData) => {
      void data
    })
    vi.stubGlobal('window', {})
    vi.stubGlobal('navigator', { share, canShare: () => true })

    const result = await shareImage('http://host/api/image', '00002-77.png')

    expect(result).toEqual({ status: 'ok' })
    const sent = share.mock.calls[0][0]
    expect(sent.files?.[0]?.name).toBe('00002-77.png')
    expect(sent.files?.[0]?.type).toBe('image/png')
  })

  it('浏览器面板被用户取消：不算失败，界面上什么都不说', async () => {
    stubFetch(blob)
    const abort = new Error('canceled')
    abort.name = 'AbortError'
    vi.stubGlobal('window', {})
    vi.stubGlobal('navigator', {
      share: vi.fn(async () => {
        throw abort
      }),
      canShare: () => true,
    })

    const result = await shareImage('http://host/api/image', 'a.png')

    expect(result).toEqual({ status: 'cancelled' })
    expect(shareMessage(result)).toBeNull()
  })

  it('两档都没有：给长按提示', async () => {
    stubFetch(blob)
    vi.stubGlobal('window', {})
    vi.stubGlobal('navigator', {})

    expect(await shareImage('http://host/api/image', 'a.png')).toEqual({ status: 'unsupported' })
  })

  it('图取不下来：说一句能看懂的，别把英文的 Failed to fetch 漏出去', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    vi.stubGlobal('window', { NaiShell: { available: () => true, shareImage: vi.fn() } })

    const result = await shareImage('http://host/api/image', 'a.png')

    expect(result.status).toBe('failed')
    expect(shareMessage(result)).toBe('分享失败：连不上电脑，检查是不是还在同一个 WiFi')
  })
})
