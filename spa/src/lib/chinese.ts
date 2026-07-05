import * as OpenCC from 'opencc-js'

const twToCn = OpenCC.Converter({ from: 'tw', to: 'cn' })
const cnToTw = OpenCC.Converter({ from: 'cn', to: 'tw' })

export function toSimplified(text: string): string {
  return twToCn(text)
}

export function toTraditional(text: string): string {
  return cnToTw(text)
}
