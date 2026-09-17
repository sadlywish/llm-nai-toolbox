// 画风页（计划 Task 17，界面稿第四节中间那张）：与桌面端共用同一份 styles.json。
//
// 列表不维护本地增量：每次写操作（新建/改名/改标签/删除/排序/选为预设）成功后都整份重新拉一次
// `GET /api/styles`。桌面端随时也能改这份数据，手机这边自己算增量只会算出一份很快过期的东西，
// 不如老实重拉——反正这一页不大，多一次请求换一致性是划算的。
import { useCallback, useEffect, useState } from 'react'
import { nextStyleName, type StylePreset } from '@shared/styles'
import { messageOf, type ApiClient } from '../api'
import EditSheet from '../components/EditSheet'
import { moveId } from '../moveId'
import { useBackHandler } from '../useBackHandler'

interface Props {
  client: ApiClient
  /** 「覆盖到 artist 块」：把这条画风的标签写进手机工作区的 artist 字段，调用方负责切回工作台 */
  onOverrideArtist: (tags: string) => void
}

const TAGS_HINT = '逗号分隔；1.2::标签:: 是权重写法。'

/** 正在编辑的字段：改名与改标签共用一个弹层（EditSheet），靠 field 分支标题与校验规则 */
interface EditTarget {
  id: string
  field: 'name' | 'tags'
  value: string
}

/**
 * 「…」菜单的状态。confirmingDelete 为 true 时同一个弹层换成删除确认——手机上误触概率高，
 * 删除必须二次确认，但不能用 `window.confirm`（在 Electron 里会阻塞主进程），
 * 所以做成弹层内部的一个状态切换，而不是另开一个原生对话框。
 */
interface MenuState {
  id: string
  confirmingDelete: boolean
}

export default function Styles({ client, onOverrideArtist }: Props): JSX.Element {
  const [presets, setPresets] = useState<StylePreset[] | null>(null)
  const [currentId, setCurrentId] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 任何一条写请求在途时整页按钮都锁住：排序、删除这类操作如果允许连点，
  // 两个请求前后脚落盘会互相覆盖，落地顺序还和点击顺序不一定一致
  const [saving, setSaving] = useState(false)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await client.styles()
      setPresets(r.styles)
      setCurrentId(r.presetId)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setLoading(false)
    }
  }, [client])

  useEffect(() => {
    void reload()
  }, [reload])

  /** 写操作统一走这里：成功就整份重拉，失败把中文原因显示出来 */
  const runWrite = useCallback(
    (action: () => Promise<unknown>): void => {
      setSaving(true)
      setError(null)
      action()
        .then(() => reload())
        .catch((err: unknown) => setError(messageOf(err)))
        .finally(() => setSaving(false))
    },
    [reload],
  )

  const closeMenu = (): void => setMenu(null)
  // 返回键关操作菜单（删除确认那一步也整个关掉，同点遮罩）；编辑框自己在 EditSheet 里登记
  useBackHandler(menu !== null, closeMenu)
  const menuTarget = menu === null ? null : (presets?.find((p) => p.id === menu.id) ?? null)
  const menuIndex = menuTarget === null ? -1 : (presets?.findIndex((p) => p.id === menuTarget.id) ?? -1)

  const createNew = (): void => runWrite(() => client.createStyle(nextStyleName(presets ?? []), ''))

  const selectPreset = (id: string): void => {
    closeMenu()
    runWrite(() => client.setPresetStyle(id))
  }

  const overrideArtist = (preset: StylePreset): void => {
    closeMenu()
    onOverrideArtist(preset.tags)
  }

  const openRename = (preset: StylePreset): void => setEditTarget({ id: preset.id, field: 'name', value: preset.name })
  const openEditTags = (preset: StylePreset): void => setEditTarget({ id: preset.id, field: 'tags', value: preset.tags })

  const saveEdit = (target: EditTarget): void => {
    const original = presets?.find((p) => p.id === target.id)
    // 没改动就不发请求：弹层打开又原样关掉（点一下又反悔）是最常见的一种操作
    if (original !== undefined && original[target.field] === target.value) return
    const patch = target.field === 'name' ? { name: target.value } : { tags: target.value }
    runWrite(() => client.patchStyle(target.id, patch))
  }

  const confirmDelete = (): void => setMenu((m) => (m === null ? m : { ...m, confirmingDelete: true }))

  const doDelete = (id: string): void => {
    closeMenu()
    runWrite(() => client.deleteStyle(id))
  }

  const move = (id: string, delta: -1 | 1): void => {
    if (presets === null) return
    const ids = moveId(
      presets.map((p) => p.id),
      id,
      delta,
    )
    closeMenu()
    runWrite(() => client.reorderStyles(ids))
  }

  return (
    <>
      <div className="history-bar">
        <span className="sec">与桌面端共用，改动立刻同步</span>
        <span className="grow" />
        <button type="button" className="btn sm" disabled={saving} onClick={createNew}>
          + 新建
        </button>
      </div>

      {error !== null && <p className="alert">{error}</p>}

      {presets === null ? (
        <p className="hint">{loading ? '正在读画风…' : '读不到画风列表。'}</p>
      ) : presets.length === 0 ? (
        <p className="hint">还没有画风，点右上角新建一个。</p>
      ) : (
        <ul className="style-list">
          {presets.map((preset) => (
            <li key={preset.id}>
              <div className="style-item">
                {/* 固定宽度的圆点位：当前预设那一条才画出来，其余留白对齐，不用桌面端那套缩进技巧 */}
                <span className="style-dot">{preset.id === currentId ? '●' : ''}</span>
                <div className="style-main">
                  <span className="style-name">{preset.name}</span>
                  <span className={preset.tags.trim() === '' ? 'style-tags is-empty' : 'style-tags'}>
                    {preset.tags.trim() === '' ? '空' : preset.tags}
                  </span>
                </div>
                <button
                  type="button"
                  className="btn sm"
                  disabled={saving}
                  onClick={() => setMenu({ id: preset.id, confirmingDelete: false })}
                >
                  …
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {menuTarget !== null && menu !== null && (
        // 点遮罩关闭。用 target === currentTarget 而不是给弹层加 stopPropagation（同 EditSheet）
        <div
          className="sheet-mask"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeMenu()
          }}
        >
          <div className="sheet">
            {menu.confirmingDelete ? (
              <>
                <div className="sheet-head">
                  <b>删除「{menuTarget.name}」？</b>
                </div>
                <p className="hint">删除后不能恢复，桌面端也会同步删掉这一条。</p>
                <button type="button" className="btn" onClick={closeMenu}>
                  取消
                </button>
                <button type="button" className="btn danger" onClick={() => doDelete(menuTarget.id)}>
                  确认删除
                </button>
              </>
            ) : (
              <>
                <div className="sheet-head">
                  <b>{menuTarget.name}</b>
                  <span className="grow" />
                  <button type="button" className="btn sm" onClick={closeMenu}>
                    关闭
                  </button>
                </div>
                <button
                  type="button"
                  className="btn"
                  disabled={menuTarget.id === currentId}
                  onClick={() => selectPreset(menuTarget.id)}
                >
                  {menuTarget.id === currentId ? '当前预设' : '选为预设'}
                </button>
                <button type="button" className="btn" onClick={() => overrideArtist(menuTarget)}>
                  覆盖到 artist 块
                </button>
                <button type="button" className="btn" onClick={() => openRename(menuTarget)}>
                  改名
                </button>
                <button type="button" className="btn" onClick={() => openEditTags(menuTarget)}>
                  改标签
                </button>
                <button type="button" className="btn" disabled={menuIndex <= 0} onClick={() => move(menuTarget.id, -1)}>
                  上移
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={presets === null || menuIndex === -1 || menuIndex >= presets.length - 1}
                  onClick={() => move(menuTarget.id, 1)}
                >
                  下移
                </button>
                <button type="button" className="btn danger" onClick={confirmDelete}>
                  删除
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {editTarget !== null && (
        <EditSheet
          title={editTarget.field === 'name' ? '改名' : '改标签'}
          value={editTarget.value}
          input={editTarget.field === 'name' ? 'text' : 'tags'}
          hint={editTarget.field === 'tags' ? TAGS_HINT : undefined}
          onChange={(v) => setEditTarget((t) => (t === null ? t : { ...t, value: v }))}
          onClose={() => {
            saveEdit(editTarget)
            setEditTarget(null)
          }}
        />
      )}
    </>
  )
}
