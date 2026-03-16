// src/middleware/api-key.js

/**
 * Creates Express middleware that validates API keys from env vars.
 * Checks X-API-Key header or Authorization: Bearer <key>.
 * Sets req.apiService to the service name (claude/openai/gemini).
 */
export function createApiKeyMiddleware() {
  return (req, res, next) => {
    // Extract key from header
    let key = req.headers['x-api-key'];
    if (!key) {
      const auth = req.headers.authorization;
      if (auth && auth.startsWith('Bearer ')) {
        key = auth.slice(7);
      }
    }

    if (!key) {
      return res.status(401).json({ error: 'Missing API key. Provide X-API-Key header or Authorization: Bearer <key>' });
    }

    // Match against configured keys
    const keyMap = {
      [process.env.KB_API_KEY_CLAUDE]: 'claude',
      [process.env.KB_API_KEY_OPENAI]: 'openai',
      [process.env.KB_API_KEY_GEMINI]: 'gemini',
    };

    const service = keyMap[key];
    if (!service) {
      return res.status(403).json({ error: 'Invalid API key' });
    }

    req.apiService = service;
    next();
  };
}
