export const PORT = Number(process.env.PORT) || 8080

export const POSTS_PER_PAGE = 20
export const UPLOAD_LIMIT = 10 * 1024 * 1024

export const DB_CONFIG = {
  host: process.env.ISUCONP_DB_HOST || 'localhost',
  port: Number(process.env.ISUCONP_DB_PORT) || 3306,
  user: process.env.ISUCONP_DB_USER || 'root',
  password: process.env.ISUCONP_DB_PASSWORD,
  database: process.env.ISUCONP_DB_NAME || 'isuconp',
  connectionLimit: 10,
  charset: 'utf8mb4'
}

export const MEMCACHED_ADDRESS = process.env.ISUCONP_MEMCACHED_ADDRESS || 'localhost:11211'

export const SESSION_COOKIE_NAME = 'sid'
export const SESSION_KEY_PREFIX = 'isuconp-node.session:'

const DEFAULT_SESSION_TTL = 24 * 60 * 60

function parseSessionTtl(value: string | undefined): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_SESSION_TTL
}

export const SESSION_TTL = parseSessionTtl(process.env.ISUCONP_SESSION_TTL)
