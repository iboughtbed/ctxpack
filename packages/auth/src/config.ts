import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { apiKey } from "better-auth/plugins";

import { db } from "@repo/db";

export const AUTH_API_KEY_HEADERS = ["x-api-key"] as const;

export const auth = betterAuth({
  basePath: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, {
    provider: "pg",
    usePlural: true,
  }),
  socialProviders: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID as string,
      clientSecret: process.env.GITHUB_CLIENT_SECRET as string,
    },
  },
  advanced: {
    crossSubDomainCookies: {
      enabled: true,
    },
  },
  plugins: [
    apiKey({
      apiKeyHeaders: [...AUTH_API_KEY_HEADERS],
    }),
  ],
  experimental: {
    joins: true, // drizzle adapter joins
  },
});

export type Session = typeof auth.$Infer.Session;
