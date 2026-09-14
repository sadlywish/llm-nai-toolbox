/** invoke 被拒时 Electron 会包一层 "Error invoking remote method 'x:y': Error: …"，只留原因给人看 */
export function ipcErrorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '')
}
