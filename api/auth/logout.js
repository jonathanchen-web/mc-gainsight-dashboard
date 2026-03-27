const COOKIE_NAME = 'mc_session';

export default function handler(req, res) {
  // Clear the session cookie
  res.setHeader('Set-Cookie', [
    `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
  ]);
  res.redirect(302, '/');
}
