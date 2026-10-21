import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig(({mode}) => {
  const env=loadEnv(mode,process.cwd(),'')
  const target=env.GREENY_DEV_API_TARGET || 'http://127.0.0.1:8787'
  return {
    plugins:[react(),tailwindcss()],
    resolve:{alias:{'@':path.resolve(__dirname,'./src')}},
    server:{proxy:{'/api':{target,changeOrigin:true},'/dashboard/':{target,changeOrigin:true,ws:true},'/device/':{target,changeOrigin:true,ws:true}}},
  }
})
