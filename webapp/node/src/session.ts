import type { Next } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import Memcached from 'memcached'
import { MEMCACHED_ADDRESS, SESSION_COOKIE_NAME, SESSION_KEY_PREFIX, SESSION_TTL } from './config.js'
import { findUserById } from './repository.js'
import type { AppContext, SessionData, User } from './types.js'
import { generateToken } from './utils.js'

// ---- memcached store ----

const memcached = new Memcached(MEMCACHED_ADDRESS)

function decodeSession(data: unknown): SessionData | undefined {
  let raw: string
  if (typeof data === 'string') {
    raw = data
  } else if (Buffer.isBuffer(data)) {
    raw = data.toString('utf8')
  } else {
    return undefined
  }
  return JSON.parse(raw) as SessionData
}

// アプリは単一プロセスなので、memcached の手前にプロセス内キャッシュを置いて往復を省く
const LOCAL_SESSION_LIMIT = 100_000
const localSessions = new Map<string, SessionData>()

function setLocalSession(sid: string, session: SessionData): void {
  localSessions.delete(sid)
  localSessions.set(sid, session)
  if (localSessions.size > LOCAL_SESSION_LIMIT) {
    const oldest = localSessions.keys().next().value
    if (oldest !== undefined) localSessions.delete(oldest)
  }
}

async function getSessionFromStore(sid: string): Promise<SessionData | undefined> {
  const local = localSessions.get(sid)
  if (local) return local
  const session = await getSessionFromMemcached(sid)
  if (session) setLocalSession(sid, session)
  return session
}

function getSessionFromMemcached(sid: string): Promise<SessionData | undefined> {
  return new Promise((resolve) => {
    memcached.get(SESSION_KEY_PREFIX + sid, (err, data) => {
      if (err) {
        console.error('memcached get error', err)
        resolve(undefined)
        return
      }
      if (!data) {
        resolve(undefined)
        return
      }
      try {
        resolve(decodeSession(data))
      } catch (e) {
        console.error('memcached parse error', e)
        resolve(undefined)
      }
    })
  })
}

function saveSessionToStore(sid: string, session: SessionData): Promise<void> {
  setLocalSession(sid, session)
  return new Promise<void>((resolve) => {
    memcached.set(SESSION_KEY_PREFIX + sid, JSON.stringify(session), SESSION_TTL, (err) => {
      if (err) {
        console.error('memcached set error', err)
      }
      resolve()
    })
  })
}

function deleteSessionFromStore(sid: string): Promise<void> {
  localSessions.delete(sid)
  return new Promise<void>((resolve) => {
    memcached.del(SESSION_KEY_PREFIX + sid, (err) => {
      if (err) {
        console.error('memcached delete error', err)
      }
      resolve()
    })
  })
}

// ---- middleware ----

// Dirty tracking only observes direct property replacements; nested mutations require
// assigning a new object back onto the session to persist.
function trackChanges(target: SessionData, onChange: () => void): SessionData {
  return new Proxy(target, {
    set(target, prop, value) {
      if (Reflect.get(target, prop) !== value) onChange()
      return Reflect.set(target, prop, value)
    },
    deleteProperty(target, prop) {
      if (Reflect.has(target, prop)) onChange()
      return Reflect.deleteProperty(target, prop)
    }
  })
}

export async function sessionMiddleware(c: AppContext, next: Next): Promise<void> {
  const existingSid = getCookie(c, SESSION_COOKIE_NAME)
  const storedSession = existingSid ? await getSessionFromStore(existingSid) : undefined

  // 新規セッションは中身が書き込まれたときだけ Cookie 発行・保存する(空セッションの保存を省く)
  let sessionId: string
  let session: SessionData
  let isSessionDirty = false
  const isNewSession = !storedSession
  if (storedSession) {
    sessionId = existingSid as string
    session = storedSession
  } else {
    sessionId = generateToken()
    session = {}
  }

  const trackedSession = trackChanges(session, () => {
    isSessionDirty = true
  })
  c.set('session', trackedSession)
  c.set('sessionId', sessionId)
  try {
    await next()
  } finally {
    if (c.get('session') === trackedSession && isSessionDirty && !c.get('sessionDestroyed')) {
      if (isNewSession) setCookie(c, SESSION_COOKIE_NAME, sessionId, { httpOnly: true, path: '/' })
      await saveSessionToStore(sessionId, session)
    }
  }
}

// ---- helpers ----

export function getSession(c: AppContext): SessionData {
  return c.get('session')
}

export function startUserSession(c: AppContext, userId: number): void {
  const session = getSession(c)
  session.userId = userId
  session.csrfToken = generateToken()
}

export async function destroySession(c: AppContext): Promise<void> {
  const sid = c.get('sessionId')
  c.set('sessionDestroyed', true)
  if (sid) {
    await deleteSessionFromStore(sid)
  }
  setCookie(c, SESSION_COOKIE_NAME, '', { maxAge: 0, path: '/' })
}

// ストアのユーザーは共有オブジェクトなので、CSRF トークンはコピーに載せる
export async function getSessionUser(c: AppContext): Promise<User | undefined> {
  const session = getSession(c)
  if (!session.userId) return undefined
  const user = findUserById(session.userId)
  return user ? { ...user, csrfToken: session.csrfToken } : undefined
}
