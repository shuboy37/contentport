import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  serverExternalPackages: ['pdf-parse'],
  devIndicators: false,

  webpack: (config, { isServer }) => {
    // Handle CommonJS modules that cause issues in webpack
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      net: false,
      tls: false,
      crypto: false,
    }

    // Handle combined-stream and delayed-stream modules
    config.externals = config.externals || []
    if (isServer) {
      config.externals.push({
        'combined-stream': 'commonjs combined-stream',
        'delayed-stream': 'commonjs delayed-stream',
      })
    }

    return config
  },

  async rewrites() {
    return [
      {
        source: '/ingest/static/:path*',
        destination: 'https://eu-assets.i.posthog.com/static/:path*',
      },
      {
        source: '/ingest/:path*',
        destination: 'https://eu.i.posthog.com/:path*',
      },
      {
        source: '/ingest/decide',
        destination: 'https://eu.i.posthog.com/decide',
      },
    ]
  },

  // This is required to support PostHog trailing slash API requests
  skipTrailingSlashRedirect: true,
}

export default nextConfig
