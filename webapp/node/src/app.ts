import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
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
  const user = await repo.findActiveUserByAccountName(accountName)
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

// ---- middleware ----

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
  if (await repo.accountNameExists(accountName)) {
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
    const posts = await repo.makePosts(await repo.findLatestPosts())
    return render(c, 'index.ejs', { posts, me, imageUrl })
  } catch (e) {
    return internalError(c, e)
  }
})

app.get('/:accountName{@[A-Za-z0-9_]+}', async (c) => {
  try {
    const accountName = c.req.param('accountName')!.slice(1)
    const user = await repo.findActiveUserByAccountName(accountName)
    if (!user) return c.text('not_found', 404)
    const posts = await repo.makePosts(await repo.findLatestPostsByUser(user.id))
    const commentCount = await repo.countCommentsByUser(user.id)
    const postCount = await repo.countPostsByUser(user.id)
    const commentedCount = await repo.countCommentsOnUserPosts(user.id)
    const me = await getSessionUser(c)
    return render(c, 'user.ejs', { me, user, posts, post_count: postCount, comment_count: commentCount, commented_count: commentedCount, imageUrl })
  } catch (e) {
    console.error(e)
    return c.text('ERROR', 500)
  }
})

app.get('/posts', async (c) => {
  const maxCreatedAt = parseMaxCreatedAt(c.req.query('max_created_at'))
  const rows = await repo.findLatestPostsBefore(maxCreatedAt)
  const me = await getSessionUser(c)
  const posts = await repo.makePosts(rows)
  return render(c, 'posts.ejs', { me, imageUrl, posts })
})

app.get('/posts/:id', async (c) => {
  const posts = await repo.makePosts(await repo.findPostsById(c.req.param('id')), { allComments: true })
  const post = posts[0]
  if (!post) return c.text('not found', 404)
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

app.get('/image/:filename{[0-9]+\\.(png|jpg|gif)}', async (c) => {
  try {
    const [idString, ext] = c.req.param('filename')!.split('.')
    const id = Number(idString)
    if (id === 0) {
      return new Response('', { status: 200 })
    }
    const post = await repo.findPostImage(id)
    if (!post || MIME_EXTENSIONS.get(post.mime) !== ext) return c.text('image not found', 404)
    return new Response(new Uint8Array(post.imgdata), { headers: { 'Content-Type': post.mime } })
  } catch (e) {
    return internalError(c, e)
  }
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
  const users = await repo.findBannableUsers()
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

serve({ fetch: app.fetch, port: PORT }, (info: { port: number }) => {
  console.log(`server started on ${info.port}`)
})
