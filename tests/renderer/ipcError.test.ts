import { describe, expect, it } from 'vitest'
import { ipcErrorMessage } from '../../src/renderer/src/ipcError'

describe('ipcErrorMessage', () => {
  it('去掉 Electron 给 invoke 错误包的前缀', () => {
    expect(ipcErrorMessage(new Error("Error invoking remote method 'gen:start': Error: 未设置图片保存目录，请先到设置里指定。"))).toBe('未设置图片保存目录，请先到设置里指定。')
    expect(ipcErrorMessage(new Error("Error invoking remote method 'llm:run': 上一轮还在运行"))).toBe('上一轮还在运行')
  })

  it('没有前缀、不是 Error 时原样转字符串', () => {
    expect(ipcErrorMessage(new Error('坏了'))).toBe('坏了')
    expect(ipcErrorMessage('x')).toBe('x')
  })
})
