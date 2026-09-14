import { describe, expect, it } from 'vitest'
import { DANBOORU_CDN_URLS, withDanbooruReferer } from '../../../src/main/danbooru/cdn'

describe('withDanbooruReferer', () => {
  it('补上 Referer，其余请求头原样保留', () => {
    expect(withDanbooruReferer({ 'User-Agent': 'x', Accept: 'image/*' })).toEqual({
      'User-Agent': 'x',
      Accept: 'image/*',
      Referer: 'https://danbooru.donmai.us/',
    })
  })

  it('过滤器只匹配 cdn.donmai.us，不把 Referer 带给别的主机', () => {
    expect(DANBOORU_CDN_URLS).toEqual(['https://cdn.donmai.us/*'])
  })
})
