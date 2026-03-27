import crypto from 'crypto';

const ALLOWED_DOMAIN = 'manifestclimate.com';
const COOKIE_NAME = 'mc_session';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // 7 days in seconds

function signToken(payload, secret) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

export default async function handler(req, res) {
  const { code } = req.query;

  if (!code) {
    return res.redirect(302, '/?auth_error=no_code');
  }

  try {
    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: 'https://metrics-tracker-brown.vercel.app/api/auth/callback',
        grant_type: 'authorization_code',
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      console.error('Token exchange failed:', err);
      return res.redirect(302, '/?auth_error=token_failed');
    }

    const tokens = await tokenRes.json();

    // Get user info
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    if (!userRes.ok) {
      return res.redirect(302, '/?auth_error=userinfo_failed');
    }

    const user = await userRes.json();
    const email = (user.email || '').toLowerCase();
    const domain = email.split('@')[1] || '';

    // Check domain
    if (domain !== ALLOWED_DOMAIN) {
      return res.redirect(302, `/?auth_error=domain_denied&email=${encodeURIComponent(email)}`);
    }

    // Create signed session token
    const sessionPayload = {
      email: user.email,
      name: user.name,
      picture: user.picture,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE,
    };

    const token = signToken(sessionPayload, process.env.AUTH_SECRET);

    // Set secure HTTP-only cookie
    res.setHeader('Set-Cookie', [
      `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}`,
    ]);

    // Redirect to dashboard
    res.redirect(302, '/');
  } catch (err) {
    console.error('Auth callback error:', err);
    res.redirect(302, '/?auth_error=server_error');
  }
}
