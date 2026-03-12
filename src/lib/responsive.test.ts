import test from 'node:test';
import assert from 'node:assert/strict';

import { SESSION_MOBILE_VIEWPORT_QUERY } from './responsive.ts';

test('SESSION_MOBILE_VIEWPORT_QUERY treats widths below 1024px as mobile', () => {
  assert.equal(SESSION_MOBILE_VIEWPORT_QUERY, '(max-width: 1023px)');
});
