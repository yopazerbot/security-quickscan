import pkg from '../package.json' with { type: 'json' };

/** Version of this build (apps/server/package.json); shown in /api/platform and written into exports. */
export const APP_VERSION: string = pkg.version;
