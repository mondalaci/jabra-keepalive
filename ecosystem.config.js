'use strict';

/**
 * PM2 loads the native addon (`volume.node`). It must be built with the **same** Node major
 * as `interpreter` below, or you get `ERR_DLOPEN_FAILED`.
 *
 * Example (nvm):
 *   export JABRA_PM2_INTERPRETER="$(which node)"
 *   npm run build && JABRA_PM2_INTERPRETER="$(which node)" pm2 start ecosystem.config.js
 */
module.exports = {
  apps: [
    {
      name: 'jabra-keepalive',
      cwd: __dirname,
      script: './index.js',
      interpreter: process.env.JABRA_PM2_INTERPRETER || 'node',
    },
  ],
};
