import crypto from 'crypto'

export interface ManagerTokenPayload {
  agentId?: string
  namespace?: string
  namespaceSlug?: string
  officeId?: string
  exp?: number
  iat?: number
  jti?: string
  [key: string]: unknown
}

const BASE64_URL_REGEXP = /^[A-Za-z0-9\-_]+$/

function decodeBase64UrlSegment(segment: string): string {
  if (!BASE64_URL_REGEXP.test(segment)) {
    throw new Error('Invalid base64url segment')
  }
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/')
  const pad = normalized.length % 4
  const padded = pad ? normalized + '='.repeat(4 - pad) : normalized
  return Buffer.from(padded, 'base64').toString('utf8')
}

export function verifyManagerToken(token: string, secret: string): ManagerTokenPayload {
  if (!token || typeof token !== 'string') {
    throw new Error('Token is required')
  }
  if (!secret) {
    throw new Error('Manager token secret not configured')
  }

  const parts = token.split('.')
  if (parts.length !== 3) {
    throw new Error('Invalid token format')
  }

  const [encodedHeader, encodedBody, signature] = parts
  const signingInput = `${encodedHeader}.${encodedBody}`
  const expectedBuffer = crypto.createHmac('sha256', secret).update(signingInput).digest()

  const normalizeBase64Url = (value: string) => {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
    const pad = normalized.length % 4
    return pad ? normalized + '='.repeat(4 - pad) : normalized
  }

  let actualBuffer: Buffer
  try {
    actualBuffer = Buffer.from(normalizeBase64Url(signature), 'base64')
  } catch (err) {
    throw new Error('Invalid token signature encoding')
  }

  const expectedView = new Uint8Array(expectedBuffer)
  const actualView = new Uint8Array(actualBuffer)

  if (expectedView.length !== actualView.length) {
    throw new Error('Invalid token signature')
  }
  if (!crypto.timingSafeEqual(expectedView, actualView)) {
    throw new Error('Invalid token signature')
  }

  const payloadJson = decodeBase64UrlSegment(encodedBody)
  const payload = JSON.parse(payloadJson) as ManagerTokenPayload
  if (payload.exp && Date.now() / 1000 > payload.exp) {
    throw new Error('Token expired')
  }
  return payload
}
