'use strict';

/**
 * Limitation de débit par clé (IP + route), stockée en base pour survivre aux
 * redémarrages et rester cohérente si plusieurs processus partagent la base.
 */

const db = require('../db');
const config = require('../config');

/**
 * @returns {{allowed:boolean, remaining:number, retryAfter:number}}
 */
function hit(key, { windowMs = config.security.rateLimit.windowMs, max = config.security.rateLimit.max } = {}) {
  const now = Date.now();
  try {
    const row = db.get('SELECT count, reset_at FROM rate_buckets WHERE key = ?', [key]);
    if (!row || row.reset_at <= now) {
      db.run(
        `INSERT INTO rate_buckets (key, count, reset_at) VALUES (?, 1, ?)
         ON CONFLICT(key) DO UPDATE SET count = 1, reset_at = excluded.reset_at`,
        [key, now + windowMs]
      );
      return { allowed: true, remaining: max - 1, retryAfter: 0 };
    }
    const next = row.count + 1;
    db.run('UPDATE rate_buckets SET count = ? WHERE key = ?', [next, key]);
    const retryAfter = Math.max(1, Math.ceil((row.reset_at - now) / 1000));
    if (next > max) return { allowed: false, remaining: 0, retryAfter };
    return { allowed: true, remaining: Math.max(0, max - next), retryAfter: 0 };
  } catch {
    // La limitation ne doit jamais rendre le site indisponible.
    return { allowed: true, remaining: max, retryAfter: 0 };
  }
}

function middleware({ windowMs, max, keyPrefix = 'rl', keyFn } = {}) {
  return (req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || 'inconnu';
    const scope = keyFn ? keyFn(req) : req.path;
    const result = hit(`${keyPrefix}:${scope}:${ip}`, { windowMs, max });
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));
    if (!result.allowed) {
      res.setHeader('Retry-After', String(result.retryAfter));
      return res.status(429).render('errors/429', {
        title: 'Trop de demandes',
        retryAfter: result.retryAfter,
      }, (err, html) => {
        if (err) {
          return res
            .status(429)
            .type('text/plain; charset=utf-8')
            .send(`Trop de demandes. Réessayez dans ${result.retryAfter} seconde(s).`);
        }
        res.send(html);
      });
    }
    return next();
  };
}

function purge() {
  try {
    db.run('DELETE FROM rate_buckets WHERE reset_at < ?', [Date.now() - 3_600_000]);
  } catch { /* noop */ }
}

module.exports = { hit, middleware, purge };
