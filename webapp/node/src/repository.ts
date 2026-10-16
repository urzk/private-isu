import { POSTS_PER_PAGE } from './config.js'
import { execute, selectCount, selectOne, selectRows } from './db.js'
import type { Comment, Post, User } from './types.js'

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
}

// ---- users ----

export function findUserById(id: number): Promise<User | undefined> {
  return selectOne<User>('SELECT * FROM `users` WHERE `id` = ?', [id])
}

export function findActiveUserByAccountName(accountName: string): Promise<User | undefined> {
  return selectOne<User>('SELECT * FROM `users` WHERE `account_name` = ? AND `del_flg` = 0', [accountName])
}

export async function accountNameExists(accountName: string): Promise<boolean> {
  const row = await selectOne('SELECT 1 FROM users WHERE `account_name` = ?', [accountName])
  return Boolean(row)
}

export async function createUser(accountName: string, passhash: string): Promise<number> {
  const result = await execute('INSERT INTO `users` (`account_name`, `passhash`) VALUES (?, ?)', [accountName, passhash])
  return result.insertId
}

export function findBannableUsers(): Promise<User[]> {
  return selectRows<User>('SELECT * FROM `users` WHERE `authority` = 0 AND `del_flg` = 0 ORDER BY `created_at` DESC')
}

export async function banUsers(ids: string[]): Promise<void> {
  await Promise.all(ids.map((id) => execute('UPDATE `users` SET `del_flg` = ? WHERE `id` = ?', [1, id])))
}

async function getUsersByIds(userIds: number[]): Promise<Map<number, User>> {
  const users = new Map<number, User>()
  if (userIds.length === 0) return users
  const rows = await selectRows<User>('SELECT * FROM `users` WHERE `id` IN (?)', [[...new Set(userIds)]])
  for (const user of rows) users.set(user.id, user)
  return users
}

// ---- posts ----

const SELECT_ACTIVE_POSTS = 'SELECT `posts`.`id`, `posts`.`user_id`, `posts`.`body`, `posts`.`mime`, `posts`.`created_at` FROM `posts` JOIN `users` ON `posts`.`user_id` = `users`.`id` WHERE `users`.`del_flg` = 0'
const LATEST_FIRST = ' ORDER BY `posts`.`created_at` DESC LIMIT ' + POSTS_PER_PAGE

export function findLatestPosts(): Promise<Post[]> {
  return selectRows<Post>(SELECT_ACTIVE_POSTS + LATEST_FIRST)
}

export function findLatestPostsByUser(userId: number): Promise<Post[]> {
  return selectRows<Post>(SELECT_ACTIVE_POSTS + ' AND `posts`.`user_id` = ?' + LATEST_FIRST, [userId])
}

export function findLatestPostsBefore(maxCreatedAt: Date | null): Promise<Post[]> {
  return selectRows<Post>(SELECT_ACTIVE_POSTS + ' AND `posts`.`created_at` <= ?' + LATEST_FIRST, [maxCreatedAt])
}

export function findPostsById(id: string | undefined): Promise<Post[]> {
  return selectRows<Post>(SELECT_ACTIVE_POSTS + ' AND `posts`.`id` = ?', [id])
}

export function findPostImage(id: number): Promise<Pick<Post, 'mime' | 'imgdata'> | undefined> {
  return selectOne<Pick<Post, 'mime' | 'imgdata'>>('SELECT `mime`, `imgdata` FROM `posts` WHERE `id` = ?', [id])
}

export async function createPost(userId: number, mime: string, imgdata: Buffer, body: string): Promise<number> {
  const result = await execute('INSERT INTO `posts` (`user_id`, `mime`, `imgdata`, `body`) VALUES (?,?,?,?)', [userId, mime, imgdata, body])
  return result.insertId
}

export function countPostsByUser(userId: number): Promise<number> {
  return selectCount('SELECT COUNT(*) AS count FROM `posts` WHERE `user_id` = ?', [userId])
}

// ---- comments ----

export async function createComment(postId: number, userId: number, comment: string): Promise<void> {
  await execute('INSERT INTO `comments` (`post_id`, `user_id`, `comment`) VALUES (?,?,?)', [postId, userId, comment])
}

export function countCommentsByUser(userId: number): Promise<number> {
  return selectCount('SELECT COUNT(*) AS count FROM `comments` WHERE `user_id` = ?', [userId])
}

export function countCommentsOnUserPosts(userId: number): Promise<number> {
  return selectCount('SELECT COUNT(*) AS count FROM `comments` WHERE `post_id` IN (SELECT `id` FROM `posts` WHERE `user_id` = ?)', [userId])
}

async function getCommentCounts(postIds: number[]): Promise<Map<number, number>> {
  const rows = await selectRows<{ post_id: number; count: number }>('SELECT `post_id`, COUNT(*) AS `count` FROM `comments` WHERE `post_id` IN (?) GROUP BY `post_id`', [postIds])
  return new Map(rows.map((row) => [row.post_id, row.count]))
}

// 投稿ごとに新しい順で番号を振り、古い順(rn の降順)で並べ直す
function getComments(postIds: number[], allComments: boolean): Promise<Comment[]> {
  const latestOnly = allComments ? '' : ' WHERE `rn` <= 3'
  const sql = 'SELECT `id`, `post_id`, `user_id`, `comment`, `created_at` FROM (SELECT `comments`.*, ROW_NUMBER() OVER (PARTITION BY `post_id` ORDER BY `created_at` DESC) AS `rn` FROM `comments` WHERE `post_id` IN (?)) AS `c`' + latestOnly + ' ORDER BY `post_id`, `rn` DESC'
  return selectRows<Comment>(sql, [postIds])
}

// 投稿にコメント数・コメント(投稿者付き)・投稿者を埋め込む
export async function makePosts(posts: Post[], options: { allComments?: boolean } = {}): Promise<Post[]> {
  if (posts.length === 0) return posts
  const postIds = posts.map((post) => post.id)

  const commentCounts = await getCommentCounts(postIds)
  const comments = await getComments(postIds, Boolean(options.allComments))
  const users = await getUsersByIds([...posts.map((post) => post.user_id), ...comments.map((comment) => comment.user_id)])

  const commentsByPost = new Map<number, Comment[]>()
  for (const comment of comments) {
    const user = users.get(comment.user_id)
    if (!user) continue
    comment.user = user
    const list = commentsByPost.get(comment.post_id)
    if (list) list.push(comment)
    else commentsByPost.set(comment.post_id, [comment])
  }

  for (const post of posts) {
    post.comment_count = commentCounts.get(post.id) || 0
    post.comments = commentsByPost.get(post.id) ?? []
    post.user = users.get(post.user_id)
  }
  return posts
}
