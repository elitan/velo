import { betterAuth } from 'better-auth';
import { tanstackStartCookies } from 'better-auth/tanstack-start';
import { getDb } from '../db/client';

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL,
  database: {
    db: getDb(),
    type: 'sqlite',
    casing: 'snake',
  },
  secret: process.env.BETTER_AUTH_SECRET || 'velo-dev-secret-change-me',
  emailAndPassword: {
    enabled: true,
  },
  plugins: [tanstackStartCookies()],
});
