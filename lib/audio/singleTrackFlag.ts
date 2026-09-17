/**
 * 单轨音频已为正式默认路径（第二段）。
 *
 * 本模块为历史兼容垫片：一律返回 true，不再读取任何环境变量或浏览器全局开关。
 * 新代码不得再经 flag 选择 provider；服务端授权只判 Subject ownership、
 * Work 生命周期与资产状态。
 *
 * @deprecated 单轨恒开启，保留导出仅为兼容既有 import；新代码直接走单轨路径。
 */

/**
 * 服务端单轨授权判定（恒开启）。
 *
 * @deprecated 单轨恒开启；保留签名仅为兼容既有无参调用。
 */
export function isSingleTrackServerEnabled(): boolean {
  return true;
}

/**
 * 客户端 provider 选择判定（恒开启）。
 *
 * @deprecated 单轨恒开启；保留签名仅为兼容既有无参调用。
 */
export function isSingleTrackAudioEnabled(): boolean {
  return true;
}
