import { assistantPrompt } from '@/lib/prompt-utils'
import { DiffWithReplacement } from '@/lib/utils'
import { XmlPrompt } from '@/lib/xml-prompt'
import {
  convertToModelMessages,
  CoreMessage,
  createIdGenerator,
  createUIMessageStream,
  createUIMessageStreamResponse,
  smoothStream,
  stepCountIs,
  streamText,
  UIMessage,
} from 'ai'
import { format } from 'date-fns'
import 'diff-match-patch-line-and-word'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { redis } from '../../../lib/redis'
import { j, privateProcedure } from '../../jstack'
import { create_read_website_content } from './read-website-content'
import { parseAttachments } from './utils'

import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { getAccount } from '../utils/get-account'
import { createTweetTool } from './tools/create-tweet-tool'
import { Ratelimit } from '@upstash/ratelimit'
import { PayloadTweet } from '@/hooks/use-tweets-v2'

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
})

// ==================== Types ====================

export interface EditTweetToolResult {
  id: string
  improvedText: string
  diffs: DiffWithReplacement[]
}

// Custom message type that ensures all messages have an ID
export type ChatMessage = Omit<UIMessage, 'content'> & {
  content: string | UIMessage['parts']
  role: CoreMessage['role']
  id: string
  metadata?: MessageMetadata
  chatId?: string
}

export interface Chat {
  id: string
  messages: ChatMessage[]
}

export interface WebScrapingResult {
  url: string
  content?: string
  screenshot?: string
  error?: string
}

// ==================== Schemas ====================

const attachmentSchema = z.object({
  id: z.string(),
  title: z.string().optional().nullable(),
  fileKey: z.string().optional(), // only for chat attachments
  type: z.enum(['url', 'txt', 'docx', 'pdf', 'image', 'manual', 'video']),
  variant: z.enum(['knowledge', 'chat']),
})

export type TAttachment = z.infer<typeof attachmentSchema>

const messageMetadataSchema = z.object({
  attachments: z.array(attachmentSchema).optional(),
})

export type Attachment = z.infer<typeof attachmentSchema>
export type MessageMetadata = z.infer<typeof messageMetadataSchema>

const chatMessageSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  metadata: messageMetadataSchema.optional(),
})

export type Metadata = {
  userMessage: string
  attachments: Array<TAttachment>
  tweets: PayloadTweet[]
}

export interface ChatHistoryItem {
  id: string
  title: string
  lastUpdated: string
}

export type MyUIMessage = UIMessage<
  Metadata,
  {
    'main-response': {
      text: string
      status: 'streaming' | 'complete'
    }
    'tool-output': {
      text: string
      index: number
      status: 'processing' | 'streaming' | 'complete'
    }
    writeTweet: {
      status: 'processing'
    }
  },
  {
    readWebsiteContent: {
      input: { website_url: string }
      output: {
        url: string
        title: string
        content: string
      }
    }
  }
>
// ==================== Route Handlers ====================

export const chatRouter = j.router({
  get_message_history: privateProcedure
    .input(z.object({ chatId: z.string().nullable() }))
    .get(async ({ c, input, ctx }) => {
      const { chatId } = input

      if (!chatId) {
        return c.superjson({ messages: [] })
      }

      const messages = await redis.get<MyUIMessage[]>(`chat:history:${chatId}`)

      if (!messages) {
        return c.superjson({ messages: [] })
      }

      return c.superjson({ messages })
    }),

  history: privateProcedure.query(async ({ c, ctx }) => {
    const { user } = ctx

    const historyKey = `chat:history-list:${user.email}`
    const chatHistory = (await redis.get<ChatHistoryItem[]>(historyKey)) || []

    return c.superjson({
      chatHistory: chatHistory.slice(0, 20),
    })
  }),

  chat: privateProcedure
    .input(
      z.object({
        message: z.any(),
        id: z.string(),
      }),
    )
    .post(async ({ c, ctx, input }) => {
      const { user } = ctx
      const { id, message } = input as { message: MyUIMessage; id: string }

      const limiter =
        user.plan === 'pro'
          ? new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(80, '4h') })
          : new Ratelimit({ redis, limiter: Ratelimit.fixedWindow(5, '1d') })

      const [account, history, parsedAttachments, limitResult] = await Promise.all([
        getAccount({ email: user.email }),
        redis.get<MyUIMessage[]>(`chat:history:${id}`),
        parseAttachments({
          attachments: message.metadata?.attachments,
        }),
        limiter.limit(user.email),
      ])

      if (process.env.NODE_ENV === 'production') {
        const { success } = limitResult

        if (!success) {
          if (user.plan === 'pro') {
            throw new HTTPException(429, {
              message: `You've reached your hourly message limit. Please try again in a few hours.`,
            })
          } else {
            throw new HTTPException(429, {
              message: 'Free plan limit reached, please upgrade to continue.',
            })
          }
        }
      }

      if (!account) {
        throw new HTTPException(412, { message: 'No connected account' })
      }

      const { links, attachments } = parsedAttachments

      const content = new XmlPrompt()
      const userContent = message.parts.reduce(
        (acc, curr) => (curr.type === 'text' ? acc + curr.text : ''),
        '',
      )

      content.open('message', { date: format(new Date(), 'EEEE, yyyy-MM-dd') })

      content.tag('user_message', userContent)

      if (Boolean(links.length)) {
        content.open('attached_links', { note: 'please read these links.' })
        links.filter(Boolean).forEach((l) => content.tag('link', l.link))
        content.close('attached_links')
      }

      if (message.metadata?.tweets) {
        if (message.metadata.tweets[0] && message.metadata.tweets.length === 1) {
          // single tweet
          content.tag('tweet_draft', message.metadata.tweets[0].content)
        } else if (message.metadata.tweets.length > 1) {
          content.open('thread_draft', { note: 'please read this thread.' })
          message.metadata.tweets.forEach((tweet) => {
            content.tag('tweet_draft', tweet.content, {
              index: tweet.index,
            })
          })
          content.close('thread_draft')
        }
      }

      content.close('message')

      const userMessage: MyUIMessage = {
        ...message,
        parts: [{ type: 'text', text: content.toString() }, ...attachments],
      }

      const messages = [...(history ?? []), userMessage] as MyUIMessage[]

      const stream = createUIMessageStream<MyUIMessage>({
        originalMessages: messages,
        generateId: createIdGenerator({
          prefix: 'msg',
          size: 16,
        }),
        onFinish: async ({ messages }) => {
          await redis.set(`chat:history:${id}`, messages)
          await redis.del(`website-contents:${id}`)

          const historyKey = `chat:history-list:${user.email}`
          const existingHistory = (await redis.get<ChatHistoryItem[]>(historyKey)) || []

          const title = messages[0]?.metadata?.userMessage ?? 'Unnamed chat'

          const chatHistoryItem: ChatHistoryItem = {
            id,
            title,
            lastUpdated: new Date().toISOString(),
          }

          const updatedHistory = [
            chatHistoryItem,
            ...existingHistory.filter((item) => item.id !== id),
          ]

          await redis.set(historyKey, updatedHistory)
        },
        onError(error) {
          console.log('❌❌❌ ERROR:', JSON.stringify(error, null, 2))

          throw new HTTPException(500, {
            message: error instanceof Error ? error.message : 'Something went wrong.',
          })
        },
        execute: async ({ writer }) => {
          const generationId = crypto.randomUUID()
          // tools
          const writeTweet = createTweetTool({
            writer,
            ctx: {
              plan: user.plan as 'free' | 'pro',
              tweets: message.metadata?.tweets ?? [],
              instructions: userContent,
              messages,
              userContent,
              attachments: { attachments, links },
              redisKeys: {
                thread: `thread:${id}:${generationId}`,
                style: `style:${user.email}:${account.id}`,
                account: `active-account:${user.email}`,
                websiteContent: `website-contents:${id}`,
              },
            },
          })

          const readWebsiteContent = create_read_website_content({ chatId: id })

          const result = streamText({
            model: openrouter.chat('openai/gpt-4.1', {
              models: ['openai/gpt-4o'],
              reasoning: { enabled: false, effort: 'low' },
            }),
            system: assistantPrompt({ tweets: message.metadata?.tweets ?? [] }),
            messages: convertToModelMessages(messages),
            tools: { writeTweet, readWebsiteContent },
            stopWhen: stepCountIs(3),
            experimental_transform: smoothStream({
              delayInMs: 20,
              chunking: /[^-]*---/,
            }),
          })

          writer.merge(result.toUIMessageStream())
        },
      })

      return createUIMessageStreamResponse({ stream })
    }),
  enhancePrompt: privateProcedure
    .input(z.object({ text: z.string() }))
    .mutation(async ({ ctx, c, input }) => {
      const { text } = input

      const enhanced = await streamText({
        model: openrouter.chat('meta-llama/llama-3.2-3b-instruct:free'),
        system: `You are an expert tweet prompt engineer for a Twitter web app. Your ONLY job is to rewrite user prompts to make them clearer, more specific, and optimized for generating high-quality tweets and threads.

CRITICAL: You must NEVER answer or fulfill the user's request. You must ONLY enhance their prompt for another AI. Just return the enhanced prompt. NEVER return anything else including inverted commas, qoutes, etc.

ENHANCEMENT RULES:
1.  ADD SPECIFICITY: Turn vague requests into specific instructions (e.g., specify the number of tweets, the topic, and the goal).
2.  ADD TWITTER CONTEXT: Include relevant details like tone (e.g., Professional, Casual, Witty), format (e.g., single tweet, thread, poll), and target audience.
3.  SPECIFY FORMAT: Make clear what type of response is expected (e.g., a 3-part thread, a tweet with a question).
4.  ADD CONSTRAINTS: Include character limits (under 280 characters per tweet), hashtag requirements (2-3 relevant hashtags), and calls-to-action where appropriate.
5.  PRESERVE INTENT: Keep the original request's purpose intact.

EDGE CASE RULES:
* IF THE PROMPT IS ALREADY GOOD: If the user's prompt is already specific and well-formed, simply return it with minor refinements if necessary.
* IF THE PROMPT IS TOO VAGUE: If the prompt is nonsensical or too vague to enhance (e.g., "hello", "fix this"), ask for more clarification.

EXAMPLES:
-   "write a tweet about marketing" → "Write a professional Twitter post under 280 characters about the importance of content marketing, using an engaging and informative tone. Include 2-3 relevant hashtags like #ContentMarketing and #DigitalMarketing."
-   "make a thread" → "Create a 3-part Twitter thread explaining the basics of prompt engineering for beginners. Each tweet should be under 280 characters and build on the last one. End the thread with a question to encourage engagement."
-   "imposter syndrome" → "Draft 2 tweets about overcoming imposter syndrome in the tech industry. The first tweet should be relatable and empathetic, and the second should offer a practical tip. Use a supportive and encouraging tone."

REMEMBER: Output ONLY the enhanced prompt—no explanations, no questions (unless the prompt is too vague), and no responses to their request.`,
        prompt: `Original prompt: "${text}"

`,
        temperature: 0.7,
      })

      let enhancedText = ''
      for await (const chunk of enhanced.textStream) {
        enhancedText += chunk
      }

      return c.superjson({
        enhancedText: enhancedText.trim(),
        success: true,
      })
    }),
})
