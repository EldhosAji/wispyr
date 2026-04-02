/**
 * Web Fetch Tool — fetch URL content and convert HTML to readable text.
 * No browser needed — uses Node.js http/https.
 */
import { registerTool, type ToolContext, type ToolResult } from '../tool-registry'
import https from 'https'
import http from 'http'

export function registerWebFetchTool(): void {
  registerTool({
    name: 'fetch_url',
    description: 'Fetch a URL and return its content as text. HTML is auto-converted to readable text.',
    parameters: [
      { name: 'url', type: 'string', description: 'URL to fetch', required: true },
      { name: 'selector', type: 'string', description: 'CSS-like content hint (e.g. "main article content")', required: false },
    ],
    permissionLevel: 'read_only',
    concurrencySafe: true,
    async execute(params: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
      const url = params.url || ''
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        return { success: false, log: 'Invalid URL', result: '', error: 'URL must start with http:// or https://' }
      }

      try {
        const content = await fetchUrl(url)
        const cleaned = htmlToText(content)
        const truncated = cleaned.length > 30000 ? cleaned.substring(0, 30000) + '\n...(truncated)' : cleaned

        return {
          success: true,
          log: `Fetched: ${url}\nSize: ${content.length} chars → ${cleaned.length} chars (cleaned)\n\n── Content ──\n${truncated}`,
          result: `Fetched ${url}: ${cleaned.length} chars`,
        }
      } catch (err: any) {
        return { success: false, log: `Failed to fetch ${url}: ${err.message}`, result: '', error: err.message }
      }
    },
  })
}

function fetchUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const transport = url.startsWith('https') ? https : http
    const req = transport.get(url, {
      timeout: 15000,
      headers: { 'User-Agent': 'Wispyr/1.0' },
    }, (res) => {
      // Follow redirects
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchUrl(res.headers.location).then(resolve).catch(reject)
        return
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => resolve(data))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')) })
  })
}

/** Simple HTML to text conversion — strips tags, decodes entities, cleans whitespace */
function htmlToText(html: string): string {
  let text = html
  // Remove script, style, nav, footer
  text = text.replace(/<(script|style|nav|footer|header|aside)[^>]*>[\s\S]*?<\/\1>/gi, '')
  // Convert common block elements to newlines
  text = text.replace(/<\/?(p|div|br|h[1-6]|li|tr|blockquote|section|article)[^>]*>/gi, '\n')
  // Convert links to [text](url) format
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
  // Remove all remaining tags
  text = text.replace(/<[^>]+>/g, '')
  // Decode HTML entities
  text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
  // Clean up whitespace
  text = text.replace(/[ \t]+/g, ' ')
  text = text.replace(/\n\s*\n\s*\n/g, '\n\n')
  return text.trim()
}
