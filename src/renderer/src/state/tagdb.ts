import { create } from 'zustand'
import type { TagdbStatus } from '../../../main/tagdb/loader'

interface TagdbState {
  status: TagdbStatus | null
  /** 订阅广播并主动问一次当前状态；返回取消订阅的函数 */
  init: () => () => void
}

export const useTagdb = create<TagdbState>((set) => ({
  status: null,
  init: () => {
    // 主动问一次：第一条广播可能在组件挂载之前就发出去了
    void window.api.tagdbStatus().then((s) => set({ status: s }))
    return window.api.onTagdbStatus((s) => set({ status: s }))
  },
}))
