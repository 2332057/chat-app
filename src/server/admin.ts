/**
 * 管理者判定。ADMIN_EMAILS はカンマ区切りのメールアドレス一覧で、
 * Worker のシークレットとして登録する（リポジトリには置かない）。
 * 未設定なら管理者は0人で、従来どおり全員が自分のスレッドしか触れない。
 */

const normalizeEmail = (email: string) => email.trim().toLowerCase()

export const parseAdminEmails = (raw?: string): string[] =>
  (raw ?? '')
    .split(',')
    .map(normalizeEmail)
    .filter((email) => email.length > 0)

export const isAdminEmail = (email: string, raw?: string): boolean =>
  parseAdminEmails(raw).includes(normalizeEmail(email))
