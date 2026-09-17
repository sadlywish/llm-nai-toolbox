import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installBackBridge } from './backStack'
import './styles.css'

// APK 壳按返回键时先问页面（见 backStack.ts）；浏览器里没人调它，装上也无害
installBackBridge()

const host = document.getElementById('root')
if (!host) throw new Error('找不到 #root 挂载点')

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
