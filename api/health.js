/**
 * GET /api/health — uptime/config check for monitoring.
 *
 * Mirrors the local dev server's /api/health, plus reports whether the
 * optional integrations are actually configured — useful for confirming a
 * deploy picked up its environment variables without exposing any secrets.
 */

'use strict';

const supabase = require('./_supabase');
const ghl = require('./_ghl');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  res.status(200).json({
    ok: true,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    supabase: supabase.isConfigured(),
    ghl: ghl.isConfigured()
  });
};
