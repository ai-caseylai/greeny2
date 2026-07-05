import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { toSimplified, toTraditional } from '../lib/chinese'

export function useChineseText() {
  const { i18n } = useTranslation()
  const locale = i18n.language

  const ct = useCallback((text: string): string => {
    if (!text) return text
    if (locale === 'zh-CN') return toSimplified(text)
    if (locale === 'zh-TW' || locale === 'zh-TW') return toTraditional(text)
    return text
  }, [locale])

  return ct
}
