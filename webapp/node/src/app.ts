import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import fs from 'fs'
import path from 'path'
import { PORT, UPLOAD_LIMIT } from './config.js'
import * as repo from './repository.js'
import { destroySession, getSession, getSessionUser, sessionMiddleware, startUserSession } from './session.js'
import type { AppContext, AppEnv, ParsedBody, User } from './types.js'
import { calculatePasshash, ensureFile, ensureString, ensureStringArray, errorMessage, validateUser } from './utils.js'
import { MIME_EXTENSIONS, imageUrl, render } from './view.js'

const app = new Hono<AppEnv>()

// ---- route helpers ----

async function parseBody(c: AppContext): Promise<ParsedBody> {
  return (await c.req.parseBody()) as ParsedBody
}

function isValidCsrfToken(c: AppContext, body: ParsedBody): boolean {
  return body.csrf_token === getSession(c).csrfToken
}

function invalidCsrfToken(c: AppContext): Response {
  return c.text('invalid CSRF Token', 422)
}

function redirectWithNotice(c: AppContext, notice: string, location: string): Response {
  getSession(c).flashNotice = notice
  return c.redirect(location)
}

function internalError(c: AppContext, e: unknown): Response {
  console.error(e)
  return c.text(errorMessage(e), 500)
}

function isAdmin(user: User): boolean {
  return user.authority !== 0
}

async function tryLogin(accountName: string, password: string): Promise<User | undefined> {
  const user = repo.findActiveUserByAccountName(accountName)
  if (!user) return undefined
  if (calculatePasshash(accountName, password) === user.passhash) return user
  return undefined
}

function parseMaxCreatedAt(value: string | undefined): Date | null {
  if (typeof value !== 'string' || value.length === 0) return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('Invalid max_created_at')
  }
  return parsed
}

function isAllowedImageMime(mime: string): boolean {
  return mime.includes('jpeg') || mime.includes('png') || mime.includes('gif')
}

// ---- HTTP caching ----

// ベンチマーカーは Cache-Control の max-age 内なら条件付きリクエストを送り、304 を成功として扱う
const CACHE_CONTROL = 'public, max-age=86400'

function isNotModified(c: AppContext, etag: string, lastModified: string): boolean {
  const ifNoneMatch = c.req.header('If-None-Match')
  if (ifNoneMatch !== undefined) return ifNoneMatch === etag
  return c.req.header('If-Modified-Since') === lastModified
}

function notModified(etag: string, lastModified: string): Response {
  return new Response(null, { status: 304, headers: { 'Cache-Control': CACHE_CONTROL, ETag: etag, 'Last-Modified': lastModified } })
}

// public/ の静的ファイルは小さいので起動時にすべてメモリへ読み込む
const PUBLIC_DIR = '../public'
const STATIC_MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ico': 'image/x-icon',
  '.gif': 'image/gif',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml'
}

interface StaticFile {
  body: Uint8Array<ArrayBuffer>
  mime: string
  etag: string
  lastModified: string
}

function loadStaticFiles(root: string): Map<string, StaticFile> {
  const files = new Map<string, StaticFile>()
  const walk = (dir: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath)
        continue
      }
      const mime = STATIC_MIME_TYPES[path.extname(entry.name).toLowerCase()]
      if (!entry.isFile() || !mime) continue
      const stats = fs.statSync(fullPath)
      const urlPath = '/' + path.relative(root, fullPath).split(path.sep).join('/')
      files.set(urlPath, {
        body: new Uint8Array(fs.readFileSync(fullPath)),
        mime,
        etag: `"${stats.size.toString(16)}-${stats.mtimeMs.toString(16)}"`,
        lastModified: stats.mtime.toUTCString()
      })
    }
  }
  walk(root)
  return files
}

const staticFiles = loadStaticFiles(PUBLIC_DIR)

// ---- middleware ----

// 静的ファイルと画像はセッション不要なので、セッションミドルウェアより前で返す
app.use('*', async (c, next) => {
  const file = c.req.method === 'GET' ? staticFiles.get(c.req.path) : undefined
  if (!file) return next()
  if (isNotModified(c, file.etag, file.lastModified)) return notModified(file.etag, file.lastModified)
  return new Response(file.body, { headers: { 'Content-Type': file.mime, 'Cache-Control': CACHE_CONTROL, ETag: file.etag, 'Last-Modified': file.lastModified } })
})

app.get('/image/:filename{[0-9]+\\.(png|jpg|gif)}', async (c) => {
  try {
    const [idString, ext] = c.req.param('filename')!.split('.')
    const id = Number(idString)
    if (id === 0) {
      return new Response('', { status: 200 })
    }
    const mime = repo.findPostMime(id)
    if (!mime || MIME_EXTENSIONS.get(mime) !== ext) return c.text('image not found', 404)
    // 投稿画像は ID ごとに不変なので、ID と投稿日時で検証できる(304 なら DB を読まない)
    const etag = `"${id}"`
    const lastModified = repo.findPostCreatedAt(id)!.toUTCString()
    if (isNotModified(c, etag, lastModified)) return notModified(etag, lastModified)
    const imgdata = await repo.findPostImage(id)
    if (!imgdata) return c.text('image not found', 404)
    return new Response(imgdata as Uint8Array<ArrayBuffer>, {
      headers: { 'Content-Type': mime, 'Cache-Control': CACHE_CONTROL, ETag: etag, 'Last-Modified': lastModified }
    })
  } catch (e) {
    return internalError(c, e)
  }
})

app.use('*', sessionMiddleware)

// ---- initialize ----

app.get('/initialize', async (c) => {
  try {
    await repo.dbInitialize()
    return c.text('OK')
  } catch (e) {
    console.error(e)
    return c.text(String(e), 500)
  }
})

// ---- auth ----

app.get('/login', async (c) => {
  const me = await getSessionUser(c)
  if (me) return c.redirect('/')
  return render(c, 'login.ejs', { me })
})

app.post('/login', async (c) => {
  const me = await getSessionUser(c)
  if (me) return c.redirect('/')
  const body = await parseBody(c)
  try {
    const user = await tryLogin(ensureString(body.account_name), ensureString(body.password))
    if (!user) return redirectWithNotice(c, 'アカウント名かパスワードが間違っています', '/login')
    startUserSession(c, user.id)
    return c.redirect('/')
  } catch (e) {
    return internalError(c, e)
  }
})

app.get('/register', async (c) => {
  const me = await getSessionUser(c)
  if (me) return c.redirect('/')
  return render(c, 'register.ejs', { me })
})

app.post('/register', async (c) => {
  const me = await getSessionUser(c)
  if (me) return c.redirect('/')
  const body = await parseBody(c)
  const accountName = ensureString(body.account_name)
  const password = ensureString(body.password)
  if (!validateUser(accountName, password)) {
    return redirectWithNotice(c, 'アカウント名は3文字以上、パスワードは6文字以上である必要があります', '/register')
  }
  if (repo.accountNameExists(accountName)) {
    return redirectWithNotice(c, 'アカウント名がすでに使われています', '/register')
  }
  const userId = await repo.createUser(accountName, calculatePasshash(accountName, password))
  startUserSession(c, userId)
  return c.redirect('/')
})

app.get('/logout', async (c) => {
  await destroySession(c)
  return c.redirect('/')
})

// ---- timeline / posts ----

app.get('/', async (c) => {
  try {
    const me = await getSessionUser(c)
    const posts = repo.makePosts(repo.findLatestPosts())
    return render(c, 'index.ejs', { posts, me, imageUrl })
  } catch (e) {
    return internalError(c, e)
  }
})

app.get('/:accountName{@[A-Za-z0-9_]+}', async (c) => {
  try {
    const accountName = c.req.param('accountName')!.slice(1)
    const user = repo.findActiveUserByAccountName(accountName)
    if (!user) return c.text('not_found', 404)
    const posts = repo.makePosts(repo.findLatestPostsByUser(user.id))
    const commentCount = repo.countCommentsByUser(user.id)
    const postCount = repo.countPostsByUser(user.id)
    const commentedCount = repo.countCommentsOnUserPosts(user.id)
    const me = await getSessionUser(c)
    return render(c, 'user.ejs', { me, user, posts, post_count: postCount, comment_count: commentCount, commented_count: commentedCount, imageUrl })
  } catch (e) {
    console.error(e)
    return c.text('ERROR', 500)
  }
})

app.get('/posts', async (c) => {
  const maxCreatedAt = parseMaxCreatedAt(c.req.query('max_created_at'))
  const me = await getSessionUser(c)
  const posts = repo.makePosts(repo.findLatestPostsBefore(maxCreatedAt))
  return render(c, 'posts.ejs', { me, imageUrl, posts })
})

app.get('/posts/:id', async (c) => {
  const found = repo.findPostById(c.req.param('id'))
  if (!found) return c.text('not found', 404)
  const [post] = repo.makePosts([found], { allComments: true })
  const me = await getSessionUser(c)
  return render(c, 'post.ejs', { imageUrl, post, me })
})

app.post('/', async (c) => {
  const me = await getSessionUser(c)
  if (!me) return c.redirect('/login')
  const body = await parseBody(c)
  if (!isValidCsrfToken(c, body)) return invalidCsrfToken(c)
  const file = ensureFile(body.file)
  if (!file) return redirectWithNotice(c, '画像が必須です', '/')
  if (!isAllowedImageMime(file.type)) return redirectWithNotice(c, '投稿できる画像形式はjpgとpngとgifだけです', '/')
  if (file.size > UPLOAD_LIMIT) return redirectWithNotice(c, 'ファイルサイズが大きすぎます', '/')
  const imgdata = Buffer.from(await file.arrayBuffer())
  const postId = await repo.createPost(me.id, file.type, imgdata, ensureString(body.body))
  return c.redirect(`/posts/${encodeURIComponent(String(postId))}`)
})

// ---- comments ----

app.post('/comment', async (c) => {
  const me = await getSessionUser(c)
  if (!me) return c.redirect('/login')
  const body = await parseBody(c)
  if (!isValidCsrfToken(c, body)) return invalidCsrfToken(c)
  const postIdString = ensureString(body.post_id)
  if (!/^[0-9]+$/.test(postIdString)) return c.text('post_idは整数のみです')
  await repo.createComment(Number(postIdString), me.id, ensureString(body.comment))
  return c.redirect(`/posts/${encodeURIComponent(postIdString)}`)
})

// ---- admin ----

app.get('/admin/banned', async (c) => {
  const me = await getSessionUser(c)
  if (!me) return c.redirect('/login')
  if (!isAdmin(me)) return c.text('authority is required', 403)
  const users = repo.findBannableUsers()
  return render(c, 'banned.ejs', { me, users })
})

app.post('/admin/banned', async (c) => {
  const me = await getSessionUser(c)
  if (!me) return c.redirect('/')
  if (!isAdmin(me)) return c.text('authority is required', 403)
  const body = await parseBody(c)
  if (!isValidCsrfToken(c, body)) return invalidCsrfToken(c)
  await repo.banUsers(ensureStringArray(body.uid))
  return c.redirect('/admin/banned')
})

// ---- static files ----

app.use('/*', serveStatic({ root: '../public' }))

// DB が未起動でもサーバーは立ち上げ、ストアは /initialize で読み込み直す
await repo.storeReady.catch((e) => console.error('failed to load store', e))

serve({ fetch: app.fetch, port: PORT }, (info: { port: number }) => {
  console.log(`server started on ${info.port}`)
})
