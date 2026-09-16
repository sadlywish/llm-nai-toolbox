// 参数页宽高的约束（计划 Task 13）：对齐到 64 的倍数、总像素不超过服务端给的上限。
//
// 手机上不拦用户输入——打字过程中允许任何数字，约束只在失焦时套用一次（EditSheet 同样的
// 「写完再说哪儿不对」思路），否则每敲一位数字宽高就跳一次，输入体验会很糟。
import { alignTo64 } from '@shared/naiOptions'
import type { GenParams } from '@shared/workspace'

/**
 * 宽高对齐到 64 的倍数，且乘积不超过 maxPixels；超了按比例缩小两边再对齐。
 *
 * 对齐会把边长收到 64 的整数倍，缩放之后再对齐仍可能刚好多出一格（四舍五入的方向问题），
 * 所以最后照 `calcNaiDimensions`（`main/llm/nai.ts`）同样的收尾逻辑，从较长的一边开始
 * 逐格收缩，直到确实不超限——两处用的是同一套算法，宽高比只有它俩会算错一致的错误值。
 */
export function clampParams(params: GenParams, maxPixels: number): GenParams {
  let width = alignTo64(params.width)
  let height = alignTo64(params.height)

  if (width * height > maxPixels) {
    const scale = Math.sqrt(maxPixels / (width * height))
    width = alignTo64(width * scale)
    height = alignTo64(height * scale)
    while (width * height > maxPixels && (width > 64 || height > 64)) {
      if (width >= height) width -= 64
      else height -= 64
    }
  }

  return { ...params, width, height }
}
