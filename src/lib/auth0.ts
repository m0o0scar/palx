import { Auth0Client } from '@auth0/nextjs-auth0/server';

const REQUIRED_AUTH0_ENV_VARS = [
  'AUTH0_DOMAIN',
  'AUTH0_CLIENT_ID',
  'AUTH0_CLIENT_SECRET',
  'AUTH0_SECRET',
] as const;

export const missingAuth0EnvVars = REQUIRED_AUTH0_ENV_VARS.filter((name) => {
  const value = process.env[name];
  return typeof value !== 'string' || !value.trim();
});

export const isAuth0Configured = missingAuth0EnvVars.length === 0;

export const auth0 = isAuth0Configured ? new Auth0Client() : null;
