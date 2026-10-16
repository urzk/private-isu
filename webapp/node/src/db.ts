import { createPool, type Pool, type RowDataPacket, type ResultSetHeader } from 'mysql2/promise'
import { DB_CONFIG } from './config.js'

export const db: Pool = createPool(DB_CONFIG)

export async function selectRows<T>(sql: string, params?: unknown[]): Promise<T[]> {
  const [rows] = await db.query<RowDataPacket[]>(sql, params)
  return rows as T[]
}

export async function selectOne<T>(sql: string, params?: unknown[]): Promise<T | undefined> {
  const rows = await selectRows<T>(sql, params)
  return rows[0]
}

export async function selectCount(sql: string, params?: unknown[]): Promise<number> {
  const row = await selectOne<{ count: number }>(sql, params)
  return row?.count ?? 0
}

export async function execute(sql: string, params?: unknown[]): Promise<ResultSetHeader> {
  const [result] = await db.query<ResultSetHeader>(sql, params)
  return result
}
