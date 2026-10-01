import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config/index.js';
import { validEnv } from '../helpers.js';

describe('loadConfig', () => {
  it('parses a valid environment into a frozen structured config', () => {
    const config = loadConfig(validEnv);
    expect(config.db.user).toBe('hb_app');
    expect(config.http.port).toBe(4000);
    expect(config.http.corsOrigins).toEqual(['http://localhost:5173']);
    expect(config.demoMode).toBe(false);
    expect(Object.isFrozen(config.db)).toBe(true);
  });

  it('reports missing variables by name without echoing secret values', () => {
    const env = { ...validEnv, INTERNAL_SERVICE_SECRET: 'too-short-secret-value' };
    delete env.DB_APP_PASSWORD;
    let error;
    try {
      loadConfig(env);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain('DB_APP_PASSWORD');
    expect(error.message).toContain('INTERNAL_SERVICE_SECRET');
    expect(error.message).not.toContain('too-short-secret-value');
  });

  it('refuses demo mode in production', () => {
    expect(() => loadConfig({ ...validEnv, APP_ENV: 'production', DEMO_MODE: 'true' })).toThrow(
      /DEMO_MODE/,
    );
  });

  it('parses boolean strings strictly', () => {
    expect(loadConfig({ ...validEnv, DEMO_MODE: 'true' }).demoMode).toBe(true);
    expect(() => loadConfig({ ...validEnv, DEMO_MODE: 'maybe' })).toThrow(ConfigError);
  });
});
