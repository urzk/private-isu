import crypto from 'crypto'
import type { ParsedBodyValue } from './types.js'

// ---- crypto / auth ----

export function generateToken(): string {
  return crypto.randomBytes(16).toString('hex')
}

function digest(src: string): string {
  return crypto.createHash('sha512').update(src, 'utf8').digest('hex')
}

export function calculatePasshash(accountName: string, password: string): string {
  const salt = digest(accountName)
  return digest(`${password}:${salt}`)
}

export function validateUser(accountName: string, password: string): boolean {
  return /^[0-9a-zA-Z_]{3,}$/.test(accountName) && /^[0-9a-zA-Z_]{6,}$/.test(password)
}

// ---- errors ----

export function errorMessage(e: unknown): string {
  return String(e instanceof Error ? e.message : e)
}

// ---- request body ----

export function ensureString(value: ParsedBodyValue): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const first = value[0]
    if (typeof first === 'string') return first
  }
  return ''
}

const hasFileConstructor = typeof File !== 'undefined'

export function ensureFile(value: ParsedBodyValue): File | undefined {
  if (!hasFileConstructor) return undefined
  if (value instanceof File) return value
  if (Array.isArray(value)) {
    const first = value[0]
    if (first instanceof File) return first
  }
  return undefined
}

export function ensureStringArray(value: ParsedBodyValue): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string')
  }
  if (typeof value === 'string') return [value]
  return []
}
