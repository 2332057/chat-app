export function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '').trim()
}
