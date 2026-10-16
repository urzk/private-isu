import ejs from 'ejs'
import path from 'path'
import { fileURLToPath } from 'url'
import { getSession } from './session.js'
import type { AppContext, Post } from './types.js'

const VIEWS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../views')

const escapeMap: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}

function escapeHtml(src: string): string {
  return src.replace(/[&<>"']/g, (char) => escapeMap[char] || char)
}

function formatBody(body: string): string {
  return escapeHtml(body).replace(/\r?\n/g, '<br>')
}

export const MIME_EXTENSIONS = new Map<string, string>([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/gif', 'gif']
])

export function imageUrl(post: Pick<Post, 'id' | 'mime'>): string {
  const ext = MIME_EXTENSIONS.get(post.mime)
  return `/image/${post.id}${ext ? `.${ext}` : ''}`
}

// フラッシュメッセージは一度表示したら消す
export async function render(c: AppContext, view: string, params: Record<string, unknown>): Promise<Response> {
  const session = getSession(c)
  const messages = { notice: session.flashNotice }
  session.flashNotice = undefined
  const html = await ejs.renderFile(path.join(VIEWS_DIR, view), { ...params, messages, formatBody })
  return c.html(html)
}
