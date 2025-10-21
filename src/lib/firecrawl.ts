interface FirecrawlResponse {
  success: boolean
  data?: {
    markdown?: string
    content?: string
    metadata?: {
      title?: string
      description?: string
      keywords?: string
      robots?: string
      ogTitle?: string
      ogDescription?: string
      ogUrl?: string
      ogImage?: string
      ogLocaleAlternate?: string[]
      ogSiteName?: string
      sourceURL?: string
    }
    llm_extraction?: Record<string, any>
  }
  error?: string
}

class CustomFirecrawlApp {
  private apiKey: string

  constructor({ apiKey }: { apiKey?: string }) {
    if (!apiKey) {
      throw new Error('Firecrawl API key is required')
    }
    this.apiKey = apiKey
  }

  async scrapeUrl(
    url: string,
    options: Record<string, any> = {},
  ): Promise<FirecrawlResponse> {
    try {
      const response = await fetch('https://api.firecrawl.dev/v0/scrape', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          url,
          ...options,
        }),
      })

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      return await response.json()
    } catch (error) {
      console.error('Firecrawl scrape error:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      }
    }
  }
}

export const firecrawl = new CustomFirecrawlApp({
  apiKey: process.env.FIRECRAWL_API_KEY,
})
