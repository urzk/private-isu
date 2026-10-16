import { POSTS_PER_PAGE } from './config.js'
import { execute, selectOne, selectRows } from './db.js'
import type { Comment, Post, User } from './types.js'

// アプリは単一プロセスで動くため、画像以外の読み取りはすべてメモリ上のストアから返す。
// DB は書き込み(と画像本体)のためだけに使い、書き込み時にストアも同期して更新する。

// ---- in-memory store ----

const usersById = new Map<number, User>()
const usersByAccountName = new Map<string, User>()

// created_at DESC, id DESC (MySQL のインデックス逆順スキャンと同じ並び)
let postsDesc: Post[] = []
const postsById = new Map<number, Post>()
const postsByUser = new Map<number, Post[]>()

// 投稿ごとのコメント(古い順)。user は usersById と同じオブジェクトを参照する
const commentsByPost = new Map<number, Comment[]>()
const commentCountByUser = new Map<number, number>()

function comparePostsDesc(a: Post, b: Post): number {
  return b.created_at.getTime() - a.created_at.getTime() || b.id - a.id
}

// 降順配列に順序を保って挿入する(新規投稿はほぼ常に先頭)
function insertPostSorted(list: Post[], post: Post): void {
  let i = 0
  while (i < list.length && comparePostsDesc(list[i], post) < 0) i++
  list.splice(i, 0, post)
}

function addUser(user: User): void {
  usersById.set(user.id, user)
  usersByAccountName.set(user.account_name, user)
}

function addPost(post: Post): void {
  postsById.set(post.id, post)
  const list = postsByUser.get(post.user_id)
  if (list) insertPostSorted(list, post)
  else postsByUser.set(post.user_id, [post])
}

function addComment(comment: Comment): void {
  const list = commentsByPost.get(comment.post_id)
  if (list) list.push(comment)
  else commentsByPost.set(comment.post_id, [comment])
  commentCountByUser.set(comment.user_id, (commentCountByUser.get(comment.user_id) ?? 0) + 1)
}

async function loadStore(): Promise<void> {
  const [users, posts, comments] = await Promise.all([selectRows<User>('SELECT * FROM `users`'), selectRows<Post>('SELECT `id`, `user_id`, `body`, `mime`, `created_at` FROM `posts` ORDER BY `created_at` DESC, `id` DESC'), selectRows<Comment>('SELECT `id`, `post_id`, `user_id`, `comment`, `created_at` FROM `comments` ORDER BY `created_at`, `id`')])

  usersById.clear()
  usersByAccountName.clear()
  postsById.clear()
  postsByUser.clear()
  commentsByPost.clear()
  commentCountByUser.clear()

  for (const user of users) addUser(user)

  postsDesc = []
  for (const post of posts) {
    const user = usersById.get(post.user_id)
    if (!user) continue
    post.user = user
    postsDesc.push(post)
    addPost(post)
  }

  for (const comment of comments) {
    const user = usersById.get(comment.user_id)
    if (!user) continue
    comment.user = user
    addComment(comment)
  }
}

export const storeReady: Promise<void> = loadStore()

// ---- initialize ----

// ダンプには主キーしかないため、/initialize のたびに不足しているインデックスだけを作る
const INDEXES: { table: string; name: string; columns: string }[] = [
  { table: 'posts', name: 'idx_posts_created_at', columns: '`created_at`' },
  { table: 'posts', name: 'idx_posts_user_id_created_at', columns: '`user_id`, `created_at`' },
  { table: 'comments', name: 'idx_comments_post_id_created_at', columns: '`post_id`, `created_at`' },
  { table: 'comments', name: 'idx_comments_user_id', columns: '`user_id`' },
  { table: 'users', name: 'idx_users_authority_del_flg_created_at', columns: '`authority`, `del_flg`, `created_at`' }
]

async function ensureIndexes(): Promise<void> {
  const rows = await selectRows<{ table_name: string; index_name: string }>('SELECT `TABLE_NAME` AS `table_name`, `INDEX_NAME` AS `index_name` FROM `information_schema`.`STATISTICS` WHERE `TABLE_SCHEMA` = DATABASE()')
  const existing = new Set(rows.map((row) => `${row.table_name}.${row.index_name}`))
  for (const index of INDEXES) {
    if (existing.has(`${index.table}.${index.name}`)) continue
    await execute(`ALTER TABLE \`${index.table}\` ADD INDEX \`${index.name}\` (${index.columns})`)
  }
}

export async function dbInitialize(): Promise<void> {
  await ensureIndexes()
  const sqls = ['DELETE FROM users WHERE id > 1000', 'DELETE FROM posts WHERE id > 10000', 'DELETE FROM comments WHERE id > 100000', 'UPDATE users SET del_flg = 0']
  await Promise.all(sqls.map((sql) => execute(sql)))
  await execute('UPDATE users SET del_flg = 1 WHERE id % 50 = 0')
  clearImageCache()
  await loadStore()
}

// ---- users ----

export function findUserById(id: number): User | undefined {
  return usersById.get(id)
}

export function findActiveUserByAccountName(accountName: string): User | undefined {
  const user = usersByAccountName.get(accountName)
  return user && user.del_flg === 0 ? user : undefined
}

export function accountNameExists(accountName: string): boolean {
  return usersByAccountName.has(accountName)
}

export async function createUser(accountName: string, passhash: string): Promise<number> {
  const result = await execute('INSERT INTO `users` (`account_name`, `passhash`) VALUES (?, ?)', [accountName, passhash])
  const row = await selectOne<User>('SELECT * FROM `users` WHERE `id` = ?', [result.insertId])
  if (row) addUser(row)
  return result.insertId
}

export function findBannableUsers(): User[] {
  const users: User[] = []
  for (const user of usersById.values()) {
    if (user.authority === 0 && user.del_flg === 0) users.push(user)
  }
  return users.sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
}

export async function banUsers(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await execute('UPDATE `users` SET `del_flg` = ? WHERE `id` IN (?)', [1, ids])
  for (const id of ids) {
    const user = usersById.get(Number(id))
    if (user) user.del_flg = 1
  }
}

// ---- posts ----

function isActivePost(post: Post): boolean {
  return post.user!.del_flg === 0
}

function takeActivePosts(list: Post[], start = 0): Post[] {
  const result: Post[] = []
  for (let i = start; i < list.length && result.length < POSTS_PER_PAGE; i++) {
    if (isActivePost(list[i])) result.push(list[i])
  }
  return result
}

export function findLatestPosts(): Post[] {
  return takeActivePosts(postsDesc)
}

export function findLatestPostsByUser(userId: number): Post[] {
  return takeActivePosts(postsByUser.get(userId) ?? [])
}

export function findLatestPostsBefore(maxCreatedAt: Date | null): Post[] {
  if (!maxCreatedAt) return takeActivePosts(postsDesc)
  // created_at <= max となる最初の位置を二分探索する
  const max = maxCreatedAt.getTime()
  let lo = 0
  let hi = postsDesc.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (postsDesc[mid].created_at.getTime() > max) lo = mid + 1
    else hi = mid
  }
  return takeActivePosts(postsDesc, lo)
}

export function findPostById(id: string | undefined): Post | undefined {
  if (!id || !/^[0-9]+$/.test(id)) return undefined
  const post = postsById.get(Number(id))
  return post && isActivePost(post) ? post : undefined
}

// 画像は投稿 ID ごとに不変なので、メタ情報だけで存在確認できる
export function findPostMime(id: number): string | undefined {
  return postsById.get(id)?.mime
}

export function findPostCreatedAt(id: number): Date | undefined {
  return postsById.get(id)?.created_at
}

export async function createPost(userId: number, mime: string, imgdata: Buffer, body: string): Promise<number> {
  const result = await execute('INSERT INTO `posts` (`user_id`, `mime`, `imgdata`, `body`) VALUES (?,?,?,?)', [userId, mime, imgdata, body])
  const id = result.insertId
  const row = await selectOne<{ created_at: Date }>('SELECT `created_at` FROM `posts` WHERE `id` = ?', [id])
  const user = usersById.get(userId)
  if (row && user) {
    const post: Post = { id, user_id: userId, body, mime, created_at: row.created_at, user }
    insertPostSorted(postsDesc, post)
    addPost(post)
  }
  cacheImage(id, imgdata)
  return id
}

export function countPostsByUser(userId: number): number {
  return postsByUser.get(userId)?.length ?? 0
}

// ---- images ----

// 画像本体だけは DB に残し、最近使ったものをバイト数上限付きでメモリに持つ
const IMAGE_CACHE_LIMIT = 128 * 1024 * 1024
const imageCache = new Map<number, Buffer>()
let imageCacheBytes = 0

function cacheImage(id: number, imgdata: Buffer): void {
  if (imgdata.length > IMAGE_CACHE_LIMIT) return
  const old = imageCache.get(id)
  if (old) {
    imageCache.delete(id)
    imageCacheBytes -= old.length
  }
  imageCache.set(id, imgdata)
  imageCacheBytes += imgdata.length
  for (const [oldestId, oldest] of imageCache) {
    if (imageCacheBytes <= IMAGE_CACHE_LIMIT) break
    imageCache.delete(oldestId)
    imageCacheBytes -= oldest.length
  }
}

function clearImageCache(): void {
  imageCache.clear()
  imageCacheBytes = 0
}

export async function findPostImage(id: number): Promise<Buffer | undefined> {
  const cached = imageCache.get(id)
  if (cached) {
    // LRU: 末尾に移動
    imageCache.delete(id)
    imageCache.set(id, cached)
    return cached
  }
  const row = await selectOne<{ imgdata: Buffer }>('SELECT `imgdata` FROM `posts` WHERE `id` = ?', [id])
  if (!row) return undefined
  cacheImage(id, row.imgdata)
  return row.imgdata
}

// ---- comments ----

export async function createComment(postId: number, userId: number, comment: string): Promise<void> {
  const result = await execute('INSERT INTO `comments` (`post_id`, `user_id`, `comment`) VALUES (?,?,?)', [postId, userId, comment])
  const user = usersById.get(userId)
  if (user) addComment({ id: result.insertId, post_id: postId, user_id: userId, comment, created_at: new Date(), user })
}

export function countCommentsByUser(userId: number): number {
  return commentCountByUser.get(userId) ?? 0
}

export function countCommentsOnUserPosts(userId: number): number {
  let count = 0
  for (const post of postsByUser.get(userId) ?? []) count += commentsByPost.get(post.id)?.length ?? 0
  return count
}

// 投稿にコメント数・コメント(投稿者付き)を埋め込んだ表示用オブジェクトを作る(ストアは変更しない)
export function makePosts(posts: Post[], options: { allComments?: boolean } = {}): Post[] {
  return posts.map((post) => {
    const comments = commentsByPost.get(post.id) ?? []
    return {
      ...post,
      comment_count: comments.length,
      comments: options.allComments ? comments : comments.slice(-3)
    }
  })
}
