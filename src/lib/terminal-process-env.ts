export type TerminalProcessEnv = NodeJS.ProcessEnv;

export function buildTerminalProcessEnv(
  baseEnv: TerminalProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const {
    TURBOPACK: _turbopack,
    PORT: _port,
    NODE_ENV: _nodeEnv,
    AUTH0_DOMAIN: _auth0Domain,
    AUTH0_CLIENT_ID: _auth0ClientId,
    AUTH0_CLIENT_SECRET: _auth0ClientSecret,
    AUTH0_SECRET: _auth0Secret,
    COLORTERM: _colorTerm,
    FORCE_COLOR: _forceColor,
    CLICOLOR: _cliColor,
    CLICOLOR_FORCE: _cliColorForce,
    ...env
  } = baseEnv;

  return {
    ...env,
    TERM: 'xterm',
    NO_COLOR: '1',
    CLICOLOR: '0',
    CLICOLOR_FORCE: '0',
    FORCE_COLOR: '0',
  } as unknown as NodeJS.ProcessEnv;
}
