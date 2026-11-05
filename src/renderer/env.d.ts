import type { IdeApi } from '../shared/api'

declare global {
  interface Window {
    api: IdeApi
  }
}

export {}
