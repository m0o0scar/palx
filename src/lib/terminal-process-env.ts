export type TerminalProcessEnv = Record<string, string | undefined>;

export function buildTerminalProcessEnv(
  baseEnv: TerminalProcessEnv = process.env,
): TerminalProcessEnv {
  const {
    TURBOPACK: _turbopack,
    PORT: _port,
    NODE_ENV: _nodeEnv,
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
  };
}
