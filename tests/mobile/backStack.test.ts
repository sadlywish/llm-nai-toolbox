import { describe, expect, it } from 'vitest'
import { BACK_PRIORITY, confirmLeave, createBackStack, LEAVE_CONFIRM_MS } from '../../src/mobile/src/backStack'

describe('createBackStack', () => {
  it('没人登记：不处理，交给壳', () => {
    expect(createBackStack().handle()).toBe(false)
  })

  it('优先级高的先处理：开着弹窗时不会先切页签', () => {
    const stack = createBackStack()
    const calls: string[] = []
    stack.register(BACK_PRIORITY.popup, () => (calls.push('popup'), true))
    // 页签那一条后登记，也不能抢在弹窗前面（重新渲染时它可能重新登记）
    stack.register(BACK_PRIORITY.page, () => (calls.push('page'), true))
    expect(stack.handle()).toBe(true)
    expect(calls).toEqual(['popup'])
  })

  it('同一级里后打开的先关：大图里的参数页先关，再关大图', () => {
    const stack = createBackStack()
    const calls: string[] = []
    const offViewer = stack.register(BACK_PRIORITY.popup, () => (calls.push('viewer'), true))
    const offParams = stack.register(BACK_PRIORITY.popup, () => (calls.push('params'), true))
    stack.handle()
    offParams()
    stack.handle()
    offViewer()
    expect(calls).toEqual(['params', 'viewer'])
    expect(stack.handle()).toBe(false)
  })

  it('详情页排在弹窗之后、页签之前', () => {
    const stack = createBackStack()
    const calls: string[] = []
    stack.register(BACK_PRIORITY.page, () => (calls.push('page'), true))
    const offDetail = stack.register(BACK_PRIORITY.subpage, () => (calls.push('detail'), true))
    stack.handle()
    offDetail()
    stack.handle()
    expect(calls).toEqual(['detail', 'page'])
  })

  it('返回 false 的交给下一个，全都不管就交给壳', () => {
    const stack = createBackStack()
    const calls: string[] = []
    stack.register(BACK_PRIORITY.page, () => (calls.push('page'), false))
    stack.register(BACK_PRIORITY.popup, () => (calls.push('popup'), false))
    expect(stack.handle()).toBe(false)
    expect(calls).toEqual(['popup', 'page'])
  })

  it('注销之后不再被调用，重复注销无害', () => {
    const stack = createBackStack()
    let called = 0
    const off = stack.register(BACK_PRIORITY.popup, () => (called++, true))
    off()
    off()
    expect(stack.handle()).toBe(false)
    expect(called).toBe(0)
  })
})

describe('confirmLeave', () => {
  it('第一次只提示，窗口内再按才放行', () => {
    const first = confirmLeave(0, 10_000)
    expect(first).toEqual({ leave: false, next: 10_000 })
    expect(confirmLeave(first.next, 10_000 + LEAVE_CONFIRM_MS)).toEqual({ leave: true, next: 0 })
  })

  it('隔太久再按，重新算第一次', () => {
    expect(confirmLeave(10_000, 10_000 + LEAVE_CONFIRM_MS + 1)).toEqual({ leave: false, next: 10_000 + LEAVE_CONFIRM_MS + 1 })
  })

  it('放行之后清零：回来再按又要两次', () => {
    const left = confirmLeave(10_000, 11_000)
    expect(left.leave).toBe(true)
    expect(confirmLeave(left.next, 11_100).leave).toBe(false)
  })
})
