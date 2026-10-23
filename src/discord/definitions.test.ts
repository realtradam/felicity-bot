import { describe, expect, it } from 'vitest';
import { commandDefinitions } from './definitions.js';

describe('slash command access', () => {
  it('clears member-permission restrictions rather than inheriting old admin defaults', () => {
    for (const name of ['emoji', 'history']) {
      const definition = commandDefinitions
        .find((command) => command.name === name)
        ?.toJSON();
      expect(definition?.default_member_permissions).toBeNull();
    }
  });
});
